import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = normalize(join(rootDir, ".."));

function loadLocalEnv() {
  const envPath = join(rootDir, ".env.local");
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf8");
  content.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const index = trimmed.indexOf("=");
    if (index < 0) return;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] == null) process.env[key] = value;
  });
}

loadLocalEnv();

const config = {
  port: Number(process.env.METRIC_WORKBENCH_PORT || process.env.PORT || 8767),
  apiUrl: process.env.MOI_TAAS_API_URL || "https://api-taas.moi.matrixorigin.cn/v1/chat/completions",
  apiKey: process.env.MOI_TAAS_API_KEY || process.env.TAAS_API_KEY || "",
  model: process.env.MOI_TAAS_MODEL || "qwen3-max",
  semanticEntriesTable: process.env.MOI_SEMANTIC_ENTRIES_TABLE || "moi.semantic_entries__poc_multi_kb_current_types",
  db: {
    host: process.env.MOI_DB_HOST || "",
    port: process.env.MOI_DB_PORT || "6001",
    user: process.env.MOI_DB_USER || "",
    password: process.env.MOI_DB_PASSWORD || "",
    database: process.env.MOI_DB_DATABASE || "jst_flat_table"
  }
};

const presentationDirectiveCache = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml; charset=utf-8"
};

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function sendSse(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  if (typeof res.flush === "function") res.flush();
}

function readBody(req, limit = 1_500_000) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  const withoutFence = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(withoutFence);
  } catch {}
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(withoutFence.slice(start, end + 1));
  }
  throw new Error("模型返回不是合法 JSON");
}

function semanticCatalog(payload) {
  return payload?.semantic_catalog && typeof payload.semantic_catalog === "object"
    ? payload.semantic_catalog
    : {};
}

function parseDataSourceTables(value) {
  if (Array.isArray(value)) return value.map(item => String(item || "").trim()).filter(Boolean);
  return String(value || "")
    .split(/[,\s、，]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

function catalogTables(payload) {
  const catalog = semanticCatalog(payload);
  const tables = new Set(parseDataSourceTables(payload?.data_source));
  if (Array.isArray(payload?.table_context)) {
    payload.table_context.forEach(entry => {
      if (entry?.table) tables.add(entry.table);
    });
  }
  Object.values(catalog).flat().forEach(entry => {
    if (entry?.source_table) tables.add(entry.source_table);
    if (Array.isArray(entry?.tables)) entry.tables.forEach(table => tables.add(table));
  });
  return [...tables].filter(Boolean);
}

function selectedPayloadTables(payload) {
  const selected = Array.isArray(payload?.qa_config?.selected_tables)
    ? payload.qa_config.selected_tables
    : [];
  const scoped = Array.isArray(payload?.qa_config?.table_scope?.tables)
    ? payload.qa_config.table_scope.tables
    : [];
  const tables = selected.length ? selected : scoped.length ? scoped : parseDataSourceTables(payload?.data_source);
  return [...new Set(tables.map(item => String(item || "").trim()).filter(Boolean))];
}

function stripSqlFences(sql) {
  return String(sql || "")
    .replace(/^```(?:sql)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function normalizeSql(sql) {
  const clean = stripSqlFences(sql).replace(/;\s*$/g, "").trim();
  return quoteNonAsciiAliases(normalizeQualifiedTableIdentifiers(clean));
}

function normalizeQualifiedTableIdentifiers(sql) {
  return String(sql || "")
    .replace(/\b(FROM|JOIN)\s+([`"])([A-Za-z_][\w$]*)\.([A-Za-z_][\w$]*)\2/gi, (_match, keyword, _quote, schema, table) => {
      return `${keyword} \`${schema}\`.\`${table}\``;
    })
    .replace(/\b(FROM|JOIN)\s+([A-Za-z_][\w$]*)\.([A-Za-z_][\w$]*)/gi, (_match, keyword, schema, table) => {
      return `${keyword} \`${schema}\`.\`${table}\``;
    })
    .replace(/\b(FROM|JOIN)\s+"([A-Za-z_][\w$]*)"\s*\.\s*"([A-Za-z_][\w$]*)"/gi, (_match, keyword, schema, table) => {
      return `${keyword} \`${schema}\`.\`${table}\``;
    })
    .replace(/\b(FROM|JOIN)\s+`([A-Za-z_][\w$]*)`\s*\.\s*`([A-Za-z_][\w$]*)`/gi, (_match, keyword, schema, table) => {
      return `${keyword} \`${schema}\`.\`${table}\``;
    });
}

function quoteNonAsciiAliases(sql) {
  return String(sql || "").replace(/\bAS\s+([\u4e00-\u9fa5][\u4e00-\u9fa5A-Za-z0-9_（）() -]*?)(?=\s+(?:FROM|WHERE|GROUP|ORDER|HAVING|LIMIT|UNION)\b|,|$)/gi, (_match, alias) => {
    const cleanAlias = String(alias).trim();
    if (/^`.*`$/.test(cleanAlias)) return `AS ${cleanAlias}`;
    return `AS \`${cleanAlias.replace(/`/g, "")}\``;
  });
}

function referencedTables(sql) {
  const ctes = new Set([...cteNames(sql)].map(name => String(name).toLowerCase()));
  const tables = [];
  const re = /\b(?:from|join)\s+((?:`[^`]+`|[a-zA-Z_][\w$]*)(?:\s*\.\s*(?:`[^`]+`|[a-zA-Z_][\w$]*))?)/gi;
  let match;
  while ((match = re.exec(sql))) {
    const raw = match[1].replace(/`/g, "").replace(/\s+/g, "");
    const table = raw.split(".").pop();
    if (!ctes.has(String(table).toLowerCase())) tables.push(table);
  }
  return [...new Set(tables)];
}

function cteNames(sql) {
  const text = String(sql || "")
    .replace(/^\s*--[^\n]*(?:\n|$)/gm, "")
    .replace(/^\s*\/\*[\s\S]*?\*\//, "")
    .trim();
  if (!/^\s*with\b/i.test(text)) return new Set();
  const names = new Set();
  const re = /(?:\bWITH\b|,)\s*(?:RECURSIVE\s+)?[`"]?([A-Za-z_][\w$]*)[`"]?\s+AS\s*\(/gi;
  let match;
  while ((match = re.exec(text))) {
    names.add(match[1]);
  }
  return names;
}

function validateReadOnlySql(sql, payload) {
  const clean = normalizeSql(sql);
  if (!clean) throw new Error("模型没有生成 SQL");
  if (!/^(select|with)\b/i.test(clean)) {
    throw new Error("SQL 必须是只读 SELECT 或 WITH 查询");
  }
  const withoutStrings = clean.replace(/'([^'\\]|\\.)*'/g, "''").replace(/"([^"\\]|\\.)*"/g, "\"\"");
  if (/;\s*\S/.test(withoutStrings)) {
    throw new Error("SQL 必须是单条语句");
  }
  const forbidden = /\b(insert|update|delete|drop|alter|create|truncate|replace|merge|grant|revoke|call|load|outfile|infile|set|use)\b/i;
  if (forbidden.test(withoutStrings)) {
    throw new Error("SQL 包含非只读或危险关键字");
  }
  const allowedTables = catalogTables(payload);
  const usedTables = referencedTables(clean);
  const unknown = usedTables.filter(table => !allowedTables.includes(table));
  if (unknown.length) {
    throw new Error(`SQL 引用了未授权表：${unknown.join(", ")}`);
  }
  return {
    sql: clean,
    allowedTables,
    usedTables
  };
}

function looksLikeExecutableSelectSql(sql) {
  const clean = normalizeSql(sql);
  return /^(select|with)\b/i.test(clean);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findTopLevelKeyword(sql, keywordPattern) {
  const text = String(sql || "");
  let quote = "";
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const prev = text[index - 1];
    if (quote) {
      if (char === quote && prev !== "\\") quote = "";
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) continue;
    const rest = text.slice(index);
    const match = rest.match(keywordPattern);
    if (match && match.index === 0) return index;
  }
  return -1;
}

function topLevelClausePosition(sql, patterns) {
  const positions = patterns
    .map(pattern => findTopLevelKeyword(sql, pattern))
    .filter(index => index >= 0);
  return positions.length ? Math.min(...positions) : -1;
}

function scanSqlDepthAt(sql, offset) {
  const text = String(sql || "");
  let quote = "";
  let depth = 0;
  for (let index = 0; index < Math.min(offset, text.length); index += 1) {
    const char = text[index];
    const prev = text[index - 1];
    if (quote) {
      if (char === quote && prev !== "\\") quote = "";
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
  }
  return depth;
}

function findKeywordAtDepth(sql, start, depth, keywordPattern) {
  const text = String(sql || "");
  let quote = "";
  let currentDepth = scanSqlDepthAt(text, start);
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    const prev = text[index - 1];
    if (quote) {
      if (char === quote && prev !== "\\") quote = "";
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") {
      currentDepth += 1;
      continue;
    }
    if (char === ")") {
      if (currentDepth === depth) return -1;
      currentDepth = Math.max(0, currentDepth - 1);
      continue;
    }
    if (currentDepth !== depth) continue;
    const rest = text.slice(index);
    const match = rest.match(keywordPattern);
    if (match && match.index === 0) return index;
  }
  return -1;
}

function findClauseBoundaryAtDepth(sql, start, depth) {
  const text = String(sql || "");
  let quote = "";
  let currentDepth = scanSqlDepthAt(text, start);
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    const prev = text[index - 1];
    if (quote) {
      if (char === quote && prev !== "\\") quote = "";
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") {
      currentDepth += 1;
      continue;
    }
    if (char === ")") {
      if (currentDepth === depth) return index;
      currentDepth = Math.max(0, currentDepth - 1);
      continue;
    }
    if (currentDepth !== depth) continue;
    const rest = text.slice(index);
    if (/^(GROUP\s+BY|HAVING|ORDER\s+BY|LIMIT|UNION)\b/i.test(rest)) return index;
  }
  return text.length;
}

function tableReferenceMatches(raw, targetTables = []) {
  const value = String(raw || "").replace(/`/g, "").replace(/\s+/g, "");
  const table = value.split(".").pop();
  return targetTables.includes(table);
}

function insertConditionsIntoFirstTargetTableQuery(sql, conditions, targetTables = []) {
  if (!conditions.length || !targetTables.length) return null;
  const text = String(sql || "");
  const re = /\bFROM\s+((?:`[^`]+`|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:`[^`]+`|[A-Za-z_][\w$]*))?)/gi;
  let match;
  while ((match = re.exec(text))) {
    if (!tableReferenceMatches(match[1], targetTables)) continue;
    const afterFrom = re.lastIndex;
    const depth = scanSqlDepthAt(text, afterFrom);
    const boundary = findClauseBoundaryAtDepth(text, afterFrom, depth);
    if (boundary < 0) continue;
    const whereAt = findKeywordAtDepth(text, afterFrom, depth, /\bWHERE\b/i);
    const filterText = conditions.map(item => item.sql).join("\n  AND ");
    const insertion = whereAt >= 0 && whereAt < boundary
      ? `\n  AND ${filterText}`
      : `\nWHERE ${filterText}`;
    return {
      sql: `${text.slice(0, boundary).trimEnd()}${insertion}\n${text.slice(boundary).trimStart()}`,
      applied: conditions
    };
  }
  return null;
}

function fieldReferencePattern(field) {
  const escaped = escapeRegExp(field);
  return `(?:(?:\\\`?[A-Za-z_][\\w$]*\\\`?)\\s*\\.\\s*)?\\\`?${escaped}\\\`?`;
}

function replaceFieldEquality(sql, field, value) {
  const pattern = new RegExp(`(${fieldReferencePattern(field)})\\s*=\\s*'[^']*'`, "ig");
  return String(sql || "").replace(pattern, `$1 = '${String(value).replace(/'/g, "''")}'`);
}

function hasFieldEqualityValue(sql, field, value) {
  const pattern = new RegExp(`${fieldReferencePattern(field)}\\s*=\\s*'([^']*)'`, "ig");
  let match;
  while ((match = pattern.exec(String(sql || "")))) {
    if (String(match[1]) === String(value)) return true;
  }
  return false;
}

function hasFieldReference(sql, field) {
  return new RegExp(fieldReferencePattern(field), "i").test(String(sql || ""));
}

function appendWhereConditions(sql, conditions, options = {}) {
  const clean = normalizeSql(sql);
  const additions = [];
  let nextSql = clean;
  const applied = [];
  const replaced = [];
  const skipped = [];

  conditions.forEach(condition => {
    if (!condition?.sql) return;
    if (condition.field && condition.value != null) {
      if (hasFieldEqualityValue(nextSql, condition.field, condition.value)) {
        skipped.push({ ...condition, reason: "SQL 中已存在相同过滤" });
        return;
      }
      if (hasFieldReference(nextSql, condition.field)) {
        nextSql = replaceFieldEquality(nextSql, condition.field, condition.value);
        replaced.push(condition);
        return;
      }
    } else if (condition.field && hasFieldReference(nextSql, condition.field)) {
      skipped.push({ ...condition, reason: "SQL 中已存在该字段过滤" });
      return;
    } else if (nextSql.includes(condition.sql)) {
      skipped.push({ ...condition, reason: "SQL 中已存在相同过滤" });
      return;
    }
    additions.push(condition);
  });

  if (!additions.length) {
    return { sql: nextSql, applied, replaced, skipped };
  }

  const targetTables = (options.targetTables || []).map(table => splitQualifiedTableName(table).table);
  const targetInjection = insertConditionsIntoFirstTargetTableQuery(nextSql, additions, targetTables);
  if (targetInjection) {
    applied.push(...targetInjection.applied);
    return { sql: targetInjection.sql, applied, replaced, skipped };
  }

  const insertAt = topLevelClausePosition(nextSql, [
    /\bGROUP\s+BY\b/i,
    /\bHAVING\b/i,
    /\bORDER\s+BY\b/i,
    /\bLIMIT\b/i
  ]);
  const before = insertAt >= 0 ? nextSql.slice(0, insertAt).trimEnd() : nextSql.trimEnd();
  const after = insertAt >= 0 ? `\n${nextSql.slice(insertAt).trimStart()}` : "";
  const whereAt = findTopLevelKeyword(before, /\bWHERE\b/i);
  const filterText = additions.map(item => item.sql).join("\n  AND ");
  nextSql = whereAt >= 0
    ? `${before}\n  AND ${filterText}${after}`
    : `${before}\nWHERE ${filterText}${after}`;
  applied.push(...additions);
  return { sql: nextSql, applied, replaced, skipped };
}

function sqlWithSafetyLimit(sql) {
  const clean = normalizeSql(sql);
  if (/\blimit\s+\d+/i.test(clean)) return clean;
  return `${clean}\nLIMIT 500`;
}

function dbConfigured() {
  return Boolean(config.db.host && config.db.user && config.db.password && config.db.database);
}

function parseMysqlTsv(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n").filter(line => line.length);
  if (!lines.length) return { columns: [], rows: [] };
  const columns = lines[0].split("\t");
  const rows = [];
  let buffer = "";
  lines.slice(1).forEach(line => {
    buffer = buffer ? `${buffer}\n${line}` : line;
    if (buffer.split("\t").length < columns.length) return;
    const values = buffer.split("\t");
    rows.push(Object.fromEntries(columns.map((column, index) => [column, values[index] ?? ""])));
    buffer = "";
  });
  if (buffer) {
    const values = buffer.split("\t");
    rows.push(Object.fromEntries(columns.map((column, index) => [column, values[index] ?? ""])));
  }
  return { columns, rows };
}

function executeSql(sql) {
  if (!dbConfigured()) {
    return Promise.resolve({
      executed: false,
      columns: [],
      rows: [],
      row_count: 0,
      message: "未配置数据库连接，已跳过执行。"
    });
  }
  const args = [
    "-h", config.db.host,
    "-P", String(config.db.port || "6001"),
    "-u", config.db.user,
    "--database", config.db.database,
    "--batch",
    "--raw",
    "--default-character-set=utf8mb4"
  ];
  return new Promise((resolve, reject) => {
    const child = spawn("mysql", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, MYSQL_PWD: config.db.password }
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("SQL 执行超时"));
    }, 45_000);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error((stderr || `mysql 退出码 ${code}`).slice(0, 1000)));
        return;
      }
      const parsed = parseMysqlTsv(stdout);
      resolve({
        executed: true,
        ...parsed,
        row_count: parsed.rows.length,
        message: stderr.trim()
      });
    });
    child.stdin.end(`${sqlWithSafetyLimit(sql)};\n`);
  });
}

function executeRawSql(sql, timeoutMs = 45_000) {
  if (!dbConfigured()) {
    return Promise.resolve({
      executed: false,
      columns: [],
      rows: [],
      row_count: 0,
      message: "未配置数据库连接，已跳过执行。"
    });
  }
  const args = [
    "-h", config.db.host,
    "-P", String(config.db.port || "6001"),
    "-u", config.db.user,
    "--database", config.db.database,
    "--batch",
    "--raw",
    "--default-character-set=utf8mb4"
  ];
  return new Promise((resolve, reject) => {
    const child = spawn("mysql", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, MYSQL_PWD: config.db.password }
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("SQL 执行超时"));
    }, timeoutMs);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error((stderr || `mysql 退出码 ${code}`).slice(0, 1000)));
        return;
      }
      const parsed = parseMysqlTsv(stdout);
      resolve({
        executed: true,
        ...parsed,
        row_count: parsed.rows.length,
        message: stderr.trim()
      });
    });
    child.stdin.end(`${String(sql || "").trim().replace(/;\s*$/g, "")};\n`);
  });
}

function safeQualifiedTableName(name) {
  const value = String(name || "").trim();
  if (!/^[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?$/.test(value)) {
    throw new Error(`非法表名：${value}`);
  }
  return value;
}

function splitQualifiedTableName(name) {
  const value = safeQualifiedTableName(name);
  const parts = value.split(".");
  if (parts.length === 2) return { schema: parts[0], table: parts[1] };
  return { schema: config.db.database, table: parts[0] };
}

function quotedTableName(name) {
  const { schema, table } = splitQualifiedTableName(name);
  return `\`${schema}\`.\`${table}\``;
}

function shortenCell(value, max = 80) {
  if (value == null) return "";
  const text = String(value);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function compactSampleRows(rows, maxColumns = 40) {
  return (rows || []).slice(0, 5).map(row => {
    const entries = Object.entries(row).slice(0, maxColumns);
    return Object.fromEntries(entries.map(([key, value]) => [key, shortenCell(value)]));
  });
}

function compactColumnProfiles(columns, sampleRows) {
  const rows = Array.isArray(sampleRows) ? sampleRows : [];
  return columns.map(column => {
    const sample_values = [...new Set(rows
      .map(row => row[column.name])
      .filter(value => value != null && String(value) !== "")
      .map(value => shortenCell(value, 40))
    )].slice(0, 3);
    return {
      name: column.name,
      type: column.type,
      comment: column.comment || "",
      sample_values
    };
  });
}

async function loadTableProfile(tableName) {
  const { schema, table } = splitQualifiedTableName(tableName);
  const columnsResult = await executeSql(`
SELECT
  COLUMN_NAME AS name,
  COLUMN_TYPE AS type,
  COLUMN_COMMENT AS comment,
  ORDINAL_POSITION AS ordinal_position
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = ${sqlLiteral(schema)}
  AND TABLE_NAME = ${sqlLiteral(table)}
ORDER BY ORDINAL_POSITION
LIMIT 300`);
  const sampleResult = await executeSql(`SELECT * FROM ${quotedTableName(tableName)} LIMIT 5`);
  const columns = columnsResult.rows.map(row => ({
    name: row.name,
    type: row.type || "",
    comment: row.comment || ""
  }));
  const sampleRows = compactSampleRows(sampleResult.rows || []);
  return {
    table,
    qualified_table: `${schema}.${table}`,
    columns: compactColumnProfiles(columns, sampleResult.rows || []),
    sample_rows: sampleRows,
    sample_row_count: sampleRows.length
  };
}

async function loadTableContext(payload) {
  const preferredTables = selectedPayloadTables(payload);
  const tables = (preferredTables.length ? preferredTables : catalogTables(payload)).slice(0, 12);
  return Promise.all(tables.map(async table => {
    try {
      return await loadTableProfile(table);
    } catch (error) {
      return {
        table: table.split(".").pop(),
        qualified_table: table,
        columns: [],
        sample_rows: [],
        sample_row_count: 0,
        error: error.message || String(error)
      };
    }
  }));
}

function generatedTextEqualityCandidates(sql, payload) {
  const question = normalizeCandidateText(payload?.question || "");
  if (!question) return [];
  const tableProfiles = Array.isArray(payload?.table_context) ? payload.table_context : [];
  const usedTables = new Set(referencedTables(sql).map(table => String(table).toLowerCase()));
  const columnProfiles = new Map();
  tableProfiles.forEach(table => {
    const tableName = String(table?.table || "").toLowerCase();
    if (usedTables.size && !usedTables.has(tableName)) return;
    (table?.columns || []).forEach(column => {
      const field = String(column?.name || "");
      if (!field) return;
      const type = String(column?.type || "");
      const semanticText = `${field} ${column?.comment || ""}`;
      if (!/(char|text|string|clob)/i.test(type)) return;
      if (!/(名称|描述|公司|客户|供应商|项目|主体|股东|控股|控制方|抬头|标题|name|description|company|customer|supplier|vendor|project|title)/i.test(semanticText)) return;
      const key = field.toLowerCase();
      if (!columnProfiles.has(key)) columnProfiles.set(key, []);
      columnProfiles.get(key).push({ table, column });
    });
  });

  const candidates = [];
  const comparison = /((?:(?:`[^`]+`|[A-Za-z_][\w$]*)\s*\.\s*)?(?:`([^`]+)`|([A-Za-z_][\w$]*)))\s*=\s*'((?:''|[^'])*)'/g;
  let match;
  while ((match = comparison.exec(String(sql || "")))) {
    const lhs = match[1];
    const field = String(match[2] || match[3] || "");
    const value = String(match[4] || "").replace(/''/g, "'").trim();
    const normalizedValue = normalizeCandidateText(value);
    const profiles = columnProfiles.get(field.toLowerCase()) || [];
    if (!profiles.length || normalizedValue.length < 2 || !question.includes(normalizedValue)) continue;
    candidates.push({
      condition: match[0],
      lhs,
      field,
      value,
      profiles
    });
  }
  return candidates;
}

async function lookupGeneratedTextEntity(candidate, cache = new Map()) {
  const profile = candidate.profiles[0];
  const tableName = profile?.table?.qualified_table || profile?.table?.table || "";
  if (!tableName) return null;
  const cacheKey = `${tableName}|${candidate.field}|${candidate.value}`;
  if (!cache.has(cacheKey)) {
    cache.set(cacheKey, (async () => {
      const field = sqlIdentifier(candidate.field);
      const value = sqlLiteral(candidate.value);
      const execution = await executeSql([
        `SELECT ${field} AS ${sqlIdentifier("candidate_value")}, COUNT(*) AS ${sqlIdentifier("match_count")}`,
        `FROM ${quotedTableName(tableName)}`,
        `WHERE ${field} = ${value} OR LOCATE(${value}, ${field}) > 0`,
        `GROUP BY ${field}`,
        `ORDER BY CASE WHEN ${field} = ${value} THEN 0 ELSE 1 END, COUNT(*) DESC`,
        "LIMIT 20"
      ].join("\n"));
      const values = (execution.rows || [])
        .map(row => String(row.candidate_value ?? "").trim())
        .filter(Boolean);
      const exact = values.find(item => item === candidate.value) || "";
      return { table: tableName, values, exact };
    })());
  }
  return cache.get(cacheKey);
}

async function resolveGeneratedTextEntities(sql, payload, cache = new Map()) {
  const candidates = generatedTextEqualityCandidates(sql, payload);
  if (!candidates.length) return { sql, resolutions: [] };
  let resolvedSql = String(sql || "");
  const resolutions = [];
  for (const candidate of candidates) {
    let lookup;
    try {
      lookup = await lookupGeneratedTextEntity(candidate, cache);
    } catch {
      continue;
    }
    if (!lookup?.values?.length || lookup.exact) continue;
    const replacement = lookup.values.length === 1
      ? `${candidate.lhs} = ${sqlLiteral(lookup.values[0])}`
      : `LOCATE(${sqlLiteral(candidate.value)}, ${candidate.lhs}) > 0`;
    resolvedSql = resolvedSql.split(candidate.condition).join(replacement);
    resolutions.push({
      field: candidate.field,
      input_value: candidate.value,
      matched_values: lookup.values,
      match_mode: lookup.values.length === 1 ? "resolved_exact_value" : "contains",
      applied_sql: replacement,
      source_table: lookup.table
    });
  }
  return { sql: resolvedSql, resolutions };
}

function parseJsonValue(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function tableNamesFromModelTables(tables) {
  const items = Array.isArray(tables) ? tables : [];
  const names = [];
  items.forEach(item => {
    if (Array.isArray(item?.table_names)) names.push(...item.table_names);
  });
  return [...new Set(names.filter(Boolean))];
}

function relatedTablesFromEntryTables(tables) {
  const parsed = Array.isArray(tables) ? tables : [];
  return parsed.map(item => {
    if (typeof item === "string") return item;
    return item?.table_name || item?.name || "";
  }).filter(Boolean);
}

async function loadSemanticWorkbenchData() {
  if (!dbConfigured()) {
    throw new Error("未配置数据库连接，无法读取语义库");
  }
  const entriesTable = safeQualifiedTableName(config.semanticEntriesTable);
  const modelsSql = `
SELECT
  id,
  name,
  description,
  CAST(tables AS CHAR) AS tables,
  updated_at
FROM moi.semantic_models
WHERE id IN (SELECT DISTINCT model_id FROM ${entriesTable})
ORDER BY id
LIMIT 1000`;
  const entriesSql = `
SELECT
  id,
  model_id,
  kind,
  key_name,
  CAST(tables AS CHAR) AS tables,
  CAST(spec AS CHAR) AS spec,
  updated_at
FROM ${entriesTable}
ORDER BY model_id, kind, key_name
LIMIT 10000`;
  const [modelsResult, entriesResult] = await Promise.all([
    executeSql(modelsSql),
    executeSql(entriesSql)
  ]);
  const models = modelsResult.rows.map(row => {
    const tables = parseJsonValue(row.tables, []);
    return {
      id: Number(row.id),
      name: row.name,
      description: row.description || "",
      tables,
      table_names: tableNamesFromModelTables(tables),
      updated_at: row.updated_at || ""
    };
  });
  const entries = entriesResult.rows.map(row => {
    const tables = parseJsonValue(row.tables, []);
    return {
      id: Number(row.id),
      model_id: Number(row.model_id),
      kind: row.kind,
      key_name: row.key_name,
      tables,
      table_names: relatedTablesFromEntryTables(tables),
      spec: parseJsonValue(row.spec, {}),
      updated_at: row.updated_at || ""
    };
  });
  return {
    source_table: entriesTable,
    models,
    entries
  };
}

function sqlLiteral(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

function sqlUtf8String(value) {
  const hex = Buffer.from(String(value ?? ""), "utf8").toString("hex");
  return `CONVERT(UNHEX('${hex}') USING utf8mb4)`;
}

function jsonSql(value) {
  return sqlUtf8String(JSON.stringify(value ?? null));
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function normalizeSemanticTables(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => String(item || "").trim()).filter(Boolean))];
}

function normalizeSemanticSavePayload(payload) {
  const allowedKinds = new Set([
    "business_metric",
    "logic_text",
    "result_presentation",
    "sql_resultset",
    "standard_qa",
    "table_column_note"
  ]);
  const id = positiveInteger(payload?.id);
  const modelId = positiveInteger(payload?.model_id);
  const kind = String(payload?.kind || "").trim();
  const keyName = String(payload?.key_name || "").trim();
  if (!modelId) throw new Error("缺少有效的知识库 model_id");
  if (!allowedKinds.has(kind)) throw new Error(`不支持的语义类型：${kind || "空"}`);
  if (!keyName) throw new Error("Key 不能为空");
  if (keyName.length > 128) throw new Error("Key 不能超过 128 个字符");
  const spec = payload?.spec && typeof payload.spec === "object" && !Array.isArray(payload.spec)
    ? payload.spec
    : {};
  return {
    id,
    modelId,
    kind,
    keyName,
    tables: normalizeSemanticTables(payload?.tables),
    spec
  };
}

async function fetchSemanticEntry(id) {
  const entriesTable = safeQualifiedTableName(config.semanticEntriesTable);
  const result = await executeSql(`
SELECT
  id,
  model_id,
  kind,
  key_name,
  CAST(tables AS CHAR) AS tables,
  CAST(spec AS CHAR) AS spec,
  updated_at
FROM ${entriesTable}
WHERE id = ${positiveInteger(id) || 0}
LIMIT 1`);
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    model_id: Number(row.model_id),
    kind: row.kind,
    key_name: row.key_name,
    tables: parseJsonValue(row.tables, []),
    table_names: relatedTablesFromEntryTables(parseJsonValue(row.tables, [])),
    spec: parseJsonValue(row.spec, {}),
    updated_at: row.updated_at || ""
  };
}

async function saveSemanticEntry(payload) {
  const entriesTable = safeQualifiedTableName(config.semanticEntriesTable);
  const item = normalizeSemanticSavePayload(payload);
  const actor = "metric-workbench";
  if (item.id) {
    await executeRawSql(`
UPDATE ${entriesTable}
SET
  model_id = ${item.modelId},
  kind = ${sqlLiteral(item.kind)},
  key_name = ${sqlLiteral(item.keyName)},
  tables = ${jsonSql(item.tables)},
  spec = ${jsonSql(item.spec)},
  updated_by = ${sqlLiteral(actor)},
  updated_at = CURRENT_TIMESTAMP()
WHERE id = ${item.id}`);
    const updated = await fetchSemanticEntry(item.id);
    if (!updated) throw new Error(`保存失败：未找到 id=${item.id} 的语义条目`);
    return updated;
  }

  await executeRawSql(`
INSERT INTO ${entriesTable}
  (model_id, kind, key_name, tables, spec, created_by, updated_by)
VALUES
  (${item.modelId}, ${sqlLiteral(item.kind)}, ${sqlLiteral(item.keyName)}, ${jsonSql(item.tables)}, ${jsonSql(item.spec)}, ${sqlLiteral(actor)}, ${sqlLiteral(actor)})`);
  const result = await executeSql(`
SELECT id
FROM ${entriesTable}
WHERE model_id = ${item.modelId}
  AND kind = ${sqlLiteral(item.kind)}
  AND key_name = ${sqlLiteral(item.keyName)}
ORDER BY id DESC
LIMIT 1`);
  const id = Number(result.rows[0]?.id);
  if (!id) throw new Error("新增成功但未能回读新条目 id");
  return fetchSemanticEntry(id);
}

async function deleteSemanticEntry(payload) {
  const entriesTable = safeQualifiedTableName(config.semanticEntriesTable);
  const id = positiveInteger(payload?.id);
  if (!id) throw new Error("删除需要有效的语义条目 id");
  await executeRawSql(`DELETE FROM ${entriesTable} WHERE id = ${id}`);
  return { id };
}

function expandLookupTerm(term) {
  const raw = String(term || "").trim();
  if (!raw) return [];
  const cleaned = normalizeLookupTerm(raw);
  const variants = [raw, cleaned]
    .map(item => normalizeLookupTerm(item))
    .filter(Boolean);
  return [...new Set(variants)];
}

function normalizeLookupTerm(term) {
  return String(term || "")
    .replace(/20\d{2}\s*年\s*(?:1[0-2]|0?[1-9])?\s*月?/g, "")
    .replace(/20\d{2}\.\d{1,2}\s*月?/g, "")
    .replace(/^\s*(请|帮我|给我|查询|查看|调取|请调取|提供|列出|输出|显示|看一下|查一下)+/g, "")
    .replace(/^(的|在|按|以|将|把)+/g, "")
    .replace(/(的)?(发生|产生|对应|相关)?(费用)?(清单|明细|列表|数据|情况|金额|余额|数值)$/g, "")
    .replace(/科目$/g, "")
    .replace(/(是什么|是多少)$/g, "")
    .replace(/^的+|的+$/g, "")
    .trim();
}

function sqlIdentifier(name) {
  return `\`${String(name || "").replace(/`/g, "``")}\``;
}

function resultsetLookupColumns(columns) {
  const list = (columns || []).map(String).filter(Boolean);
  const codePatterns = [
    /科目.*(编码|代码|编号|号)/i,
    /(编码|代码|编号)$/i,
    /^(account_)?(code|no|number)$/i,
    /^racct$/i,
    /^saknr$/i,
    /^hkont$/i,
    /^account_code$/i,
    /^account_no$/i
  ];
  const namePatterns = [
    /科目.*(名称|描述|文本)/i,
    /(名称|描述|文本)$/i,
    /^(account_)?name$/i,
    /^txt(20|30|lg)?$/i,
    /^txt\d+$/i,
    /^text$/i,
    /^description$/i,
    /^maktx$/i
  ];
  const codeColumns = list.filter(column => codePatterns.some(pattern => pattern.test(column)));
  const nameColumns = list.filter(column => namePatterns.some(pattern => pattern.test(column)));
  const fallbackTextColumns = list.filter(column => /name|txt|text|desc|描述|名称|科目|code|编码|编号|racct|saknr|hkont/i.test(column));
  return {
    codeColumns: codeColumns.length ? codeColumns : fallbackTextColumns.filter(column => /code|编码|编号|racct|saknr|hkont/i.test(column)),
    nameColumns: nameColumns.length ? nameColumns : fallbackTextColumns.filter(column => !/code|编码|编号|racct|saknr|hkont/i.test(column)),
    searchableColumns: [...new Set([...codeColumns, ...nameColumns, ...fallbackTextColumns])]
  };
}

function buildAccountResultsetLookupSql(entry, terms, columns = []) {
  const baseSql = sqlWithoutTopLevelLimit(entry.sql);
  const exactValues = terms.map(sqlLiteral).join(", ");
  const { codeColumns, nameColumns, searchableColumns } = resultsetLookupColumns(columns);
  if (!searchableColumns.length) {
    return {
      sql: "",
      searchable_columns: [],
      code_columns: [],
      name_columns: [],
      mode: "no_searchable_columns"
    };
  }
  const conditions = terms.map(term => {
    const exact = sqlLiteral(term);
    const like = sqlLiteral(`%${term}%`);
    const nameChecks = nameColumns.flatMap(column => [
      `rs.${sqlIdentifier(column)} = ${exact}`,
      `rs.${sqlIdentifier(column)} LIKE ${like}`
    ]);
    const codeChecks = codeColumns.flatMap(column => [
      `rs.${sqlIdentifier(column)} = ${exact}`,
      `rs.${sqlIdentifier(column)} LIKE ${like}`
    ]);
    const fallbackChecks = !nameChecks.length && !codeChecks.length
      ? searchableColumns.map(column => `rs.${sqlIdentifier(column)} LIKE ${like}`)
      : [];
    return `(${[...nameChecks, ...codeChecks, ...fallbackChecks].join(" OR ")})`;
  }).join(" OR ");
  const exactOrderChecks = [...new Set([...nameColumns, ...codeColumns])]
    .map(column => `rs.${sqlIdentifier(column)} IN (${exactValues})`);
  const orderBy = exactOrderChecks.length
    ? `ORDER BY CASE WHEN ${exactOrderChecks.join(" OR ")} THEN 0 ELSE 1 END, ${sqlIdentifier([...nameColumns, ...codeColumns, ...searchableColumns][0])}`
    : `ORDER BY ${sqlIdentifier(searchableColumns[0])}`;
  return {
    sql: [
      "SELECT *",
      `FROM (${baseSql}) rs`,
      `WHERE ${conditions}`,
      orderBy,
      "LIMIT 30"
    ].join("\n"),
    searchable_columns: searchableColumns,
    code_columns: codeColumns,
    name_columns: nameColumns,
    mode: "filtered"
  };
}

const RESULTSET_SCAN_LIMIT = 5000;
const RESULTSET_FULL_CONTEXT_LIMIT = 200;

function buildResultsetScanSql(entry, limit = RESULTSET_SCAN_LIMIT) {
  const baseSql = sqlWithoutTopLevelLimit(entry.sql);
  return [
    "SELECT *",
    `FROM (${baseSql}) rs`,
    `LIMIT ${limit}`
  ].join("\n");
}

function normalizeCandidateText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，,。.;；:：、"'`“”‘’（）()【】\[\]{}<>《》!?？]/g, "")
    .trim();
}

function charBigrams(value) {
  const text = normalizeCandidateText(value);
  if (text.length <= 1) return text ? [text] : [];
  const grams = [];
  for (let index = 0; index < text.length - 1; index += 1) {
    grams.push(text.slice(index, index + 2));
  }
  return grams;
}

function ngramSimilarity(a, b) {
  const aGrams = charBigrams(a);
  const bSet = new Set(charBigrams(b));
  if (!aGrams.length || !bSet.size) return 0;
  const hit = aGrams.filter(gram => bSet.has(gram)).length;
  return hit / aGrams.length;
}

function orderedCharSimilarity(term, target) {
  const query = normalizeCandidateText(term);
  const text = normalizeCandidateText(target);
  if (!query || !text) return 0;
  let cursor = 0;
  let hit = 0;
  for (const char of query) {
    const foundAt = text.indexOf(char, cursor);
    if (foundAt >= 0) {
      hit += 1;
      cursor = foundAt + 1;
    }
  }
  return hit / query.length;
}

function scoreCandidateValue(term, value) {
  const query = normalizeCandidateText(term);
  const text = normalizeCandidateText(value);
  if (!query || !text) return 0;
  if (query === text) return 1;
  if (text.includes(query)) return Math.min(0.96, 0.82 + query.length / Math.max(text.length, 1) * 0.12);
  if (query.includes(text) && text.length >= 3) return 0.7;
  const ngram = ngramSimilarity(query, text);
  const ordered = orderedCharSimilarity(query, text);
  return Math.max(ngram * 0.82, ordered * 0.62);
}

function scoreResultsetRow(row, terms, columns) {
  const codeColumns = columns.codeColumns || [];
  const nameColumns = columns.nameColumns || [];
  const searchableColumns = columns.searchableColumns || [];
  let best = { score: 0, term: "", column: "", value: "" };
  for (const term of terms || []) {
    const termVariants = expandLookupTerm(term);
    for (const variant of termVariants) {
      for (const column of [...nameColumns, ...codeColumns, ...searchableColumns]) {
        const value = row?.[column];
        const score = scoreCandidateValue(variant, value);
        if (score > best.score) {
          best = { score, term: variant, column, value: String(value ?? "") };
        }
      }
    }
  }
  return best;
}

function filterResultsetCandidates(rows, terms, columns, limit = 30) {
  const scored = (rows || []).map(row => {
    const match = scoreResultsetRow(row, terms, columns);
    return { row, match };
  });
  return scored
    .filter(item => item.match.score >= 0.42)
    .sort((a, b) => b.match.score - a.match.score)
    .slice(0, limit)
    .map(item => ({
      ...item.row,
      _match_score: Number(item.match.score.toFixed(3)),
      _matched_term: item.match.term,
      _matched_column: item.match.column,
      _matched_value: item.match.value
    }));
}

function sqlWithoutTopLevelLimit(sql) {
  const clean = normalizeSql(sql);
  const limitAt = findTopLevelKeyword(clean, /\bLIMIT\b/i);
  return limitAt >= 0 ? clean.slice(0, limitAt).trimEnd() : clean;
}

async function inspectResultsetColumns(entry) {
  const baseSql = sqlWithoutTopLevelLimit(entry.sql);
  const probe = await executeSql([
    "SELECT *",
    `FROM (${baseSql}) rs`,
    "LIMIT 1"
  ].join("\n"));
  return (probe.columns && probe.columns.length) ? probe.columns : parseSqlSelectAliases(entry.sql);
}

function parseSqlSelectAliases(sql) {
  const text = String(sql || "");
  const backtickAliases = [...text.matchAll(/\bAS\s+`([^`]+)`/gi)].map(match => match[1].trim());
  const quotedAliases = [...text.matchAll(/\bAS\s+["']([^"']+)["']/gi)].map(match => match[1].trim());
  const plainAliases = [...text.matchAll(/\bAS\s+([A-Za-z_][\w$]*|[\u4e00-\u9fa5][\u4e00-\u9fa5A-Za-z0-9_（）() -]*)(?=\s*(?:,|\bFROM\b|$))/gi)]
    .map(match => match[1].trim());
  return [...new Set([...backtickAliases, ...quotedAliases, ...plainAliases])].filter(Boolean);
}

function rowValueByColumns(row, columns) {
  for (const column of columns || []) {
    const value = row?.[column];
    if (value != null && String(value).trim()) return value;
  }
  return "";
}

async function resolveSqlResultsets(payload, plan = null) {
  const catalog = semanticCatalog(payload);
  const entries = Array.isArray(catalog.sql_resultset) ? catalog.sql_resultset : [];
  const plannedTerms = Array.isArray(plan?.sql_resultset_lookups)
    ? plan.sql_resultset_lookups.flatMap(item => item?.terms || [])
    : [];
  const terms = [...new Set(plannedTerms.map(term => String(term || "").trim()).filter(term => term.length >= 2))];
  const expandedTerms = [...new Set(terms.flatMap(expandLookupTerm).filter(term => term.length >= 2))];
  if (!terms.length) return [];
  const resolved = [];
  for (const entry of entries) {
    const key = entry.key || entry.name || "";
    const shouldLookup = Array.isArray(plan?.sql_resultset_lookups)
      ? plan.sql_resultset_lookups.some(item => item?.key === key || item?.key === entry.name)
      : /合并科目编码与置反备注/.test(key);
    if (!shouldLookup || !entry.sql) continue;
    const resultsetColumns = await inspectResultsetColumns(entry);
    const lookupColumns = resultsetLookupColumns(resultsetColumns);
    if (!lookupColumns.searchableColumns.length) {
      resolved.push({
        key,
        type: "sql_resultset",
        purpose: "SQL结果集没有可识别的名称/编码搜索列，未返回样例候选",
        query_terms: terms,
        sql: "",
        lookup_mode: "no_searchable_columns",
        searchable_columns: lookupColumns.searchableColumns,
        code_columns: lookupColumns.codeColumns,
        name_columns: lookupColumns.nameColumns,
        columns: resultsetColumns,
        rows: [],
        row_count: 0,
        executed: false,
        message: "未执行目录预览。为避免模型把前几条样例误当作证据，只有可按关键词过滤时才返回候选行。"
      });
      continue;
    }
    const directLookup = buildAccountResultsetLookupSql(entry, expandedTerms.length ? expandedTerms : terms, resultsetColumns);
    if (directLookup.sql) {
      const directExecution = await executeSql(directLookup.sql);
      const directRows = (directExecution.rows || []).map(row => {
        const match = scoreResultsetRow(row, terms, lookupColumns);
        return {
          ...row,
          _match_score: Number(match.score.toFixed(3)),
          _matched_term: match.term,
          _matched_column: match.column,
          _matched_value: match.value
        };
      });
      if (directRows.length) {
        resolved.push({
          key,
          type: "sql_resultset",
          purpose: "使用 SQL结果集自身按关键词过滤，返回真实目录候选",
          query_terms: terms,
          sql: directLookup.sql,
          lookup_mode: "filtered_sql",
          scan_limit: 30,
          scanned_row_count: directExecution.row_count,
          searchable_columns: lookupColumns.searchableColumns,
          code_columns: lookupColumns.codeColumns,
          name_columns: lookupColumns.nameColumns,
          columns: directExecution.columns,
          rows: directRows,
          row_count: directRows.length,
          executed: directExecution.executed,
          message: `已用目录 SQL 直接过滤并返回 ${directRows.length} 条候选。`
        });
        continue;
      }
    }
    const scanSql = buildResultsetScanSql(entry);
    const execution = await executeSql(scanSql);
    const candidates = filterResultsetCandidates(execution.rows || [], terms, lookupColumns, 30);
    const useFullSmallResultset = !candidates.length && (execution.rows || []).length <= RESULTSET_FULL_CONTEXT_LIMIT;
    const rowsForModel = candidates.length
      ? candidates
      : useFullSmallResultset
        ? (execution.rows || [])
        : [];
    resolved.push({
      key,
      type: "sql_resultset",
      purpose: candidates.length
        ? "从 SQL结果集全量目录中模糊召回候选"
        : useFullSmallResultset
          ? "SQL结果集较小，返回全量目录给模型判断"
          : "SQL结果集目录已扫描，但未召回可靠候选",
      query_terms: terms,
      sql: scanSql,
      lookup_mode: candidates.length ? "fuzzy_scan" : useFullSmallResultset ? "full_small_resultset" : "fuzzy_no_match",
      scan_limit: RESULTSET_SCAN_LIMIT,
      scanned_row_count: execution.row_count,
      searchable_columns: lookupColumns.searchableColumns,
      code_columns: lookupColumns.codeColumns,
      name_columns: lookupColumns.nameColumns,
      columns: execution.columns,
      rows: rowsForModel,
      row_count: rowsForModel.length,
      executed: execution.executed,
      message: candidates.length
        ? `已从 ${execution.row_count} 行目录中召回 ${candidates.length} 条候选。`
        : useFullSmallResultset
          ? `目录只有 ${execution.row_count} 行，已返回全量目录。`
          : `已扫描 ${execution.row_count} 行目录，未召回可靠候选。`
    });
  }
  return resolved;
}

function normalizeRetrievalPlanData(data) {
  const plan = data && typeof data === "object" ? { ...data } : {};
  if (!Array.isArray(plan.selected_metric_keys)) plan.selected_metric_keys = [];
  if (!Array.isArray(plan.selected_rule_keys)) plan.selected_rule_keys = [];
  if (!Array.isArray(plan.knowledge_metric_candidates)) plan.knowledge_metric_candidates = [];
  if (!Array.isArray(plan.disabled_mandatory_filter_ids)) plan.disabled_mandatory_filter_ids = [];
  if (!Array.isArray(plan.sql_resultset_lookups)) plan.sql_resultset_lookups = [];
  if (!Array.isArray(plan.sql_plan)) plan.sql_plan = [];
  if (!Array.isArray(plan.display_formats)) plan.display_formats = [];
  plan.semantic_plan = normalizeSemanticPlan(plan.semantic_plan);
  plan.coverage_checklist = normalizeCoverageChecklist(plan.coverage_checklist || plan.semantic_plan.coverage_checklist || []);
  plan.disabled_mandatory_filter_ids = [
    ...new Set(plan.disabled_mandatory_filter_ids.map(item => String(item || "").trim()).filter(Boolean))
  ];
  plan.knowledge_metric_candidates = [
    ...new Set(plan.knowledge_metric_candidates.map(item => String(item || "").trim()).filter(Boolean))
  ];
  plan.sql_resultset_lookups = plan.sql_resultset_lookups.map(item => ({
    key: String(item?.key || "").trim(),
    terms: [...new Set((item?.terms || []).map(term => String(term || "").trim()).filter(term => term.length >= 2))],
    reason: String(item?.reason || "").trim()
  })).filter(item => item.key && item.terms.length);
  plan.needs_sql_resultset = Boolean(plan.needs_sql_resultset && plan.sql_resultset_lookups.length);
  if (!Array.isArray(plan.warnings)) plan.warnings = [];
  plan.intent = String(plan.intent || "unknown").trim() || "unknown";
  plan.summary = String(plan.summary || "").trim();
  return plan;
}

function normalizeCoverageChecklist(items) {
  const list = Array.isArray(items) ? items : [];
  return list.map(item => {
    const value = typeof item === "string" ? { item } : (item && typeof item === "object" ? item : {});
    const status = String(value.status || "unknown").trim() || "unknown";
    return {
      item: String(value.item || value.name || value.object || value.query || "").trim(),
      item_type: String(value.item_type || value.type || "").trim(),
      status,
      evidence_type: String(value.evidence_type || value.evidenceType || "").trim(),
      evidence_key: String(value.evidence_key || value.evidenceKey || "").trim(),
      needs_lookup: Boolean(value.needs_lookup || status === "needs_lookup"),
      note: String(value.note || value.reason || "").trim()
    };
  }).filter(item => item.item);
}

function normalizeKnowledgeMetric(item) {
  const source = item && typeof item === "object" ? item : {};
  const rawDependencies = Array.isArray(source.dependencies)
    ? source.dependencies
    : Array.isArray(source.operands)
      ? source.operands
      : [];
  const confidence = Number(source.confidence);
  return {
    name: String(source.name || source.metric || source.metric_name || "").trim(),
    formula: String(source.formula || source.expression || "").trim(),
    dependencies: rawDependencies.map(dependency => {
      const value = typeof dependency === "string" ? { name: dependency } : (dependency || {});
      return {
        name: String(value.name || value.metric || value.item || value.concept || "").trim(),
        variable: String(value.variable || value.reference || value.alias || "").trim(),
        period_role: String(value.period_role || value.periodRole || value.role || "current_period").trim(),
        evidence_type: String(value.evidence_type || value.evidenceType || "none").trim(),
        evidence_key: String(value.evidence_key || value.evidenceKey || "").trim()
      };
    }).filter(dependency => dependency.name),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    source: "model_knowledge",
    standard_definition: source.standard_definition == null ? true : Boolean(source.standard_definition),
    caveat: String(source.caveat || source.assumption || source.note || "").trim()
  };
}

function normalizeSemanticPlanResultSets(items) {
  return (Array.isArray(items) ? items : [])
    .map((item, index) => {
      const value = item && typeof item === "object" ? item : {};
      const output = (Array.isArray(value.output) ? value.output : [])
        .map(column => String(column || "").trim())
        .filter(Boolean);
      const rawSourceColumns = Array.isArray(value.source_columns)
        ? value.source_columns
        : Array.isArray(value.source_fields)
          ? value.source_fields
          : [];
      return {
        key: String(value.key || `result_${index + 1}`).trim() || `result_${index + 1}`,
        title: String(value.title || value.name || "").trim(),
        purpose: String(value.purpose || value.description || "").trim(),
        rule_keys: [...new Set((Array.isArray(value.rule_keys) ? value.rule_keys : [])
          .map(ruleKey => String(ruleKey || "").trim())
          .filter(Boolean))],
        output,
        source_columns: output.map((_, columnIndex) => String(rawSourceColumns[columnIndex] || "").trim())
      };
    })
    .filter(item => item.title || item.rule_keys.length);
}

function normalizeSemanticPlan(plan) {
  const source = plan && typeof plan === "object" ? { ...plan } : {};
  const knowledgeMetrics = Array.isArray(source.knowledge_metrics)
    ? source.knowledge_metrics
    : Array.isArray(source.inferred_metrics)
      ? source.inferred_metrics
      : [];
  source.knowledge_metrics = knowledgeMetrics
    .map(normalizeKnowledgeMetric)
    .filter(metric => metric.name && metric.formula);
  source.result_sets = normalizeSemanticPlanResultSets(source.result_sets);
  delete source.inferred_metrics;
  return source;
}

function mergeSemanticPlans(base, extra) {
  const left = normalizeSemanticPlan(base);
  const right = normalizeSemanticPlan(extra);
  const knowledgeMetrics = new Map();
  [...(left.knowledge_metrics || []), ...(right.knowledge_metrics || [])].forEach(metric => {
    knowledgeMetrics.set(metric.name, metric);
  });
  const resultSets = new Map();
  [...(left.result_sets || []), ...(right.result_sets || [])].forEach((resultSet, index) => {
    const signature = resultSet.key || resultSet.title || `result_${index + 1}`;
    resultSets.set(signature, resultSet);
  });
  const merged = {
    ...left,
    ...right,
    knowledge_metrics: [...knowledgeMetrics.values()],
    result_sets: [...resultSets.values()]
  };
  for (const key of ["metrics", "tables", "dimensions", "calculations", "filters", "needs_lookup", "output"]) {
    const values = [...(Array.isArray(left[key]) ? left[key] : []), ...(Array.isArray(right[key]) ? right[key] : [])];
    if (values.length) {
      merged[key] = [...new Map(values.map(value => [typeof value === "string" ? value : JSON.stringify(value), value])).values()];
    }
  }
  return merged;
}

function knowledgeMetricsFromPlan(plan) {
  return normalizeSemanticPlan(plan?.semantic_plan || plan).knowledge_metrics || [];
}

function businessMetricEvidenceForConcept(payload, concept) {
  const target = normalizeCandidateText(concept);
  if (!target) return null;
  return semanticEntries(payload, "business_metric").find(entry => {
    const labels = [entry?.key, entry?.name, ...(Array.isArray(entry?.aliases) ? entry.aliases : [])];
    return labels.some(label => normalizeCandidateText(label) === target);
  }) || null;
}

function reconcileKnowledgeMetricEvidence(payload, decision) {
  const next = normalizeAgentLoopDecision(decision);
  const knowledgeMetrics = knowledgeMetricsFromPlan(next);
  if (!knowledgeMetrics.length) return next;

  const selectedMetricKeys = new Set(next.selected_metric_keys || []);
  const unresolvedDependencies = new Set();
  const updatedMetrics = knowledgeMetrics.map(metric => ({
    ...metric,
    dependencies: metric.dependencies.map(dependency => {
      const matchedMetric = businessMetricEvidenceForConcept(payload, dependency.name);
      if (matchedMetric) {
        const evidenceKey = String(matchedMetric.key || matchedMetric.name || "").trim();
        if (evidenceKey) selectedMetricKeys.add(evidenceKey);
        return {
          ...dependency,
          evidence_type: "business_metric",
          evidence_key: evidenceKey
        };
      }
      if (!dependency.evidence_type || dependency.evidence_type === "none") {
        unresolvedDependencies.add(dependency.name);
      }
      return dependency;
    })
  }));

  const parentNames = new Set(updatedMetrics.map(metric => normalizeCandidateText(metric.name)).filter(Boolean));
  const dependencyByName = new Map(updatedMetrics
    .flatMap(metric => metric.dependencies)
    .map(dependency => [normalizeCandidateText(dependency.name), dependency]));
  const checklist = normalizeCoverageChecklist(next.coverage_checklist).map(item => {
    const normalizedItem = normalizeCandidateText(item.item);
    if (parentNames.has(normalizedItem)) {
      return {
        ...item,
        status: "covered",
        evidence_type: "model_knowledge",
        evidence_key: item.item,
        needs_lookup: false,
        note: item.note || "采用模型通用知识中的标准定义；数据依赖仍需真实证据绑定。"
      };
    }
    const dependency = dependencyByName.get(normalizedItem);
    if (!dependency) return item;
    const covered = Boolean(dependency.evidence_type && dependency.evidence_type !== "none");
    return {
      ...item,
      status: covered ? "covered" : "needs_lookup",
      evidence_type: covered ? dependency.evidence_type : "none",
      evidence_key: covered ? dependency.evidence_key : "",
      needs_lookup: !covered,
      note: item.note || (covered ? "依赖项已绑定真实语义证据。" : "需要从真实目录绑定科目或编码。")
    };
  });
  for (const metric of updatedMetrics) {
    if (!checklist.some(item => normalizeCandidateText(item.item) === normalizeCandidateText(metric.name))) {
      checklist.push({
        item: metric.name,
        item_type: "metric",
        status: "covered",
        evidence_type: "model_knowledge",
        evidence_key: metric.name,
        needs_lookup: false,
        note: "采用模型通用知识中的标准定义；数据依赖仍需真实证据绑定。"
      });
    }
    for (const dependency of metric.dependencies) {
      if (checklist.some(item => normalizeCandidateText(item.item) === normalizeCandidateText(dependency.name))) continue;
      const covered = Boolean(dependency.evidence_type && dependency.evidence_type !== "none");
      checklist.push({
        item: dependency.name,
        item_type: "object",
        status: covered ? "covered" : "needs_lookup",
        evidence_type: covered ? dependency.evidence_type : "none",
        evidence_key: covered ? dependency.evidence_key : "",
        needs_lookup: !covered,
        note: covered ? "依赖项已绑定真实语义证据。" : "需要从真实目录绑定科目或编码。"
      });
    }
  }

  const existingNeedsLookup = Array.isArray(next.semantic_plan?.needs_lookup) ? next.semantic_plan.needs_lookup : [];
  const parentNameValues = new Set(updatedMetrics.map(metric => normalizeCandidateText(metric.name)));
  const needsLookup = [...new Set([
    ...existingNeedsLookup.filter(item => !parentNameValues.has(normalizeCandidateText(typeof item === "string" ? item : item?.name || item?.item))),
    ...unresolvedDependencies
  ])];
  const existingLookups = Array.isArray(next.sql_resultset_lookups) ? next.sql_resultset_lookups : [];
  const sqlResultsetLookups = unresolvedDependencies.size && existingLookups.length
    ? existingLookups.map(lookup => ({ ...lookup, terms: [...unresolvedDependencies] }))
    : existingLookups;

  return normalizeAgentLoopDecision({
    ...next,
    selected_metric_keys: [...selectedMetricKeys],
    coverage_checklist: checklist,
    sql_resultset_lookups: sqlResultsetLookups,
    semantic_plan: {
      ...next.semantic_plan,
      knowledge_metrics: updatedMetrics,
      needs_lookup: needsLookup
    }
  });
}

function lookupTermsFromSemanticPlan(plan) {
  const terms = [];
  const appendValue = value => {
    if (value == null) return;
    if (typeof value === "string" || typeof value === "number") {
      const text = String(value).trim();
      if (text.length >= 2) terms.push(text);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(appendValue);
      return;
    }
    if (typeof value === "object") {
      appendValue(value.item || value.name || value.object || value.term || value.query || value.value);
    }
  };
  appendValue(plan?.semantic_plan?.needs_lookup);
  appendValue(plan?.needs_lookup);
  return [...new Set(terms)];
}

function coverageTermsNeedingLookup(plan) {
  const checklist = normalizeCoverageChecklist(plan?.coverage_checklist || plan?.semantic_plan?.coverage_checklist || []);
  const lookupStatuses = new Set(["needs_lookup", "unsupported", "ambiguous", "unknown"]);
  const lookupItemTypes = new Set(["metric", "object", "filter", "rule", ""]);
  const terms = checklist
    .filter(item => (
      item.needs_lookup ||
      (
        lookupStatuses.has(item.status) &&
        lookupItemTypes.has(item.item_type) &&
        (!item.evidence_type || item.evidence_type === "none")
      )
    ))
    .map(item => item.item)
    .filter(item => item.length >= 2);
  return [...new Set([...terms, ...lookupTermsFromSemanticPlan(plan)])];
}

function inferSqlResultsetLookupsForTerms(payload, terms, reason = "coverage_checklist") {
  const catalog = semanticCatalog(payload);
  const entries = Array.isArray(catalog.sql_resultset) ? catalog.sql_resultset : [];
  const queryTerms = [...new Set((terms || []).map(term => String(term || "").trim()).filter(term => term.length >= 2))];
  if (!entries.length || !queryTerms.length) return [];
  return entries
    .map(entry => ({
      key: String(entry.key || entry.name || "").trim(),
      terms: queryTerms,
      reason
    }))
    .filter(item => item.key);
}

function enforceCoverageChecklistLookup(payload, decision) {
  const terms = coverageTermsNeedingLookup(decision);
  if (!terms.length) return decision;
  const existingLookups = Array.isArray(decision.sql_resultset_lookups) ? decision.sql_resultset_lookups : [];
  const inferredLookups = existingLookups.length
    ? existingLookups
    : inferSqlResultsetLookupsForTerms(payload, terms, "覆盖清单仍有对象需要从 SQL结果集补齐编码或枚举");
  if (!inferredLookups.length) return decision;
  return normalizeAgentLoopDecision({
    ...decision,
    action: "lookup_sql_resultset",
    sql_resultset_lookups: inferredLookups,
    summary: decision.summary || `覆盖清单中还有 ${compactList(terms, 5)} 需要补查目录。`,
    reason: decision.reason || "不是所有用户要求的对象都有可执行证据；先查询 SQL结果集补齐编码、枚举或备注。"
  });
}

function lookupResolutionFromResultsets(payload, plan, resolvedSqlResultsets = []) {
  const terms = coverageTermsNeedingLookup(plan);
  if (!terms.length || !resolvedSqlResultsets.length) {
    return { ok: false, terms, unresolved_terms: terms, resolved_items: [] };
  }
  const resolvedItems = resolvedItemsFromResultsets(plan, resolvedSqlResultsets);
  const unresolvedTerms = terms.filter(term => !resolvedItems.some(item => {
    const normalizedTerm = normalizeCandidateText(term);
    const itemTexts = [item.item, item.name, item.code].map(normalizeCandidateText).filter(Boolean);
    if (itemTexts.includes(normalizedTerm)) return true;
    return [item.item, item.name].some(value => scoreCandidateValue(term, value) >= 0.78);
  }));
  return {
    ok: !unresolvedTerms.length,
    terms,
    unresolved_terms: unresolvedTerms,
    resolved_items: resolvedItems
  };
}

function semanticEntryContextText(entry) {
  const spec = entry?.spec && typeof entry.spec === "object" ? entry.spec : {};
  return [
    entry?.key,
    entry?.key_name,
    entry?.name,
    ...(Array.isArray(entry?.aliases) ? entry.aliases : []),
    entry?.summary,
    entry?.description,
    entry?.content,
    spec.content,
    spec.summary,
    spec.description,
    spec.answer,
    spec.rule,
    spec.requirement,
    entry?.table_note,
    entry?.question,
    entry?.answer
  ].filter(Boolean).join("\n");
}

function semanticEntryMatchTerms(entry) {
  return [...new Set([
    entry?.key,
    entry?.key_name,
    entry?.name,
    ...(Array.isArray(entry?.aliases) ? entry.aliases : [])
  ]
    .filter(Boolean)
    .flatMap(value => String(value).split(/[\s/／、,，|;；:：()（）\[\]【】]+/))
    .map(normalizeCandidateText)
    .filter(term => term.length >= 2 && term.length <= 32))];
}

function scoreSemanticEntryForQuestion(entry, question) {
  const query = String(question || "");
  const normalizedQuery = normalizeCandidateText(query);
  const terms = semanticEntryMatchTerms(entry);
  const termScore = terms.reduce((best, term) => {
    const exactBoost = normalizedQuery.includes(term)
      ? 1 + Math.min(0.2, term.length / 50)
      : 0;
    return Math.max(
      best,
      exactBoost,
      scoreCandidateValue(query, term),
      scoreCandidateValue(term, query)
    );
  }, 0);
  const context = semanticEntryContextText(entry);
  const contextScore = context
    ? Math.max(scoreCandidateValue(query, context), scoreCandidateValue(context, query)) * 0.82
    : 0;
  return Math.max(termScore, contextScore);
}

function selectRelevantSemanticEntries(payload, type, limit, pinnedKeys = []) {
  const question = payload.question || "";
  const pinned = new Set(pinnedKeys.filter(Boolean).map(String));
  const entries = semanticEntries(payload, type);
  const ranked = entries
    .map((entry, index) => ({
      entry,
      index,
      score: pinned.has(String(entry?.key || "")) || pinned.has(String(entry?.name || "")) ? 2 : scoreSemanticEntryForQuestion(entry, question)
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const picked = ranked
    .filter(item => item.score > 0.18 || pinned.has(String(item.entry?.key || "")) || pinned.has(String(item.entry?.name || "")))
    .slice(0, limit)
    .map(item => item.entry);
  return picked.length ? picked : ranked.slice(0, Math.min(limit, ranked.length)).map(item => item.entry);
}

function agentSemanticCatalogContext(payload) {
  const selectedTables = selectedPayloadTables(payload);
  const mandatoryRuleKeys = selectedTables.length === 1
    ? semanticMandatoryRuleKeys(payload, { semantic_plan: { tables: selectedTables } })
    : [];
  return {
    business_metric: selectRelevantSemanticEntries(payload, "business_metric", 18),
    logic_text: selectRelevantSemanticEntries(payload, "logic_text", 12, mandatoryRuleKeys),
    result_presentation: selectRelevantSemanticEntries(payload, "result_presentation", 6),
    sql_resultset: selectRelevantSemanticEntries(payload, "sql_resultset", 6),
    table_column_note: selectRelevantSemanticEntries(payload, "table_column_note", 4),
    standard_qa: selectRelevantSemanticEntries(payload, "standard_qa", 4)
  };
}

function questionRequestsMetricBreakdown(payload) {
  return /哪一项|哪项|哪个|增长较多|增长最多|增长最大|分项|拆分|构成|分别|各项|明细|分类|同比变化|变动/.test(String(payload?.question || ""));
}

function queryRequestsAnalyticalSql(payload, plan = payload?.retrieval_plan) {
  const semanticPlan = plan?.semantic_plan || {};
  const text = [
    payload?.question,
    plan?.intent,
    plan?.summary,
    semanticPlan.time,
    ...(Array.isArray(semanticPlan.dimensions) ? semanticPlan.dimensions : []),
    ...(Array.isArray(semanticPlan.calculations) ? semanticPlan.calculations : []),
    ...(Array.isArray(semanticPlan.output) ? semanticPlan.output : [])
  ]
    .flatMap(item => {
      if (item == null) return [];
      if (typeof item === "object") return [JSON.stringify(item)];
      return [String(item)];
    })
    .join("\n");
  const compact = text.replace(/\s+/g, "");
  return [
    /trend_analysis|dimension_summary|detail_query|period_overview|table_analysis/i,
    /(20\d{2})年?(?:至|到|~|～|-|—)(20\d{2})年?/,
    /(?:各|每|逐|按|分).{0,8}(?:年|年度|月|月份|月度|季度|期间|日期)/,
    /(?:一|二|三|四|1|2|3|4|Q[1-4])季度/i,
    /季度|同比|环比|增长|趋势|变化|对比|排名|排行|top|占比|构成|分布|分项|拆分|分类|分组|明细|清单/i,
    /按.{1,16}(?:公司|客户|产品|科目|部门|组织|地区|区域|类型|类别|维度|字段|期间|日期|表).{0,8}(?:汇总|统计|分组|展示|列出|对比)?/
  ].some(pattern => pattern.test(compact));
}

function metricBreakdownKeys(metric) {
  const raw = metric?.metric?.breakdown_metrics
    || metric?.breakdown_metrics
    || metric?.metric?.breakdowns
    || metric?.breakdowns
    || [];
  if (!Array.isArray(raw)) return [];
  return raw
    .map(item => typeof item === "string" ? item : item?.metric_key || item?.key || "")
    .filter(Boolean);
}

function expandSelectedMetricKeysByBreakdown(payload, metrics, selectedKeys) {
  const keys = [...new Set((selectedKeys || []).filter(Boolean))];
  if (!questionRequestsMetricBreakdown(payload)) return keys;
  const result = [...keys];
  const add = key => {
    if (!key || result.includes(key) || !metrics.has(key)) return;
    result.push(key);
  };
  keys.forEach(key => {
    const metric = metrics.get(key);
    metricBreakdownKeys(metric).forEach(add);
  });
  return result;
}

function payloadFilterSignals(payload) {
  const dataPath = payload?.qa_config?.data_path || {};
  const transactionScope = payload?.qa_config?.transaction_scope || {};
  const values = [
    payload?.question,
    dataPath.label,
    dataPath.value,
    transactionScope.label,
    transactionScope.value
  ].filter(Boolean).map(String);
  if (dataPath.value === "legal") values.push("法口", "法口数据", "LG");
  if (dataPath.value === "management") values.push("管口", "管口数据", "PC");
  return values;
}

function parseNamedFilterAliases(content) {
  const aliases = [];
  const bracket = String(content || "").match(/使用该过滤口径[：:]\s*\[([^\]]+)\]/);
  if (bracket) {
    bracket[1]
      .split(/[,\n，、]+/)
      .map(item => item.replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, "").trim())
      .filter(Boolean)
      .forEach(item => aliases.push(item));
  }
  const title = String(content || "").match(/【命名过滤】([^\n]+)/);
  if (title?.[1]) aliases.push(title[1].trim());
  return [...new Set(aliases)];
}

function parseNamedFilterCondition(content) {
  const match = String(content || "").match(/过滤条件[：:]\s*([^\n\r]+)/);
  return match?.[1]?.trim().replace(/[。；;]\s*$/g, "") || "";
}

function sqlConditionField(condition) {
  const match = String(condition || "").match(/`?([A-Za-z_][\w$]*)`?\s*(?:=|<>|!=|LIKE|NOT\s+LIKE|IN|NOT\s+IN)(?=\s|'|\()/i);
  return match?.[1] || "";
}

function semanticNamedSqlFilters(payload, plan = null) {
  const signals = payloadFilterSignals(payload);
  const signalText = signals.join("\n");
  return semanticEntries(payload, "logic_text")
    .filter(entry => semanticEntryMatchesPlanScope(entry, payload, plan))
    .map(entry => {
      const content = semanticEntryContextText(entry);
      const aliases = parseNamedFilterAliases(content);
      const condition = parseNamedFilterCondition(content);
      const field = sqlConditionField(condition);
      const matched = aliases.some(alias => signalText.includes(alias))
        || signals.some(signal => content.includes(signal) && /【命名过滤】|过滤条件/.test(content));
      if (!condition || !matched) return null;
      return {
        id: `semantic_named_filter_${entry.key || entry.name || field}`,
        rule_key: entry.key || entry.name || "",
        field,
        sql: condition,
        source: entry.name || entry.key || "命名过滤",
        reason: "问数配置或问题文本命中命名过滤。"
      };
    })
    .filter(Boolean);
}

function parseInlineSqlConditions(content) {
  const conditions = [];
  const seen = new Set();
  const text = String(content || "");
  const addCondition = condition => {
    const normalized = String(condition || "").trim();
    const signature = sqlConditionSignature(normalized);
    if (!normalized || seen.has(signature)) return;
    seen.add(signature);
    conditions.push(normalized);
  };
  let blockMatch;
  const notBlockRe = /(?:^|\n)\s*AND\s+NOT\s*\(([\s\S]*?)\)/gi;
  while ((blockMatch = notBlockRe.exec(text))) {
    const inner = String(blockMatch[1] || "").trim();
    if (inner) addCondition(`NOT (\n${inner}\n)`);
  }
  const inlineText = text.replace(notBlockRe, "\n");
  inlineText
    .split(/\r?\n/)
    .map(line => line.trim().replace(/^[\d一二三四五六七八九十]+[.、]\s*/g, ""))
    .forEach(line => {
      const match = line.match(/^(?:AND\s+)?(`?[A-Za-z_][\w$]*`?\s*(?:=|<>|!=|LIKE|NOT\s+LIKE)\s*'[^']+')/i);
      if (!match) return;
      addCondition(match[1]);
    });
  return conditions;
}

function semanticDefaultSqlFilters(payload, plan = null) {
  return semanticEntries(payload, "logic_text")
    .filter(entry => semanticEntryMatchesPlanScope(entry, payload, plan))
    .flatMap(entry => {
      const content = semanticEntryContextText(entry);
      if (!/(固定过滤|默认过滤|公共过滤|必须过滤|普通查询)/.test(content)) return [];
      return parseInlineSqlConditions(content)
        .map(sql => {
          const field = sqlConditionField(sql);
          return {
            id: `semantic_default_filter_${entry.key || entry.name || field}_${field}`,
            rule_key: entry.key || entry.name || "",
            field,
            value: (sql.match(/=\s*'([^']*)'/) || [])[1],
            sql,
            source: entry.name || entry.key || "默认过滤",
            reason: "语义规则声明为固定/默认过滤。"
          };
        })
        .filter(Boolean);
    });
}

function semanticSqlFilters(payload, plan = null) {
  const filters = [];
  const seen = new Set();
  [...semanticNamedSqlFilters(payload, plan), ...semanticDefaultSqlFilters(payload, plan)].forEach(item => {
    const signature = sqlConditionSignature(item?.sql || "");
    if (!signature || seen.has(signature)) return;
    seen.add(signature);
    filters.push(item);
  });
  return filters;
}

function semanticRuleTables(entry) {
  return [...new Set([
    entry?.source_table,
    ...(Array.isArray(entry?.source_tables) ? entry.source_tables : []),
    ...(Array.isArray(entry?.tables) ? entry.tables : [])
  ].map(item => typeof item === "string" ? item : item?.table_name || item?.name || "").filter(Boolean))];
}

function semanticRuleKey(entry) {
  return String(entry?.key || entry?.key_name || entry?.name || "").trim();
}

function semanticRulePriority(entry) {
  const value = Number(entry?.priority ?? entry?.spec?.priority ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function semanticRuleStages(entry) {
  const values = entry?.injection_stages
    || entry?.injectionStages
    || entry?.spec?.injection_stages
    || [];
  return [...new Set((Array.isArray(values) ? values : [])
    .map(value => String(value || "").trim())
    .filter(Boolean))];
}

function semanticRuleContent(entry) {
  return String(
    entry?.content
    || entry?.summary
    || entry?.description
    || entry?.spec?.content
    || entry?.spec?.summary
    || ""
  ).trim();
}

function normalizeTableScopeName(value) {
  return String(value || "")
    .replace(/[`"']/g, "")
    .trim()
    .split(".")
    .pop()
    .toLowerCase();
}

function plannedTableScope(payload, plan = null) {
  const allowed = new Map(selectedPayloadTables(payload)
    .map(table => [normalizeTableScopeName(table), table]));
  const planned = Array.isArray(plan?.semantic_plan?.tables)
    ? plan.semantic_plan.tables
    : [];
  const resolved = planned
    .map(table => allowed.get(normalizeTableScopeName(table)) || "")
    .filter(Boolean);
  if (resolved.length) return [...new Set(resolved)];
  const selected = selectedPayloadTables(payload);
  return selected.length === 1 ? selected : [];
}

function semanticEntryMatchesTables(entry, tables, { includeGlobal = true } = {}) {
  const ruleTables = semanticRuleTables(entry).map(normalizeTableScopeName).filter(Boolean);
  if (!ruleTables.length) return includeGlobal;
  const scope = new Set((tables || []).map(normalizeTableScopeName).filter(Boolean));
  return Boolean(scope.size && ruleTables.some(table => scope.has(table)));
}

function semanticEntryMatchesPlanScope(entry, payload, plan = null) {
  const tables = plannedTableScope(payload, plan);
  if (!tables.length) return true;
  return semanticEntryMatchesTables(entry, tables);
}

function semanticMandatoryRuleKeys(payload, plan = null) {
  const logicEntries = semanticEntries(payload, "logic_text");
  const scopedTables = plannedTableScope(payload, plan);
  const priorityRuleKeys = logicEntries
    .filter(entry => semanticRulePriority(entry) >= 100)
    .filter(entry => scopedTables.length && semanticEntryMatchesTables(entry, scopedTables, { includeGlobal: false }))
    .map(semanticRuleKey)
    .filter(Boolean);
  return [...new Set([
    ...semanticSqlFilters(payload, plan).map(item => item.rule_key).filter(Boolean),
    ...priorityRuleKeys
  ])];
}

function ruleExecutionEntry(entry, selectedBy = []) {
  const stages = semanticRuleStages(entry);
  return {
    key: semanticRuleKey(entry),
    name: String(entry?.name || entry?.key || entry?.key_name || "").trim(),
    priority: semanticRulePriority(entry),
    required: semanticRulePriority(entry) >= 100,
    tables: semanticRuleTables(entry),
    injection_stages: stages,
    content: semanticRuleContent(entry),
    selected_by: [...new Set(selectedBy.filter(Boolean))]
  };
}

function buildRuleExecutionManifest(payload, plan) {
  const entries = semanticEntries(payload, "logic_text");
  const scopedTables = plannedTableScope(payload, plan);
  const selectedKeys = new Set((plan?.selected_rule_keys || []).map(String));
  const filterKeys = new Set(semanticSqlFilters(payload, plan).map(item => String(item.rule_key || "")).filter(Boolean));
  const selected = new Map();
  const add = (entry, reason) => {
    const key = semanticRuleKey(entry);
    if (!key) return;
    const existing = selected.get(key);
    if (existing) {
      existing.selected_by = [...new Set([...existing.selected_by, reason].filter(Boolean))];
      return;
    }
    selected.set(key, ruleExecutionEntry(entry, [reason]));
  };

  entries.forEach(entry => {
    const key = semanticRuleKey(entry);
    const compatible = !scopedTables.length || semanticEntryMatchesTables(entry, scopedTables);
    if (selectedKeys.has(key) && compatible) add(entry, "semantic_plan");
    if (filterKeys.has(key) && compatible) add(entry, "sql_filter");
    if (
      semanticRulePriority(entry) >= 100
      && scopedTables.length
      && semanticEntryMatchesTables(entry, scopedTables, { includeGlobal: false })
    ) {
      add(entry, "table_mandatory");
    }
  });

  const rules = [...selected.values()];
  const stages = {};
  rules.forEach(rule => {
    const injectionStages = rule.injection_stages.length
      ? rule.injection_stages
      : ["planner_policy", "sql_generation"];
    injectionStages.forEach(stage => {
      if (!stages[stage]) stages[stage] = [];
      stages[stage].push(rule);
    });
  });
  const requiredStageKeys = Object.fromEntries(Object.entries(stages).map(([stage, stageRules]) => [
    stage,
    stageRules.filter(rule => rule.required).map(rule => rule.key)
  ]));
  return {
    scoped_tables: scopedTables,
    rule_keys: rules.map(rule => rule.key),
    required_rule_keys: rules.filter(rule => rule.required).map(rule => rule.key),
    required_stage_rule_keys: requiredStageKeys,
    stages,
    rules
  };
}

function scopedTableContextForPlan(payload, plan) {
  const tables = new Set(plannedTableScope(payload, plan).map(normalizeTableScopeName));
  const context = Array.isArray(payload?.table_context) ? payload.table_context : [];
  if (!tables.size) return context;
  return context.filter(entry => tables.has(normalizeTableScopeName(entry?.qualified_table || entry?.table)));
}

function scopedSemanticCatalogForPlan(payload, plan, manifest) {
  const catalog = semanticCatalog(payload);
  const tables = plannedTableScope(payload, plan);
  const selectedRuleKeys = new Set(manifest?.rule_keys || []);
  const scoped = {};
  Object.entries(catalog).forEach(([type, values]) => {
    const entries = Array.isArray(values) ? values : [];
    if (type === "logic_text") {
      scoped[type] = entries.filter(entry => selectedRuleKeys.has(semanticRuleKey(entry)));
      return;
    }
    scoped[type] = tables.length
      ? entries.filter(entry => semanticEntryMatchesTables(entry, tables))
      : entries;
  });
  return scoped;
}

function genericQuestionYear(payload) {
  const text = String(payload?.question || "");
  const match = text.match(/(20\d{2})\s*年/) || text.match(/(^|[^\d])((?:20)\d{2})(?!\d)/);
  return match ? (match[2] || match[1]) : "";
}

function collectTimeValues(value, out = []) {
  if (value == null) return out;
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).trim();
    if (text) out.push(text);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach(item => collectTimeValues(item, out));
    return out;
  }
  if (typeof value === "object") {
    [
      value.period,
      value.periods,
      value.current_period,
      value.comparison_period,
      value.previous_period,
      value.current,
      value.previous,
      value.year,
      value.years,
      value.value,
      value.values
    ].forEach(item => collectTimeValues(item, out));
    if (value.start_year && value.end_year) {
      const start = Number(value.start_year);
      const end = Number(value.end_year);
      if (Number.isFinite(start) && Number.isFinite(end)) {
        const step = start <= end ? 1 : -1;
        for (let year = start; step > 0 ? year <= end : year >= end; year += step) {
          out.push(String(year));
        }
      }
    }
  }
  return out;
}

function tableContextForSource(payload, sourceTable) {
  const target = splitQualifiedTableName(sourceTable).table.toLowerCase();
  return (payload?.table_context || []).find(table => {
    const names = [table?.table, table?.qualified_table].filter(Boolean).map(item => splitQualifiedTableName(item).table.toLowerCase());
    return names.includes(target);
  }) || null;
}

function genericYearColumn(payload, sourceTable) {
  const table = tableContextForSource(payload, sourceTable);
  const columns = Array.isArray(table?.columns) ? table.columns : [];
  const names = columns.map(column => String(column?.name || column || "")).filter(Boolean);
  const lower = new Map(names.map(name => [name.toLowerCase(), name]));
  for (const candidate of ["r_gjahr", "gjahr", "fiscal_year", "year", "年份", "年度"]) {
    if (lower.has(candidate.toLowerCase())) return lower.get(candidate.toLowerCase());
  }
  const semanticColumn = columns.find(column => {
    const text = `${column?.name || column || ""}\n${column?.comment || ""}\n${(column?.sample_values || []).join("\n")}`;
    return /(年份|年度|年月|月份|期间|日期|period|year|month|date)/i.test(text);
  });
  if (semanticColumn) return String(semanticColumn.name || semanticColumn || "");
  return "";
}

function genericYearColumnValue(payload, sourceTable, field, year) {
  const table = tableContextForSource(payload, sourceTable);
  const column = (table?.columns || []).find(item => String(item?.name || item || "") === field);
  const samples = (column?.sample_values || []).map(String);
  if (samples.some(value => /^20\d{2}\.(0[1-9]|1[0-2])$/.test(value))) return `${year}.12`;
  if (samples.some(value => /^20\d{2}(0[1-9]|1[0-2])$/.test(value))) return `${year}12`;
  if (samples.some(value => /^20\d{2}-(0[1-9]|1[0-2])$/.test(value))) return `${year}-12`;
  if (samples.some(value => /^20\d{2}\/(0[1-9]|1[0-2])$/.test(value))) return `${year}/12`;
  return year;
}

function normalizeGenericTimeValue(payload, sourceTable, field, value) {
  const text = String(value || "").trim();
  const period = text.match(/^(20\d{2})[.-](0?[1-9]|1[0-2])$/);
  if (period) return `${period[1]}.${String(period[2]).padStart(2, "0")}`;
  const year = text.match(/^20\d{2}$/) ? text : "";
  if (year) return genericYearColumnValue(payload, sourceTable, field, year);
  return "";
}

function previousYearEndGenericTimeValue(value) {
  const match = String(value || "").match(/^(20\d{2})(?:\.(0[1-9]|1[0-2]))?$/);
  if (!match) return "";
  return `${Number(match[1]) - 1}.12`;
}

function genericRequestedTimeValues(payload, sourceTable) {
  const field = genericYearColumn(payload, sourceTable);
  if (!field) return [];
  const semanticPlan = payload?.retrieval_plan?.semantic_plan || {};
  const rawValues = collectTimeValues(semanticPlan.time, []);
  collectTimeValues(payload?.retrieval_plan?.time, rawValues);
  const normalizeValues = values => [...new Set(values
    .flatMap(value => String(value || "").split(/[,，、;；\s]+/))
    .map(value => normalizeGenericTimeValue(payload, sourceTable, field, value))
    .filter(Boolean))]
    .sort();
  const plannedValues = normalizeValues(rawValues);
  if (plannedValues.length) return plannedValues;

  const questionValues = [];
  {
    const text = String(payload?.question || "");
    let match;
    const rangeRe = /(20\d{2})\s*年?\s*(?:至|到|~|～|-|—)\s*(20\d{2})\s*年?/g;
    while ((match = rangeRe.exec(text))) {
      const start = Number(match[1]);
      const end = Number(match[2]);
      const step = start <= end ? 1 : -1;
      for (let year = start; step > 0 ? year <= end : year >= end; year += step) questionValues.push(String(year));
    }
    const yearMonthRe = /(20\d{2})\s*年\s*(?:累计(?:至|到)?|截至|截止|至|1\s*[-至到~～]\s*)?\s*(0?[1-9]|1[0-2])\s*月/g;
    while ((match = yearMonthRe.exec(text))) questionValues.push(`${match[1]}.${String(match[2]).padStart(2, "0")}`);
    if (!questionValues.length) {
      const year = genericQuestionYear(payload);
      if (year) questionValues.push(year);
    }
  }
  return normalizeValues(questionValues);
}

function genericTimeSqlFilters(payload, sourceTable) {
  const table = tableContextForSource(payload, sourceTable);
  const columns = Array.isArray(table?.columns) ? table.columns : [];
  const byName = new Map(columns
    .map(column => [String(column?.name || column || "").toLowerCase(), column])
    .filter(([name]) => name));
  const findColumn = candidates => {
    for (const candidate of candidates) {
      const column = byName.get(candidate.toLowerCase());
      if (column) return column;
    }
    return null;
  };
  const columnName = column => String(column?.name || column || "");
  const yearColumn = findColumn(["r_gjahr", "gjahr", "fiscal_year", "year", "年份", "年度"]);
  const monthColumn = findColumn(["r_monat", "monat", "fiscal_month", "month", "月份", "月度"]);
  const fallbackField = genericYearColumn(payload, sourceTable);
  if (!fallbackField) return [];
  const value = genericRequestedTimeValues(payload, sourceTable)[0];
  if (!value) return [];
  const period = String(value).match(/^(20\d{2})\.(0[1-9]|1[0-2])$/);
  const makeFilter = (field, filterValue, operator = "=") => ({
    id: `generic_time_${field}`,
    field,
    value: filterValue,
    sql: `${sqlIdentifier(field)} ${operator} ${sqlLiteral(filterValue)}`,
    source: "question_time",
    reason: "问题文本命中期间。"
  });

  if (period && yearColumn && monthColumn) {
    const yearField = columnName(yearColumn);
    const monthField = columnName(monthColumn);
    const monthSamples = (monthColumn?.sample_values || []).map(String);
    const month = monthSamples.some(sample => /^0[1-9]$/.test(sample))
      ? period[2]
      : String(Number(period[2]));
    return [makeFilter(yearField, period[1]), makeFilter(monthField, month)];
  }

  if (period) {
    const combinedColumn = columns.find(column => {
      const samples = (column?.sample_values || []).map(String);
      const description = `${columnName(column)} ${column?.comment || ""}`;
      return samples.some(sample => /^20\d{2}(?:[.\-/]?(?:0[1-9]|1[0-2]))$/.test(sample))
        && /(年月|月份|期间|日期|period|month|date|薪资)/i.test(description);
    }) || columns.find(column => /(年月|月份|期间|period|month|薪资)/i.test(`${columnName(column)} ${column?.comment || ""}`));
    if (combinedColumn) {
      const field = columnName(combinedColumn);
      const samples = (combinedColumn?.sample_values || []).map(String);
      if (samples.some(sample => /^20\d{4}$/.test(sample))) return [makeFilter(field, `${period[1]}${period[2]}`)];
      if (samples.some(sample => /^20\d{2}-\d{2}$/.test(sample))) return [makeFilter(field, `${period[1]}-${period[2]}`)];
      if (samples.some(sample => /^20\d{2}\/\d{2}$/.test(sample))) return [makeFilter(field, `${period[1]}/${period[2]}`)];
      if (samples.some(sample => /^20\d{2}\.\d{2}$/.test(sample))) return [makeFilter(field, `${period[1]}.${period[2]}`)];
      if (samples.some(sample => /^20\d{2}-\d{2}-\d{2}$/.test(sample))) return [makeFilter(field, `${period[1]}-${period[2]}%`, "LIKE")];
      return [makeFilter(field, `${period[1]}.${period[2]}`)];
    }
  }

  const field = period && yearColumn ? columnName(yearColumn) : fallbackField;
  const filterValue = period && yearColumn
    ? period[1]
    : value;
  return [makeFilter(field, filterValue)];
}

function buildAgentLoopMessages(payload, state) {
  const catalogContext = agentSemanticCatalogContext(payload);
  const schema = {
    action: "plan_ready | lookup_sql_resultset | answer_direct | ask_clarification",
    intent: "metric_query | trend_analysis | period_overview | table_profile | table_analysis | dimension_summary | detail_query | rule_explanation | sql_resultset_lookup | unknown",
    selected_metric_keys: ["string"],
    selected_rule_keys: ["string"],
    knowledge_metric_candidates: ["requested metric name absent from business_metric"],
    disabled_mandatory_filter_ids: ["string"],
    sql_resultset_lookups: [{ key: "string", terms: ["string"], reason: "string" }],
    coverage_checklist: [{
      item: "用户问题里的指标、对象、时间、维度、过滤条件或输出要求",
      item_type: "metric | object | time | dimension | filter | output | rule | table | format",
      status: "covered | needs_lookup | unsupported | ambiguous",
      evidence_type: "business_metric | model_knowledge | logic_text | result_presentation | sql_resultset | table_column_note | standard_qa | table_context | user_question | none",
      evidence_key: "string",
      needs_lookup: false,
      note: "string"
    }],
    semantic_plan: {
      mode: "verified_metric_query | exploratory_table_query | direct_answer | needs_lookup | clarification",
      metrics: ["business metric key"],
      tables: ["table name"],
      time: "string or object",
      dimensions: ["field or business dimension"],
      calculations: ["aggregation, yoy, ranking, distribution, detail, count"],
      filters: ["business condition or rule key"],
      needs_lookup: ["object that needs code/enum lookup"],
      output: ["expected result columns"],
      result_sets: [{
        key: "stable result identifier",
        title: "business-readable table title",
        purpose: "why this independent result table is required",
        rule_keys: ["logic_text key that defines this table"],
        output: ["expected columns for this table"]
      }]
    },
    display_formats: [{ column: "SQL result column name", metric_key: "string or null", format: "number | percent", display_scale: 1, suffix: "string", precision: 2, reason: "string" }],
    answer: "string",
    summary: "string",
    reason: "string",
    warnings: ["string"]
  };
  return [
    {
      role: "system",
      content: [
        "你是 NL2SQL 侦探式 Agent 的下一步决策器。你不是固定流水线；每一轮只选择最合理的下一步。",
        "目标是尽量回答用户关于当前表/知识库的一切合理问题，而不是只做指标命中。",
        "可选 action：",
        "1. plan_ready：已有足够证据形成语义计划。适用于业务指标、趋势分析、明细查询、分组统计、字段分布、行数、样例、按时间/公司/客户等维度分析。注意：本阶段只输出 semantic_plan，不写 SQL。",
        "2. lookup_sql_resultset：只在需要把用户说的业务对象解析成编码、枚举、科目备注时使用，例如普通科目名找科目编码。",
        "3. answer_direct：问题是规则解释、字段含义、表说明，直接用语义或表结构回答，不需要 SQL。",
        "4. ask_clarification：只有在当前表都无法确定、问题没有任何可执行方向、且不能给出有价值探索结果时才使用。",
        "不要因为没有命中 business_metric 就澄清；如果 table_context 能支撑，就形成 exploratory_table_query 计划或直接回答。",
        "本阶段禁止输出 SQL。你只负责理解问题、选择依据和给出 semantic_plan；SQL 会由后续编译/生成层统一产生。",
        "不要输出 sql_plan，也不要复述语义目录长文本；把输出预算留给 coverage_checklist 和实际决策。",
        "必须输出 coverage_checklist：逐项拆出用户问题中的所有指标/对象/时间/维度/过滤条件/输出要求/展示要求。每一项都要写 status 和 evidence。",
        "意图不要都归成 metric_query：多期间、同比、增长、趋势归 trend_analysis；行数、样例、字段分布、表结构归 table_profile；按字段分组汇总归 dimension_summary；查明细清单归 detail_query。",
        "多对象问题必须逐项覆盖，不能因为部分对象命中 business_metric 就忽略其他对象。",
        "语义目录是企业口径的最高优先级，但不是模型知识的白名单。用户请求的指标未配置在 business_metric 时，如果它有稳定、通行的财务或业务定义，你必须使用自己的通用知识补出公式，而不是直接判定未定义。",
        "logic_text 中 priority>=100 的规则是其关联表范围内的强制规则。必须先依据问题、普通选表规则和 table_context 确定 semantic_plan.tables；只有规则 tables 与目标表相交时才纳入 selected_rule_keys，严禁因为优先级高就把其他表的规则带入本轮。规则自身声明了适用条件时，还要判断本轮是否满足。",
        "通用知识兜底只能补指标含义、标准公式和依赖项，不能补数据库字段、科目编码、枚举值、企业专属过滤或数据结果。所有依赖项仍必须绑定到真实 business_metric、table_context 或 SQL结果集证据后才能取数。",
        "本阶段不要展开通用公式。把语义目录外但可能有通行定义的请求指标放入 knowledge_metric_candidates，后端会调用专门的知识解析器补公式，避免一轮输出过长。",
        "knowledge_metric_candidates 只放父指标名，不能直接拿父指标名查科目目录；后续知识解析器会先拆公式，再查公式所需的基础概念。",
        "只有公式存在多种实质性定义、依赖项含义无法判定或用户要求企业专属口径时，才要求澄清；这时也要在 answer 中给出已知的通行定义和具体歧义，不能只说未定义。",
        "只有 coverage_checklist 中所有可执行对象都是 covered，才允许 plan_ready 或 answer_direct。",
        "如果某个对象没有 business_metric，但它像科目、枚举、类型、状态、名称或编码映射项，status 必须是 needs_lookup，并在 sql_resultset_lookups 中选择相关 SQL结果集。",
        "不要用常识猜科目编码、费用类型编码或枚举编码；如果目录里可能存在，就先查 SQL结果集。unsupported 只能用于目录补查后仍无证据的对象。",
        "SQL结果集不是普通样例，它是目录/映射知识；需要解析编码、枚举或备注时必须查。",
        "如果某个输出列需要展示成百分数、指定单位或指定精度，可以写入 display_formats；不要为了展示要求改变取数口径。",
        "display_formats.display_scale 表示展示前缩放系数，不要求 SQL 为展示而改写。例如公式结果是 0.089 且业务要显示 8.9%，则 display_scale=100、format=percent、suffix='%'。",
        "semantic_catalog.result_presentation 只描述结果渲染/回答展示要求，不参与取数口径、指标选择或 WHERE/SELECT 生成；真正生效由后端渲染层处理。",
        "如果 result_presentation 提到百分数、单位、精度、业务总结或图表，只需要在 coverage_checklist 标记展示要求；不要把它当成业务过滤或计算规则。",
        "semantic_plan.output 只表示查询最终需要的结果列，不能把一组列名误当成多张结果表。",
        "只有当 logic_text 明确要求多个字段结构或粒度不同的独立表格时，才填写 semantic_plan.result_sets；每项必须给出表格标题、用途、对应 rule_keys 和该表字段。仅要求固定文字、日期、提醒或总结的规则不能建立 result_set。",
        "semantic_plan 中的表、字段、编码和企业规则只能引用 table_context、semantic_catalog 或 resolved_sql_resultsets 中真实存在的内容；knowledge_metrics 的标准公式和业务概念允许来自模型通用知识。",
        "遇到宽泛问题时，不要套固定模板；根据语义、表结构和样例自行选择表级统计、字段分布、样例预览、维度汇总或指标概览。",
        "不要无目的地查 SQL结果集；但 coverage_checklist 里存在 needs_lookup 时，不能跳过 SQL结果集补查。",
        "selected_metric_keys 只能选 semantic_catalog.business_metric 中真实 key。",
        "selected_rule_keys 只能选 semantic_catalog.logic_text 中真实 key。",
        "如果某条 mandatory 过滤与本轮问题明确冲突，可以在 disabled_mandatory_filter_ids 写入过滤 id；不要让后端根据问题文字猜。",
        "sql_resultset_lookups.key 只能选 semantic_catalog.sql_resultset 中真实 key。",
        "已补查过的 SQL结果集在 state.resolved_sql_resultsets 中；不要重复查同一个词。",
        `严格按 JSON schema 输出：${JSON.stringify(schema)}`,
        "只输出 JSON，不要输出 Markdown。"
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({
        question: payload.question,
        qa_config: payload.qa_config || null,
        conversation_context: payload.conversation_context || null,
        semantic_catalog: {
          business_metric: (catalogContext.business_metric || []).map(item => ({
            key: item.key,
            name: item.name,
            aliases: item.aliases || [],
            metric_kind: item.metric_kind,
            source_table: item.source_table,
            scope_filter: item.scope_filter,
            presentation: item.presentation || item.display || null
          })),
          logic_text: (catalogContext.logic_text || []).map(item => ({
            key: item.key,
            name: item.name,
            tables: semanticRuleTables(item),
            priority: Number(item.priority ?? item.spec?.priority ?? 0),
            injection_stages: item.injection_stages || item.injectionStages || [],
            summary: item.summary,
            content: safePreview(
              item.content || item.summary || "",
              Number(item.priority ?? item.spec?.priority ?? 0) >= 100 ? 1800 : 700
            )
          })),
          result_presentation: (catalogContext.result_presentation || []).map(item => ({
            key: item.key,
            name: item.name,
            summary: item.summary,
            content: safePreview(item.content || item.summary || "", 900),
            applies_to: item.applies_to || item.presentation_stages || []
          })),
          sql_resultset: (catalogContext.sql_resultset || []).map(item => ({
            key: item.key,
            name: item.name,
            description: item.description || item.summary || ""
          })),
          table_column_note: (catalogContext.table_column_note || []).map(item => ({
            key: item.key,
            name: item.name,
            table_note: item.table_note,
            columns: item.columns
          })),
          standard_qa: (catalogContext.standard_qa || []).map(item => ({
            key: item.key,
            name: item.name,
            question: item.question || item.name || item.key,
            answer: item.answer || item.content || item.summary || ""
          }))
        },
        table_context: tableContextForPlanner(payload.table_context || []),
        state
      })
    }
  ];
}

function knowledgeMetricCandidateNames(payload, decision) {
  const explicit = Array.isArray(decision?.knowledge_metric_candidates)
    ? decision.knowledge_metric_candidates
    : [];
  const checklistCandidates = normalizeCoverageChecklist(decision?.coverage_checklist)
    .filter(item => item.item_type === "metric")
    .filter(item => item.status !== "covered" || item.evidence_type === "model_knowledge")
    .map(item => item.item);
  return [...new Set([...explicit, ...checklistCandidates]
    .map(item => String(item || "").trim())
    .filter(Boolean)
    .filter(item => !businessMetricEvidenceForConcept(payload, item)))];
}

function buildKnowledgeMetricMessages(payload, candidateNames = []) {
  const schema = {
    knowledge_metrics: [{
      name: "requested metric name",
      formula: "formula using dependency variables",
      dependencies: [{
        name: "business concept name",
        variable: "ASCII formula variable",
        period_role: "current_period | previous_period | previous_year_same_period | previous_year_end | average_begin_end"
      }],
      confidence: 0.0,
      standard_definition: true,
      caveat: "material ambiguity or empty"
    }]
  };
  return [
    {
      role: "system",
      content: [
        "你是业务指标知识解析器，只负责用模型自身知识补充企业指标目录中缺失的标准公式。",
        "只处理用户问题中确实请求、且 catalog_metrics 中没有同名或同义项的指标。已有目录指标不要重复输出。",
        "每个指标必须给出简洁公式和完整依赖项；formula 使用 dependencies.variable 中的 ASCII 变量，不能直接写数据库字段或科目编码。",
        "你可以提供通行的财务或业务定义，但不能猜企业专属口径、字段、科目编码、枚举值或数据。",
        "如果名称存在多个实质性定义，仍可给出最通行定义，但必须在 caveat 写明歧义并降低 confidence。",
        "candidate_names 非空时只判断这些候选；为空时从 question 中识别目录外的请求指标。",
        "输出要紧凑，不写解释段落、不写 SQL、不重复用户的时间和展示要求。",
        `严格按 JSON schema 输出：${JSON.stringify(schema)}`,
        "只输出 JSON。"
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({
        question: payload.question,
        candidate_names: candidateNames,
        catalog_metrics: semanticEntries(payload, "business_metric").map(metric => ({
          key: metric.key,
          name: metric.name,
          aliases: metric.aliases || []
        }))
      })
    }
  ];
}

async function resolveKnowledgeMetricFallback(payload, decision, force = false) {
  const candidateNames = knowledgeMetricCandidateNames(payload, decision);
  if (!force && !candidateNames.length) {
    return { decision: reconcileKnowledgeMetricEvidence(payload, decision), attempted: false, knowledge_metrics: [] };
  }
  const response = await callModelJson(
    buildKnowledgeMetricMessages(payload, candidateNames),
    { temperature: 0.05, maxTokens: 2200 }
  );
  const rawMetrics = Array.isArray(response.data?.knowledge_metrics) ? response.data.knowledge_metrics : [];
  const knowledgeMetrics = rawMetrics
    .map(normalizeKnowledgeMetric)
    .filter(metric => metric.name && metric.formula)
    .filter(metric => !businessMetricEvidenceForConcept(payload, metric.name));
  const mergedDecision = {
    ...decision,
    knowledge_metric_candidates: [...new Set([...(decision.knowledge_metric_candidates || []), ...candidateNames])],
    semantic_plan: mergeSemanticPlans(decision.semantic_plan, { knowledge_metrics: knowledgeMetrics })
  };
  return {
    decision: reconcileKnowledgeMetricEvidence(payload, mergedDecision),
    attempted: true,
    knowledge_metrics: knowledgeMetrics,
    model: response.model,
    usage: response.usage
  };
}

function normalizeAgentLoopDecision(data) {
  const decision = data && typeof data === "object" ? { ...data } : {};
  if (decision.action === "generate_sql") decision.action = "plan_ready";
  const allowedActions = new Set(["plan_ready", "lookup_sql_resultset", "answer_direct", "ask_clarification"]);
  if (!allowedActions.has(decision.action)) decision.action = "plan_ready";
  if (!Array.isArray(decision.selected_metric_keys)) decision.selected_metric_keys = [];
  if (!Array.isArray(decision.selected_rule_keys)) decision.selected_rule_keys = [];
  if (!Array.isArray(decision.knowledge_metric_candidates)) decision.knowledge_metric_candidates = [];
  if (!Array.isArray(decision.disabled_mandatory_filter_ids)) decision.disabled_mandatory_filter_ids = [];
  if (!Array.isArray(decision.sql_resultset_lookups)) decision.sql_resultset_lookups = [];
  if (!Array.isArray(decision.sql_plan)) decision.sql_plan = [];
  if (!Array.isArray(decision.display_formats)) decision.display_formats = [];
  if (!decision.semantic_plan || typeof decision.semantic_plan !== "object") decision.semantic_plan = {};
  decision.coverage_checklist = normalizeCoverageChecklist(decision.coverage_checklist || decision.semantic_plan.coverage_checklist || []);
  decision.disabled_mandatory_filter_ids = [
    ...new Set(decision.disabled_mandatory_filter_ids.map(item => String(item || "").trim()).filter(Boolean))
  ];
  decision.knowledge_metric_candidates = [
    ...new Set(decision.knowledge_metric_candidates.map(item => String(item || "").trim()).filter(Boolean))
  ];
  decision.sql_resultset_lookups = decision.sql_resultset_lookups.map(item => ({
    key: String(item?.key || "").trim(),
    terms: [...new Set((item?.terms || []).map(term => String(term || "").trim()).filter(term => term.length >= 2))],
    reason: String(item?.reason || "").trim()
  })).filter(item => item.key && item.terms.length);
  if (decision.action === "lookup_sql_resultset" && !decision.sql_resultset_lookups.length) {
    decision.action = "plan_ready";
  }
  if (!Array.isArray(decision.warnings)) decision.warnings = [];
  decision.intent = String(decision.intent || "unknown").trim() || "unknown";
  decision.answer = String(decision.answer || "").trim();
  decision.summary = String(decision.summary || "").trim();
  decision.reason = String(decision.reason || "").trim();
  decision.sql = "";
  return decision;
}

function mergeLoopDecisionIntoPlan(plan, decision) {
  const nextPlan = normalizeRetrievalPlanData(plan || {});
  nextPlan.intent = decision.intent || nextPlan.intent || "unknown";
  nextPlan.selected_metric_keys = [
    ...new Set([
      ...(nextPlan.selected_metric_keys || []),
      ...(decision.selected_metric_keys || [])
    ].filter(Boolean))
  ];
  nextPlan.selected_rule_keys = [
    ...new Set([
      ...(nextPlan.selected_rule_keys || []),
      ...(decision.selected_rule_keys || [])
    ].filter(Boolean))
  ];
  nextPlan.knowledge_metric_candidates = [
    ...new Set([
      ...(nextPlan.knowledge_metric_candidates || []),
      ...(decision.knowledge_metric_candidates || [])
    ].filter(Boolean))
  ];
  nextPlan.disabled_mandatory_filter_ids = [
    ...new Set([
      ...(nextPlan.disabled_mandatory_filter_ids || []),
      ...(decision.disabled_mandatory_filter_ids || [])
    ].filter(Boolean))
  ];
  nextPlan.warnings = [
    ...new Set([
      ...(nextPlan.warnings || []),
      ...(decision.warnings || [])
    ].filter(Boolean))
  ];
  nextPlan.sql_plan = Array.isArray(decision.sql_plan) ? decision.sql_plan : nextPlan.sql_plan || [];
  nextPlan.display_formats = Array.isArray(decision.display_formats) ? decision.display_formats : nextPlan.display_formats || [];
  nextPlan.coverage_checklist = Array.isArray(decision.coverage_checklist)
    ? decision.coverage_checklist
    : nextPlan.coverage_checklist || [];
  nextPlan.semantic_plan = mergeSemanticPlans(nextPlan.semantic_plan, decision.semantic_plan);
  nextPlan.summary = decision.summary || nextPlan.summary || "";
  return nextPlan;
}

function agentLoopDecisionArtifact(decision, plan) {
  return {
    action: decision.action,
    intent: decision.intent,
    selected_metric_keys: decision.selected_metric_keys || [],
    selected_rule_keys: decision.selected_rule_keys || [],
    knowledge_metric_candidates: decision.knowledge_metric_candidates || [],
    disabled_mandatory_filter_ids: decision.disabled_mandatory_filter_ids || [],
    sql_resultset_lookups: decision.sql_resultset_lookups || [],
    coverage_checklist: decision.coverage_checklist || [],
    semantic_plan: decision.semantic_plan || {},
    sql_plan: (decision.sql_plan || []).slice(0, 12),
    display_formats: decision.display_formats || [],
    reason: decision.reason || "",
    current_plan: retrievalPlanArtifact(plan)
  };
}

function agentLoopTraceLabel(decision, round) {
  const suffix = round > 1 ? `（第 ${round} 轮）` : "";
  if (decision.action === "lookup_sql_resultset") return `需要补查目录${suffix}`;
  if (decision.action === "answer_direct") return `决定直接回答${suffix}`;
  if (decision.action === "ask_clarification") return `判断需要补充信息${suffix}`;
  return `形成语义计划${suffix}`;
}

async function runSemanticAgentLoop(payload, pushTrace, emitProgress) {
  let retrievalPlan = {
    intent: "unknown",
    selected_metric_keys: [],
    selected_rule_keys: [],
    disabled_mandatory_filter_ids: [],
    needs_sql_resultset: false,
    sql_resultset_lookups: [],
    summary: "",
    warnings: []
  };
  const resolvedSqlResultsets = [];
  const state = {
    selected_metric_keys: [],
    selected_rule_keys: [],
    disabled_mandatory_filter_ids: [],
    resolved_sql_resultsets: [],
    warnings: [],
    loop_summaries: [],
    semantic_plan: {},
    coverage_checklist: []
  };
  const seenLookups = new Set();
  for (let round = 1; round <= 4; round += 1) {
    const stageStartedAt = Date.now();
    const loopTraceId = `agent_loop_${round}`;
    emitProgress?.(
      loopTraceId,
      "agent_loop",
      round > 1 ? `重新判断下一步（第 ${round} 轮）` : "理解问题并判断下一步",
      stageStartedAt,
      round > 1
        ? "模型正在结合刚才补查到的结果，重新判断是否已经足够生成 SQL。"
        : "模型正在判断这次问题要用哪些指标、规则、目录或表结构。",
      {
        purpose: "由模型根据当前证据决定下一步，而不是按固定流水线硬走。",
        finding: "等待模型返回下一步判断。",
        decision: "返回后会继续补查、生成 SQL、直接回答或要求澄清。"
      }
    );
    let decision;
    let plannerError = null;
    try {
      const loopResult = await callModelJson(buildAgentLoopMessages(payload, state), { temperature: 0.08, maxTokens: 2048 });
      decision = reconcileKnowledgeMetricEvidence(payload, loopResult.data);
    } catch (error) {
      plannerError = error;
      decision = normalizeAgentLoopDecision({
        action: "plan_ready",
        intent: retrievalPlan.intent || "unknown",
        selected_metric_keys: retrievalPlan.selected_metric_keys,
        selected_rule_keys: retrievalPlan.selected_rule_keys,
        summary: "下一步判断失败，改用当前已有上下文继续生成 SQL。",
        reason: error.message || String(error),
        warnings: [error.message || String(error)]
      });
    }

    const knowledgeCandidates = knowledgeMetricCandidateNames(payload, decision);
    if (plannerError || knowledgeCandidates.length) {
      const knowledgeStartedAt = Date.now();
      const knowledgeTraceId = `knowledge_fallback_${round}`;
      emitProgress?.(
        knowledgeTraceId,
        "knowledge_fallback",
        "补充通用指标公式",
        knowledgeStartedAt,
        knowledgeCandidates.length
          ? `企业指标目录缺少 ${compactList(knowledgeCandidates, 6)}，正在用模型知识补充标准公式。`
          : "主规划没有正常返回，正在用紧凑的知识解析器识别目录外指标。",
        {
          purpose: "只补指标定义和依赖项，不猜数据库字段或科目编码。",
          finding: knowledgeCandidates.length ? `待补：${compactList(knowledgeCandidates, 6)}` : "等待识别目录外指标。",
          decision: "公式补齐后，依赖项仍需绑定真实语义或目录证据。"
        }
      );
      try {
        const resolvedKnowledge = await resolveKnowledgeMetricFallback(payload, decision, Boolean(plannerError));
        decision = resolvedKnowledge.decision;
        pushTrace(traceItem(
          "knowledge_fallback",
          "补充通用指标公式",
          resolvedKnowledge.knowledge_metrics.length ? "success" : "skipped",
          knowledgeStartedAt,
          resolvedKnowledge.knowledge_metrics.length
            ? `补充 ${resolvedKnowledge.knowledge_metrics.map(metric => metric.name).join("、")}`
            : "没有识别到可安全使用的目录外标准指标",
          { knowledge_metrics: resolvedKnowledge.knowledge_metrics },
          resolvedKnowledge.knowledge_metrics.length
            ? "模型只补出了标准公式；后端接下来会为每个依赖项寻找真实业务指标或科目映射。"
            : "知识解析器没有产生可执行公式，继续使用已有语义和表结构。",
          {
            id: knowledgeTraceId,
            purpose: "用模型通用知识补齐企业目录外的标准指标定义。",
            finding: resolvedKnowledge.knowledge_metrics.length
              ? `补充 ${resolvedKnowledge.knowledge_metrics.length} 个指标公式`
              : "未补充公式",
            decision: "只接受结构化公式，不允许模型知识直接绑定数据库字段。"
          }
        ));
      } catch (error) {
        decision.warnings = [...new Set([...(decision.warnings || []), error.message || String(error)])];
        pushTrace(traceItem(
          "knowledge_fallback",
          "补充通用指标公式",
          "failed",
          knowledgeStartedAt,
          error.message || String(error),
          null,
          "知识兜底调用失败，继续使用已有企业语义，不阻断后续流程。",
          {
            id: knowledgeTraceId,
            purpose: "补充目录外标准指标定义。",
            finding: error.message || String(error),
            decision: "保留已有语义继续生成，避免整条请求因兜底失败而中断。"
          }
        ));
      }
    }

    retrievalPlan = mergeLoopDecisionIntoPlan(retrievalPlan, decision);
    const computableKeys = computableMetricKeys(payload, retrievalPlan.selected_metric_keys || []);
    if ((decision.action === "answer_direct" || decision.action === "ask_clarification") && computableKeys.length) {
      decision = {
        ...decision,
        action: "plan_ready",
        selected_metric_keys: computableKeys,
        summary: `已命中可计算业务指标：${computableKeys.join("、")}，继续生成 SQL。`,
        reason: "业务指标已经具备公式、依赖项和基础过滤条件，不能在 SQL 生成前直接判定证据不足。"
      };
      retrievalPlan = mergeLoopDecisionIntoPlan(retrievalPlan, decision);
    }
    const knowledgeMetrics = knowledgeMetricsFromPlan(retrievalPlan);
    if (
      (decision.action === "answer_direct" || decision.action === "ask_clarification")
      && knowledgeMetrics.length
      && decision.intent !== "rule_explanation"
    ) {
      decision = {
        ...decision,
        action: "plan_ready",
        summary: `已用通用知识识别 ${knowledgeMetrics.map(metric => metric.name).join("、")} 的标准公式，继续为依赖项绑定真实数据。`,
        reason: "指标目录未直接配置父指标，但模型已形成结构化标准公式；只有依赖项完成真实数据绑定后才会生成 SQL。"
      };
      retrievalPlan = mergeLoopDecisionIntoPlan(retrievalPlan, decision);
    }
    const coverageAdjustedDecision = enforceCoverageChecklistLookup(payload, decision);
    if (
      coverageAdjustedDecision.action !== decision.action ||
      JSON.stringify(coverageAdjustedDecision.sql_resultset_lookups || []) !== JSON.stringify(decision.sql_resultset_lookups || [])
    ) {
      decision = coverageAdjustedDecision;
      retrievalPlan = mergeLoopDecisionIntoPlan(retrievalPlan, decision);
    }
    state.selected_metric_keys = retrievalPlan.selected_metric_keys;
    state.selected_rule_keys = retrievalPlan.selected_rule_keys;
    state.disabled_mandatory_filter_ids = retrievalPlan.disabled_mandatory_filter_ids || [];
    state.warnings = retrievalPlan.warnings;
    state.semantic_plan = retrievalPlan.semantic_plan;
    state.coverage_checklist = retrievalPlan.coverage_checklist;
    state.loop_summaries.push(decision.summary || decision.reason || decision.action);

    pushTrace(traceItem(
      "agent_loop",
      agentLoopTraceLabel(decision, round),
      "success",
      stageStartedAt,
      `动作：${decision.action}；意图：${decision.intent || "unknown"}`,
      agentLoopDecisionArtifact(decision, retrievalPlan),
      decision.summary || `本轮选择 ${decision.action}。`,
      {
        id: loopTraceId,
        purpose: "根据当前证据决定下一步，而不是固定执行所有阶段。",
        finding: decision.reason || decision.summary || `动作=${decision.action}`,
        decision: decision.action === "lookup_sql_resultset"
          ? "还缺编码或枚举，先补查目录。"
          : decision.action === "plan_ready"
            ? "语义计划已形成，进入统一 SQL 生成或指标编译。"
            : decision.action === "answer_direct"
              ? "不需要 SQL，直接回答。"
              : "证据不足，需要用户补充。"
      }
    ));

    if (decision.action === "answer_direct" || decision.action === "ask_clarification") {
      return {
        mode: "direct",
        retrievalPlan,
        resolvedSqlResultsets,
        directAnswer: {
          answer: decision.answer || decision.reason || "当前问题还缺少必要信息。",
          answer_type: decision.action === "answer_direct" ? "final_answer" : "clarification_needed",
          decision: {
            intent: decision.intent,
            selected_metric_key: retrievalPlan.selected_metric_keys[0] || null,
            selected_metric_keys: retrievalPlan.selected_metric_keys,
            selected_rule_keys: retrievalPlan.selected_rule_keys,
            reason: decision.reason || ""
          },
          sql_plan: [],
          sql: "",
          warnings: retrievalPlan.warnings || []
        }
      };
    }

    if (decision.action === "lookup_sql_resultset") {
      const newLookups = (decision.sql_resultset_lookups || []).filter(item => {
        const signature = `${item.key}::${(item.terms || []).join("|")}`;
        if (seenLookups.has(signature)) return false;
        seenLookups.add(signature);
        return true;
      });
      if (!newLookups.length) {
        pushTrace(traceItem(
          "agent_loop",
          "目录补查已收敛",
          "skipped",
          Date.now(),
          "模型再次请求了已经查过的同一批目录词",
          { requested_lookups: decision.sql_resultset_lookups || [] },
          "同一目录请求没有新增信息，停止重复思考并使用现有证据进入 SQL 生成。",
          {
            id: `agent_loop_converged_${round}`,
            purpose: "避免代理在相同目录请求上空转。",
            finding: "没有新的目录查询项。",
            decision: "结束代理循环，交给 SQL 生成器处理现有证据。"
          }
        ));
        return { mode: "sql", retrievalPlan, resolvedSqlResultsets, generated: null };
      }
      const lookupStartedAt = Date.now();
      const lookupTraceId = `sql_resultset_lookup_${round}`;
      emitProgress?.(
        lookupTraceId,
        "sql_resultset_lookup",
        `按需补查目录（第 ${round} 轮）`,
        lookupStartedAt,
        `正在查询 ${lookupRequestSummary(newLookups, 3) || "相关目录"}，补齐编码、枚举或名称映射。`,
        {
          purpose: "只在缺少编码、枚举或名称映射时补查目录。",
          finding: "等待目录查询返回。",
          decision: "补查结果会放回模型下一轮判断。"
        }
      );
      try {
        const lookupPlan = {
          ...retrievalPlan,
          needs_sql_resultset: true,
          sql_resultset_lookups: newLookups
        };
        const resolved = await resolveSqlResultsets(payload, lookupPlan);
        resolvedSqlResultsets.push(...resolved);
        state.resolved_sql_resultsets = resolvedSqlResultsets.map(item => ({
          key: item.key,
          query_terms: item.query_terms,
          lookup_mode: item.lookup_mode,
          row_count: item.row_count,
          columns: item.columns,
          rows: item.rows
        }));
        const totalRows = resolved.reduce((sum, item) => sum + Number(item.row_count || 0), 0);
        pushTrace(traceItem(
          "sql_resultset_lookup",
          `按需补查目录（第 ${round} 轮）`,
          totalRows ? "success" : "skipped",
          lookupStartedAt,
          totalRows ? `召回 ${totalRows} 条目录候选` : "目录已查，但未召回可靠候选",
          {
            resultsets: resolved.map(item => ({
              key: item.key,
              query_terms: item.query_terms,
              lookup_mode: item.lookup_mode,
              scan_limit: item.scan_limit,
              scanned_row_count: item.scanned_row_count,
              searchable_columns: item.searchable_columns,
              code_columns: item.code_columns,
              name_columns: item.name_columns,
              row_count: item.row_count,
              columns: item.columns,
              rows: item.rows,
              sql: item.sql
            }))
          },
          totalRows
            ? `补查到 ${resultsetRowSummary(resolved) || `${totalRows} 条候选`}，继续判断是否足够生成 SQL。`
            : "目录没有召回可靠候选；下一轮会决定继续生成 SQL、换路子，或要求补充。",
          {
            id: lookupTraceId,
            purpose: "只在确实缺编码、枚举或名称映射时补查目录。",
            finding: totalRows ? `召回 ${totalRows} 条` : "未召回可靠候选",
            decision: "把补查结果放回循环，重新判断下一步。"
          }
        ));
        const lookupResolution = lookupResolutionFromResultsets(payload, retrievalPlan, resolvedSqlResultsets);
        if (lookupResolution.ok) {
          retrievalPlan = {
            ...retrievalPlan,
            needs_sql_resultset: false,
            summary: retrievalPlan.summary || `目录补查已覆盖 ${compactList(lookupResolution.terms, 6)}。`
          };
          const shortcutStartedAt = Date.now();
          pushTrace(traceItem(
            "semantic_plan",
            "目录证据已补齐",
            "success",
            shortcutStartedAt,
            `已解析：${lookupResolution.resolved_items.map(item => `${item.item}=${item.code}`).join("、")}`,
            {
              coverage_terms: lookupResolution.terms,
              resolved_items: lookupResolution.resolved_items
            },
            "目录补查已经把缺失对象补成可执行编码，直接进入 SQL 编译，不再让模型重复判断同一件事。",
            {
              id: `semantic_plan_shortcut_${round}`,
              purpose: "在证据已经足够时提前收束循环，减少重复模型调用。",
              finding: `已解析 ${lookupResolution.resolved_items.length} 个对象`,
              decision: "停止下一轮思考，交给 SQL 编译器。"
            }
          ));
          return {
            mode: "sql",
            retrievalPlan,
            resolvedSqlResultsets,
            generated: null
          };
        }
      } catch (error) {
        retrievalPlan.warnings.push(error.message || String(error));
        state.warnings = retrievalPlan.warnings;
        pushTrace(traceItem(
          "sql_resultset_lookup",
          `按需补查目录（第 ${round} 轮）`,
          "failed",
          lookupStartedAt,
          error.message || String(error),
          null,
          "目录补查失败；下一轮会改用已有证据继续判断。",
          {
            id: lookupTraceId,
            purpose: "补齐编码或枚举。",
            finding: error.message || String(error),
            decision: "不阻断流程，回到循环继续判断。"
          }
        ));
      }
      continue;
    }

    return {
      mode: "sql",
      retrievalPlan,
      resolvedSqlResultsets,
      generated: null
    };
  }
  return { mode: "sql", retrievalPlan, resolvedSqlResultsets };
}

async function callModelJson(messages, { temperature = 0.1, maxTokens = 4096, timeoutMs = 75_000 } = {}) {
  if (!config.apiKey) throw new Error("未配置 MOI_TAAS_API_KEY");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(config.apiUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature,
        max_tokens: maxTokens
      }),
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`模型接口错误 ${response.status}: ${text.slice(0, 500)}`);
    }
    const raw = JSON.parse(text);
    const content = raw.choices?.[0]?.message?.content || "";
    return {
      model: raw.model || config.model,
      data: extractJsonObject(content),
      raw: content,
      usage: raw.usage || null
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildMessages(payload) {
  const schema = {
    answer: "string",
    answer_type: "final_answer | sql_needed | clarification_needed | rule_explanation | no_evidence",
    hypotheses: [{ title: "string", confidence: 0.0, reason: "string" }],
    search_plan: [{ type: "standard_qa | business_metric | table_column_note | logic_text | sql_resultset", query: "string", purpose: "string" }],
    decision: {
      intent: "metric_query | trend_analysis | period_overview | table_profile | dimension_summary | detail_query | rule_explanation | sql_resultset_lookup | unknown",
      selected_metric_key: "string or null",
      selected_metric_keys: ["string"],
      selected_rule_keys: ["string"],
      confidence: 0.0,
      reason: "string"
    },
    sql_plan: [{ part: "SELECT | FROM | WHERE | GROUP BY | RULE | CHECK", value: "string", source: "string", note: "string" }],
    result_title: "business-readable title for generation_scope output, otherwise empty",
    result_purpose: "short purpose for generation_scope output, otherwise empty",
    display_formats: [{ column: "SQL result column name", metric_key: "string or null", format: "number | percent", display_scale: 1, suffix: "string", precision: 2, reason: "string" }],
    sql: "string",
    warnings: ["string"]
  };
  return [
    {
      role: "system",
      content: [
        "你是一个面向业务用户的 NL2SQL 问数助手，同时也是侦探式语义检索 Agent。",
        "你的任务是先基于用户问题和语义目录进行判断，再给出用户能直接阅读的回答。",
        "payload.semantic_catalog 是当前可用的语义目录；你必须自己阅读其中的指标名称、别名、过滤范围、规则内容来判断命中项。",
        "payload.qa_config 是用户在页面上选择的问数配置，优先级等同于用户问题中的显式要求。",
        "payload.table_context 是当前数据源的真实 schema 和样例行；如果语义目录不足，可以结合表结构探索字段含义。",
        "只能使用 payload.semantic_catalog、payload.table_context 或 resolved_sql_resultsets 中真实出现的表、字段、指标和规则，不要编造不存在的表、字段、指标或规则。",
        "每个 SQL 片段必须能绑定到业务指标、业务规则、表列说明或 SQL结果集中的证据来源。",
        "你没有真实执行数据库 SQL 的能力，除非 payload 中明确提供 result_rows，否则不要编造金额、数量、排名或表格结果。",
        "如果用户问的是具体数值，answer 要说明需要执行生成的 SQL 才能得到最终数值，并简要解释口径。",
        "如果用户问的是规则、口径、字段含义，可以直接用证据回答，不需要假装查数。",
        "如果证据不足，不要硬写 SQL，要在 warnings 里说明缺什么。",
        "必须使用 semantic_catalog、table_context 或 resolved_sql_resultsets 中出现的真实字段名，不要把业务含义改写成 period/currency/version/status 等不存在的通用字段名。",
        "如果 semantic_catalog.business_metric 中已有指标定义，返回 SQL 必须优先使用该指标的 scope_filter/measure/result_factor，不要自己改成中文 LIKE。",
        "payload.retrieval_plan 是前一步模型给出的检索计划；payload.resolved_sql_resultsets 是后端按该计划读取 SQL结果集并宽松召回得到的真实目录候选行，不是最终业务数据。",
        "生成 SQL 前必须核对 payload.retrieval_plan.coverage_checklist；用户要求的每个对象都必须由 business_metric、logic_text、table_column_note、standard_qa、table_context 或 resolved_sql_resultsets 覆盖。",
        "如果 coverage_checklist 里仍有 needs_lookup、unsupported 或 ambiguous 的对象，不能只返回已覆盖对象的局部结果；必须在 warnings 说明缺口，或基于 resolved_sql_resultsets 中的证据补齐。",
        "如果 resolved_sql_resultsets 的 row_count=0，表示目录未召回可靠候选；不要说“前30条没有”，不要把目录未命中描述成业务数据不存在。",
        "只有当用户提到的项目不在 business_metric 里，但在 resolved_sql_resultsets 中出现时，才把它当作普通目录项处理。",
        "resolved_sql_resultsets 每项会给出 code_columns/name_columns/searchable_columns；需要编码时优先读取 code_columns 对应字段，不要假设一定叫“科目编码”；需要名称时优先读取 name_columns 对应字段，不要假设一定叫“科目名称”。",
        "目录项处理方式必须由语义规则或 SQL结果集说明决定；如果目录返回编码、名称、备注或方向字段，要按这些证据生成过滤和符号，不要假设固定字段名或固定路径字段。",
        "如果 resolved_sql_resultsets 中有精确名称匹配，优先使用精确匹配；不要因为它不是 business_metric 就回答“未定义”。",
        "用户同时问多个项目时，应尽量在同一个 SELECT 中输出多个聚合列；每一列可以来自 business_metric 或 resolved_sql_resultsets。",
        "如果 retrieval_plan.intent=period_overview，表示这是宽泛概览问题；应根据 retrieval_plan、语义目录和表结构选择合适查询，不要求必须命中业务指标。",
        "返回 SQL 时必须以 semantic_catalog 中选中的业务指标和 table_context 中真实字段为准，不要丢失指标过滤条件。",
        "如果输出列需要业务展示口径，例如百分数、单位或精度，必须写入 display_formats；不要只在思考或 answer 里口头说明。",
        "display_formats.display_scale 表示展示前缩放系数。例如公式原值 0.089 要展示 8.9%，SQL 保留原始计算值，display_formats 写 format=percent、display_scale=100、suffix='%'。",
        "selected_metric_key 必须是 semantic_catalog.business_metric 中最主要的真实 key；如果没有命中，返回 null。",
        "如果问题涉及多个指标，selected_metric_keys 必须列出所有命中的 business_metric key，主指标放第一位。",
        "selected_rule_keys 必须是 semantic_catalog.logic_text 中真实存在的 key。",
        "answer 使用中文，直接回答用户问题，避免提“分子/分母”这类用户明确不想要的表述。",
        "answer 不要输出 Markdown 表格；需要展示 SQL 时放到 sql 字段。",
        `严格按这个 JSON schema 输出：${JSON.stringify(schema)}`,
        "只输出 JSON，不要输出 Markdown，不要解释 JSON 之外的内容。"
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify(payload)
    }
  ];
}

function normalizeGeneratedResultSets(resultSets) {
  const seenSql = new Set();
  return (Array.isArray(resultSets) ? resultSets : [])
    .slice(0, 8)
    .map((item, index) => {
      const sql = looksLikeExecutableSelectSql(item?.sql) ? normalizeSql(item.sql) : "";
      return {
        key: String(item?.key || `result_${index + 1}`).trim() || `result_${index + 1}`,
        title: String(item?.title || `查询结果 ${index + 1}`).trim() || `查询结果 ${index + 1}`,
        purpose: String(item?.purpose || "").trim(),
        sql,
        applied_rule_keys: [...new Set((Array.isArray(item?.applied_rule_keys) ? item.applied_rule_keys : [])
          .map(value => String(value || "").trim())
          .filter(Boolean))],
        display_formats: Array.isArray(item?.display_formats) ? item.display_formats : []
      };
    })
    .filter(item => {
      if (!item.sql || seenSql.has(item.sql)) return false;
      seenSql.add(item.sql);
      return true;
    });
}

function normalizeModelData(data, payload) {
  const normalized = { ...data };
  const modelSql = normalized.sql || "";
  const usableSql = looksLikeExecutableSelectSql(modelSql)
    ? normalizeSql(modelSql)
    : "";
  const resultSets = normalizeGeneratedResultSets(normalized.result_sets);
  const primarySql = resultSets[0]?.sql || usableSql;
  if (!normalized.answer) {
    normalized.answer = primarySql
      ? "我已经根据当前语义生成了查询 SQL。由于当前未接入真实数据执行结果，需要执行该 SQL 后才能得到最终数值。"
      : "当前证据不足，无法给出可靠回答。";
  }
  if (!normalized.answer_type) {
    normalized.answer_type = primarySql ? "sql_needed" : "no_evidence";
  }
  if (!Array.isArray(normalized.hypotheses)) {
    normalized.hypotheses = normalized.hypothesis
      ? [{ title: String(normalized.hypothesis), confidence: Number(normalized.confidence ?? 0.75), reason: "模型生成的主假设" }]
      : [];
  }
  if (!Array.isArray(normalized.search_plan)) {
    normalized.search_plan = [];
  }
  if (!normalized.decision || typeof normalized.decision !== "object") {
    const selectedEvidence = Array.isArray(normalized.selected_evidence) ? normalized.selected_evidence : [];
    const metric = selectedEvidence.find(item => item.type === "business_metric");
    const rules = selectedEvidence.filter(item => item.type === "logic_text").map(item => item.key).filter(Boolean);
    normalized.decision = {
      intent: "metric_query",
      selected_metric_key: metric?.key || payload.retrieval_plan?.selected_metric_keys?.[0] || null,
      selected_metric_keys: [metric?.key || payload.retrieval_plan?.selected_metric_keys?.[0]].filter(Boolean),
      selected_rule_keys: rules,
      confidence: Number(normalized.confidence ?? 0.75),
      reason: metric ? `模型选择了指标 ${metric.key}` : "模型未显式返回 decision，已由代理归一化"
    };
  }
  if (!Array.isArray(normalized.sql_plan)) {
    const plan = normalized.sql_plan && typeof normalized.sql_plan === "object" ? normalized.sql_plan : {};
    normalized.sql_plan = Object.entries(plan).map(([part, value]) => ({
      part: part.toUpperCase(),
      value: value == null ? "" : String(value),
      source: "model",
      note: "由模型返回的 sql_plan 归一化"
    }));
  }
  normalized.sql = primarySql;
  normalized.result_sets = resultSets;
  if (!Array.isArray(normalized.display_formats)) normalized.display_formats = [];
  if (!Array.isArray(normalized.warnings)) normalized.warnings = [];
  return normalized;
}

async function callDetectiveModel(payload) {
  if (!config.apiKey) {
    throw new Error("未配置 MOI_TAAS_API_KEY");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(config.apiUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: config.model,
        messages: buildMessages(payload),
        temperature: 0.2,
        max_tokens: 4096
      }),
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`模型接口错误 ${response.status}: ${text.slice(0, 500)}`);
    }
    const raw = JSON.parse(text);
    const content = raw.choices?.[0]?.message?.content || "";
    const parsed = extractJsonObject(content);
    return {
      model: raw.model || config.model,
      data: normalizeModelData(parsed, payload),
      raw: content,
      usage: raw.usage || null
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildNl2SqlMessages(payload) {
  const schema = {
    answer: "string",
    answer_type: "sql_needed | clarification_needed | rule_explanation | no_evidence",
    decision: {
      intent: "metric_query | trend_analysis | period_overview | table_profile | dimension_summary | detail_query | rule_explanation | sql_resultset_lookup | unknown",
      selected_metric_key: "string or null",
      selected_metric_keys: ["string"],
      selected_rule_keys: ["string"],
      confidence: 0.0,
      reason: "string"
    },
    sql_plan: [{ part: "SELECT | FROM | WHERE | GROUP BY | RULE | CHECK", value: "string", source: "string", note: "string" }],
    applied_rule_keys: ["rule key that is actually implemented in SQL/output"],
    not_applicable_rules: [{ key: "rule key", reason: "explicit applicability condition not satisfied" }],
    display_formats: [{ column: "SQL result column name", metric_key: "string or null", format: "number | percent", display_scale: 1, suffix: "string", precision: 2, reason: "string" }],
    sql: "single read-only SELECT/WITH SQL; use this for one result set, otherwise empty string",
    result_sets: [{
      key: "stable result identifier",
      title: "business-readable result title",
      purpose: "why this result is needed",
      sql: "one read-only SELECT/WITH SQL for this result",
      applied_rule_keys: ["rule key implemented by this result set"],
      display_formats: [{ column: "SQL result column name", format: "number | percent", display_scale: 1, suffix: "string", precision: 2 }]
    }],
    warnings: ["string"]
  };
  return [
    {
      role: "system",
      content: [
        "你是一个生产级 NL2SQL 生成器，负责把中文问数问题转换为安全、可执行、可解释的 SQL。",
        "你的输出会被后端校验并真实执行，所以必须严格、保守、可追溯。",
        "优先使用 payload.semantic_catalog 中的指标和规则；语义不足时，可以使用 payload.table_context 中真实出现的表结构和样例数据探索字段。",
        "payload.retrieval_plan.semantic_plan.knowledge_metrics 是规划模型用通用知识补出的标准指标公式。语义目录没有父指标时允许使用这些公式，但公式中的每个依赖项都必须绑定到 semantic_catalog、table_context 或 resolved_sql_resultsets 的真实证据。",
        "模型知识可以决定‘怎么算’，不能决定‘数据库里哪个字段、科目或编码就是它’。严禁根据常识编造字段、科目编码、枚举或企业专属口径。",
        "knowledge_metrics 中的 dependency.evidence_type/evidence_key 和 resolved_sql_resultsets 是数据绑定依据。能完整绑定时必须生成 SQL，不要因为父指标不在 business_metric 就返回 no_evidence。",
        "如果只有部分依赖完成绑定，answer 必须给出采用的通行公式、已绑定项和仍缺少的具体依赖；不要只输出‘未定义’或‘无法计算’，也不得悄悄省略用户请求的其他指标。",
        "不要把 NL2SQL 限定成业务指标查询。用户可以询问当前表的业务指标、结构、样例、分布、聚合、明细和口径解释等合理问题。",
        "如果 retrieval_plan.intent=table_profile、table_analysis、dimension_summary 或 detail_query，且没有命中 business_metric，也可以只基于 table_context 中的真实表字段生成 SQL；不要因为没有业务指标就返回澄清。",
        "如果问题是表级探索或结构解释，应根据真实表结构选择直接回答或生成合适的只读 SQL，不要套固定指标流程。",
        "表、字段、科目编码、枚举和企业规则只允许使用 payload.semantic_catalog、payload.table_context 或 resolved_sql_resultsets 中真实出现的内容；标准指标公式还可以使用 retrieval_plan.semantic_plan.knowledge_metrics。",
        "payload.qa_config 是用户在页面上选择的问数配置，必须视为显式过滤/口径要求：table_scope 表示本轮允许使用的数据表范围，data_path 表示管口/法口，transaction_scope 表示是否排除内部关联交易。",
        "payload.retrieval_plan 是上一阶段已经校验过的 semantic plan。你必须优先落实其中的 intent、selected_metric_keys、semantic_plan.time、dimensions、calculations、filters 和 output。",
        "payload.mandatory_context 是后端按目标表和注入阶段编译出的规则契约。只执行 mandatory_context.stages.sql_generation 中的规则；mandatory_context.sql_filters 必须进入 SQL。",
        "priority>=100 的规则必须逐条处置：真实落实后写入 applied_rule_keys；只有规则正文明确声明的适用条件在本轮不成立时，才可写入 not_applicable_rules 并说明理由。不得用‘与问题无关’泛化跳过无条件强制规则。",
        "当 priority>=100 的规则与 retrieval_plan 中模型推测的过滤、字段或输出结构冲突时，以规则正文为准；不能一边标记规则已执行，一边保留与规则相反的 SQL。",
        "若多条强制规则要求不同字段结构或独立结果表，必须使用 result_sets 分别返回；每个结果集在 applied_rule_keys 标明自己落实的规则，不能遗漏，也不能硬拼成列数不一致的 UNION。",
        "输出前检查 mandatory_context.required_stage_rule_keys.sql_generation：每个 key 必须出现在 applied_rule_keys、某个 result_sets[].applied_rule_keys 或 not_applicable_rules 中。",
        "如果 payload.rule_contract_feedback 存在，说明上一版输出漏掉规则处置或独立审计发现 SQL 与规则冲突；必须基于 previous_output 重写完整结果，补齐 missing_rule_keys 并逐条修复 violations，不能只返回解释。",
        "如果 payload.generation_scope 存在，本次是一个独立结果集的并行生成任务。只能生成 generation_scope.output 指定的这一张表，顶层 sql 返回该表 SQL，result_sets 必须为空；generation_scope 之外的其他输出由并行任务负责。",
        "独立结果集任务必须返回 result_title 和 result_purpose。result_title 应优先采用该规则正文明确要求的表名；规则给出‘表名’时不要擅自缩写。",
        "如果你漏写 mandatory_context.sql_filters，后端会在校验前强制注入；你不能生成与这些过滤相冲突的 SQL。",
        "实现 qa_config 时必须先从 table_context 的字段名、字段注释、样例值判断可用字段；能可靠映射才写入 WHERE，不能可靠映射则在 warnings 说明未能落实，不要编造字段。",
        "如果字段含义是通过 table_context 样例推断出来的，需要在 sql_plan.note 或 warnings 中说明推断依据。",
        "payload.conversation_context 只用于明确追问；当前问题完整时必须忽略上一轮上下文，不能继承旧 SQL 的指标、期间、维度或过滤条件。",
        "如果使用 conversation_context，需要在 decision.reason 或 sql_plan.note 中说明继承了哪一部分；如果当前问题明确，必须以当前问题为准。",
        "如果用户问题命中 business_metric，必须使用该指标的 measure.field、measure.aggregation、measure.result_factor 和 scope_filter。",
        "如果输出列需要业务展示口径，例如百分数、单位或精度，必须写入 display_formats；后端会按这个结构同步结果表和最终回答。",
        "display_formats.display_scale 表示展示前缩放系数。例如公式原值 0.089 要展示 8.9%，SQL 保留原始计算值，display_formats 写 format=percent、display_scale=100、suffix='%'。",
        "payload.semantic_catalog.result_presentation 是结果渲染要求，只影响最终表格和回答展示；不要为了它改变 WHERE/SELECT、指标展开或 SQL 输出列。",
        "如果 result_presentation 要求百分数、单位、精度、业务总结或图表，SQL 层保持原始可计算结果，后端渲染层会负责展示。",
        "如果 retrieval_plan.intent=period_overview 或 table_profile，说明这是宽泛概览问题；可以按已选指标生成汇总，也可以基于真实表字段生成表级统计、时间分布、行数、字段分布或样例概览。",
        "如果 retrieval_plan.intent=trend_analysis，SQL 必须保留多个期间、同比/增长列或趋势所需的时间粒度；不要压缩成单期总数。",
        "如果 retrieval_plan.semantic_plan 已给出按年、同比、分组、明细或字段分布要求，SQL 必须保留这些分析结构，不要压缩成单个总数。",
        "如果语义规则声明某类指标是累计值、时点值或需要差额计算，必须按规则处理；没有规则时不要自行套用某个业务域的期间逻辑。",
        "如果是派生指标，先展开依赖指标；企业语义未配置父指标但 knowledge_metrics 已提供标准公式时，继续完成真实数据绑定并生成 SQL。只有依赖无法绑定时才返回 clarification_needed，并同时给出公式和明确缺口。",
        "如果 retrieval_plan.semantic_plan.output 中的指标由已选 logic_text 明确定义公式，且公式依赖已由业务指标或 resolved_sql_resultsets 补齐，SQL 必须实现完整公式并输出其依赖基础项；目录补查结果只是公式依赖，不能替代最终输出指标。",
        "问数结果可以是一个或多个结果集。一个同粒度结果用 sql；只有业务上确实需要不同粒度、不同字段结构或独立用途的多张结果表时，才使用 result_sets。",
        "result_sets 中每项都是一条可独立校验和执行的只读 SELECT/WITH。不同字段结构不要为了塞进一张表而硬拼 UNION；同字段结构的 UNION/UNION ALL 仍然允许。",
        "使用 result_sets 时，顶层 sql 返回空字符串；使用顶层 sql 时，result_sets 返回空数组。结果集数量以完整回答问题所需的最少数量为准，不要随意拆表，也不要因为用户问题包含多种输出就拒绝生成。",
        "每条 SQL 都只能是单条只读 SELECT/WITH；不要写 INSERT/UPDATE/DELETE/CREATE/DROP/SET/USE 等语句。",
        "全限定表名必须写成 `schema`.`table` 或直接写当前库内表名；不要写成 `schema.table`、\"schema.table\" 或 `schema.table` 这种整体加引号的形式。",
        "不要输出中文字段名作为过滤条件；过滤条件必须使用真实字段名。",
        "用户输入公司、客户、供应商、项目等文本名称时，要区分业务名称与数据库完整登记名称。若目录或样例没有证明它是精确全称，优先使用安全的包含匹配并保留用户原词，例如 LIKE '%用户名称%'；编码、单号和已确认的完整枚举仍使用等值匹配。",
        "不要把字段改名成 period/currency/version 等不存在字段。",
        "answer 只说明将要查询什么和口径，不要编造具体数值，因为此阶段还没有执行结果。",
        "禁止出现“分子/分母”表述。",
        `严格按这个 JSON schema 输出：${JSON.stringify(schema)}`,
        "只输出 JSON，不要输出 Markdown。"
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({
        question: payload.question,
        qa_config: payload.qa_config || null,
        chat_history: payload.chat_history || [],
        conversation_context: payload.conversation_context || null,
        data_source: payload.data_source || selectedPayloadTables(payload).join(", ") || catalogTables(payload).join(", "),
        semantic_catalog: semanticCatalogForSqlPrompt(payload),
        table_context: payload.table_context || [],
        retrieval_plan: payload.retrieval_plan || {},
        mandatory_context: mandatoryContextForStage(payload.mandatory_context, "sql_generation"),
        generation_scope: payload.generation_scope || null,
        rule_contract_feedback: payload.rule_contract_feedback || null,
        resolved_sql_resultsets: payload.resolved_sql_resultsets || []
      })
    }
  ];
}

function buildScopedResultSqlMessages(payload) {
  const schema = {
    answer: "short generation note",
    answer_type: "sql_needed | clarification_needed | no_evidence",
    decision: {
      intent: "detail_query | dimension_summary | metric_query | unknown",
      selected_metric_key: "string or null",
      selected_metric_keys: ["string"],
      selected_rule_keys: ["string"],
      confidence: 0.0,
      reason: "string"
    },
    sql_plan: [{ part: "SELECT | FROM | WHERE | GROUP BY | RULE", value: "string", source: "string", note: "string" }],
    applied_rule_keys: ["required rule key actually implemented"],
    not_applicable_rules: [{ key: "required rule key", reason: "explicit applicability condition not satisfied" }],
    result_title: "exact title for this result table",
    result_purpose: "short business purpose",
    display_formats: [{ column: "SQL result column name", format: "number | percent", display_scale: 1, suffix: "string", precision: 2 }],
    sql: "one read-only SELECT/WITH SQL",
    warnings: ["string"]
  };
  return [
    {
      role: "system",
      content: [
        "你是生产级 NL2SQL 的单结果集生成器。本次只生成 generation_scope 指定的一张表，不负责其他结果表或最终文字总结。",
        "必须落实 mandatory_context.stages.sql_generation 中 required=true 的规则正文，以及 mandatory_context.sql_filters。",
        "只能使用 table_context、semantic_catalog、retrieval_plan 和 resolved_sql_resultsets 中真实存在的表、字段和企业口径。",
        "generation_scope.expected_columns 是输出契约；规则正文给出更明确的字段、顺序、别名或粒度时，以规则正文为准。",
        "generation_scope.expected_column_bindings 是输出契约编译后又经后端真实表结构验证的逐列绑定，优先级高于规则正文中互相冲突的早期描述。source_field 非空时，对应位置的 SELECT 表达式必须引用该物理字段，并使用 output 作为结果列名；不得替换成名称相近的其他字段。",
        "生成 SQL 前必须按 position 从第一列到最后一列逐项读取 expected_column_bindings；生成后再次逐位自检 source_field 与 SELECT 表达式，尤其不能混淆名称相近的两个字段。",
        "source_field 为空表示该列需要按规则公式计算或仍需结合规则判断，不能因此编造不存在的物理字段。",
        "凡 SQL 使用 GROUP BY，所有用于区分结果行的分组维度都必须出现在 SELECT 中并使用业务别名；不得只输出聚合值。",
        "固定文字、统计日期、提醒和总结不属于 SQL。本次上下文已排除 renderer-only 规则，不得自行添加回答文案字段。",
        "用户输入公司、客户、供应商、项目等简称时，如果没有证据证明是完整枚举值，SQL 先使用安全包含匹配；后端还会基于数据库候选校准名称。",
        "每条 applied_rule_keys 必须在 SQL 中真实落实；不能只声明不执行。只有规则正文适用条件明确不成立时才能写 not_applicable_rules。",
        "如果 rule_contract_feedback 存在，必须逐条修复其中的 missing_rule_keys 或 violations，并返回完整新 SQL。",
        "SQL 必须是单条只读 SELECT 或 WITH，禁止多语句和写操作。不要使用 result_sets，也不要用 UNION 拼接其他表格。",
        "result_title 优先严格采用 generation_scope.output；result_purpose 采用 generation_scope.purpose。",
        "answer 只简述本张表的取数意图，不编造数据库结果。",
        `严格按 JSON schema 输出：${JSON.stringify(schema)}`,
        "只输出一个完整 JSON 对象，不要输出 Markdown、代码围栏或 JSON 之外的文字。"
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({
        question: payload.question,
        qa_config: payload.qa_config || null,
        data_source: payload.data_source || "",
        retrieval_plan: payload.retrieval_plan || {},
        generation_scope: payload.generation_scope || null,
        mandatory_context: mandatoryContextForStage(payload.mandatory_context, "sql_generation"),
        rule_contract_feedback: payload.rule_contract_feedback || null,
        semantic_catalog: semanticCatalogForSqlPrompt(payload),
        table_context: payload.table_context || [],
        resolved_sql_resultsets: payload.resolved_sql_resultsets || []
      })
    }
  ];
}

async function callScopedResultSqlModel(payload, options = {}) {
  const maxTokens = Number(options.maxTokens || 5200);
  try {
    return await callModelJson(
      buildScopedResultSqlMessages(payload),
      { temperature: Number(options.temperature ?? 0.02), maxTokens, timeoutMs: 55_000 }
    );
  } catch (error) {
    const retryPayload = {
      ...payload,
      generation_scope: {
        ...(payload.generation_scope || {}),
        retry_reason: error.message || String(error)
      }
    };
    let retried;
    try {
      retried = await callModelJson(
        buildScopedResultSqlMessages(retryPayload),
        { temperature: 0, maxTokens: Math.max(maxTokens, 5600), timeoutMs: 55_000 }
      );
    } catch (retryError) {
      const failure = new Error(
        `独立结果集 SQL 生成连续两次失败：首次 ${error.message || String(error)}；重试 ${retryError.message || String(retryError)}`
      );
      failure.cause = retryError;
      throw failure;
    }
    return {
      ...retried,
      usage: { initial_error: error.message || String(error), retry: retried.usage }
    };
  }
}

function requiredSqlGenerationRules(payload) {
  return (payload?.mandatory_context?.stages?.sql_generation || [])
    .filter(rule => rule?.required && rule?.key);
}

function explicitOrderedRuleColumns(content) {
  const sequences = [];
  let current = [];
  String(content || "").split(/\r?\n/).forEach(line => {
    const match = line.trim().match(/^(\d+)[.．、]\s*(.+)$/);
    if (!match) {
      if (current.length) sequences.push(current);
      current = [];
      return;
    }
    const number = Number(match[1]);
    const label = String(match[2] || "").split(/[，,]/, 1)[0].trim();
    if (number === 1) {
      if (current.length) sequences.push(current);
      current = label ? [label] : [];
      return;
    }
    if (current.length && number === current.length + 1 && label) {
      current.push(label);
      return;
    }
    if (current.length) sequences.push(current);
    current = [];
  });
  if (current.length) sequences.push(current);
  const longest = sequences.sort((left, right) => right.length - left.length)[0] || [];
  return longest.length >= 3 ? longest : [];
}

function enforceExplicitResultSetColumns(resultSet, requiredRuleByKey) {
  const candidates = (resultSet.rule_keys || [])
    .map(key => explicitOrderedRuleColumns(requiredRuleByKey.get(key)?.content))
    .filter(columns => columns.length)
    .sort((left, right) => right.length - left.length);
  const explicitColumns = candidates[0] || [];
  if (!explicitColumns.length) return resultSet;
  const sourceByOutput = new Map(
    (resultSet.output || []).map((output, index) => [
      normalizeCandidateText(output),
      String(resultSet.source_columns?.[index] || "").trim()
    ])
  );
  return {
    ...resultSet,
    output: explicitColumns,
    source_columns: explicitColumns.map(output => sourceByOutput.get(normalizeCandidateText(output)) || "")
  };
}

function normalizeIndependentOutputContract(data, payload) {
  const source = data && typeof data === "object" ? data : {};
  const requiredRules = requiredSqlGenerationRules(payload);
  const requiredKeys = new Set(requiredRules.map(rule => String(rule.key)));
  const requiredRuleByKey = new Map(requiredRules.map(rule => [String(rule.key), rule]));
  const resultSets = normalizeSemanticPlanResultSets(source.result_sets)
    .map((item, index) => ({
      ...item,
      key: item.key || `result_${index + 1}`,
      title: item.title || `查询结果 ${index + 1}`,
      rule_keys: item.rule_keys.filter(key => requiredKeys.has(key))
    }))
    .map(item => enforceExplicitResultSetColumns(item, requiredRuleByKey))
    .filter(item => item.rule_keys.length);
  const mappedKeys = new Set(resultSets.flatMap(item => item.rule_keys));
  const rendererOnlyRuleKeys = [...new Set((Array.isArray(source.renderer_only_rule_keys) ? source.renderer_only_rule_keys : [])
    .map(key => String(key || "").trim())
    .filter(key => requiredKeys.has(key) && !mappedKeys.has(key)))];
  const sharedSqlRuleKeys = [...new Set((Array.isArray(source.shared_sql_rule_keys) ? source.shared_sql_rule_keys : [])
    .map(key => String(key || "").trim())
    .filter(key => requiredKeys.has(key) && !mappedKeys.has(key) && !rendererOnlyRuleKeys.includes(key)))];
  const dispositioned = new Set([
    ...mappedKeys,
    ...rendererOnlyRuleKeys,
    ...sharedSqlRuleKeys
  ]);
  const missingRuleKeys = [...requiredKeys].filter(key => !dispositioned.has(key));
  const duplicateResultKeys = resultSets
    .flatMap(item => item.rule_keys)
    .filter((key, index, all) => all.indexOf(key) !== index);
  const useIndependentResultSets = source.use_independent_result_sets === true
    && resultSets.length >= 2
    && !missingRuleKeys.length
    && !duplicateResultKeys.length;
  return {
    use_independent_result_sets: useIndependentResultSets,
    result_sets: resultSets,
    renderer_only_rule_keys: rendererOnlyRuleKeys,
    shared_sql_rule_keys: sharedSqlRuleKeys,
    missing_rule_keys: missingRuleKeys,
    duplicate_result_rule_keys: [...new Set(duplicateResultKeys)],
    reason: String(source.reason || "").trim()
  };
}

function buildIndependentOutputContractMessages(payload) {
  const schema = {
    use_independent_result_sets: true,
    result_sets: [{
      key: "stable result identifier",
      title: "exact business table title",
      purpose: "what this table answers",
      rule_keys: ["required rule key defining this table"],
      output: ["required business columns in exact display order"],
      source_columns: ["physical table.field or field bound to the output at the same position; empty only for a calculated column"]
    }],
    renderer_only_rule_keys: ["required rule key that only constrains prose/date/reminder"],
    shared_sql_rule_keys: ["required rule key that affects SQL but does not define a separate table"],
    reason: "short classification conclusion"
  };
  const requiredRules = requiredSqlGenerationRules(payload);
  return [
    {
      role: "system",
      content: [
        "你是 NL2SQL 的输出契约编译器，只负责理解强制业务规则如何作用于结果，不生成 SQL。",
        "必须根据 required_rules 的正文语义分类，不能仅根据 injection_stages 或规则名称猜测。",
        "把每条 required rule 恰好归入三类之一：",
        "1. result_sets：正文明确要求一张独立表格/结果集，并定义了该表字段、字段顺序、粒度或用途。相同表格的多条规则应合并到一个 result_set。",
        "2. renderer_only_rule_keys：正文只要求固定文字、统计日期、提醒、总结或回答措辞，不要求 SQL 字段；即使 injection_stages 含 sql_generation，也归到这里。",
        "3. shared_sql_rule_keys：正文约束过滤、公式、字段含义或所有结果集共同 SQL 口径，但本身不定义一张新表。",
        "semantic_plan.output 是结果列清单，不是多张表清单。不要把列名拆成独立结果集。",
        "只有至少两张字段结构或业务粒度不同的独立表时，use_independent_result_sets 才为 true。",
        "所有 required rule key 都必须且只能被处置一次；不得新增不存在的 key。",
        "title 优先使用规则正文明确指定的表名，purpose 说明该表回答什么。",
        "result_sets.output 必须严格保留规则正文要求的业务列名和顺序。规则前文与末尾自检存在冲突时，以末尾明确字段映射和 table_context 的真实字段备注为准。",
        "每个 result_set 必须同时返回 source_columns，数量和顺序与 output 完全一致。物理字段必须逐字取自 table_context；存在同名字段时写 table.field。",
        "要根据业务列名、字段备注和规则口径理解真实映射，而不是只做字面匹配。若 table_context 已有语义等价字段，必须绑定它。",
        "source_columns 只有在规则正文为该业务列明确给出计算公式时才允许留空。不能因为列名含‘比例’‘金额’‘天数’就自行认定为计算列，也不能忽略字段备注中已有的预计算字段。",
        "聚合结果只要按问题中的业务维度 GROUP BY，就必须先在 output 中输出该维度，再输出度量，不能只输出聚合值而隐藏分组字段。",
        "问题明确询问项目、客户、公司、供应商等对象时，聚合结果必须选择该对象对应的真实维度；不得换成另一个名称字段。",
        "不要把两个含义不同的真实字段合并成同一业务列，也不要因为名称相似而重复同一个业务列。",
        `严格按 JSON schema 输出：${JSON.stringify(schema)}`,
        "只输出 JSON，不要输出 Markdown。"
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({
        question: payload.question,
        semantic_plan: payload?.retrieval_plan?.semantic_plan || {},
        planner_candidate_result_sets: payload?.retrieval_plan?.semantic_plan?.result_sets || [],
        target_tables: payload?.mandatory_context?.scoped_tables || [],
        table_context: tableContextForPlanner(payload?.table_context || []),
        required_rules: requiredRules.map(rule => ({
          key: rule.key,
          name: rule.name,
          tables: rule.tables,
          injection_stages: rule.injection_stages,
          content: rule.content
        }))
      })
    }
  ];
}

async function compileIndependentOutputContract(payload) {
  if (requiredSqlGenerationRules(payload).length < 2) return null;
  const response = await callModelJson(
    buildIndependentOutputContractMessages(payload),
    { temperature: 0, maxTokens: 4000, timeoutMs: 45_000 }
  );
  const normalized = normalizeIndependentOutputContract(response.data, payload);
  let resolution = null;
  let resolvedContract = normalized;
  if (normalized.use_independent_result_sets) {
    try {
      const resolved = await resolveIndependentOutputContractBindings(payload, normalized);
      resolution = {
        model: resolved.model,
        usage: resolved.usage,
        data: resolved.data,
        raw: resolved.raw
      };
      resolvedContract = applyIndependentOutputContractResolution(payload, normalized, resolved.data);
    } catch (error) {
      resolution = {
        error: error.message || String(error)
      };
    }
  }
  return {
    ...resolvedContract,
    model: response.model,
    usage: {
      contract: response.usage,
      binding_resolution: resolution?.usage || null
    },
    raw: response.raw,
    binding_resolution: resolution
  };
}

function physicalColumnsForBinding(payload) {
  return (payload?.table_context || []).flatMap(table => (
    (table?.columns || []).map(column => ({
      table: String(table?.table || "").trim(),
      qualified_table: String(table?.qualified_table || table?.table || "").trim(),
      field: String(column?.name || column || "").trim(),
      comment: String(column?.comment || "").trim()
    }))
  )).filter(column => column.field);
}

function resolveContractSourceColumn(columns, sourceColumn) {
  const raw = String(sourceColumn || "").trim().replace(/[`"']/g, "");
  if (!raw) return null;
  const parts = raw.split(".").map(part => part.trim()).filter(Boolean);
  const field = parts.pop() || "";
  const tableHint = parts.join(".");
  const matches = columns.filter(column => {
    if (column.field.toLowerCase() !== field.toLowerCase()) return false;
    if (!tableHint) return true;
    const hint = tableHint.toLowerCase();
    return column.table.toLowerCase() === hint
      || column.qualified_table.toLowerCase() === hint
      || column.qualified_table.toLowerCase().endsWith(`.${hint}`);
  });
  return matches.length === 1 ? matches[0] : null;
}

function buildIndependentOutputBindingMessages(payload, contract) {
  const schema = {
    bindings: [{
      result_key: "existing result key",
      position: 1,
      output: "existing business output name",
      binding_type: "physical | calculated",
      source_column: "exact table.field or field when physical; empty when calculated",
      reason: "short semantic evidence"
    }],
    group_dimensions: [{
      result_key: "existing aggregate result key",
      columns: [{
        output: "business dimension display name",
        source_column: "exact table.field or field"
      }]
    }],
    scope_overrides: [{
      result_key: "existing result key",
      excluded_filters: ["exact semantic_plan filter forbidden by this result rule"],
      excluded_rule_keys: ["existing non-required supporting rule key conflicting with this result rule"],
      reason: "short conflict evidence"
    }]
  };
  const allColumns = physicalColumnsForBinding(payload);
  const candidateGroups = unresolvedBindingCandidates(payload, contract);
  const plannedDimensions = plannedGroupDimensionColumns(payload);
  const focusedKeys = new Set([
    ...candidateGroups.flatMap(group => group.candidates.map(candidate => (
      `${candidate.table.toLowerCase()}.${candidate.field.toLowerCase()}`
    ))),
    ...plannedDimensions.map(dimension => (
      `${dimension.table.toLowerCase()}.${dimension.field.toLowerCase()}`
    ))
  ]);
  const tableSchema = allColumns
    .filter(column => focusedKeys.has(
      `${(column.qualified_table || column.table).toLowerCase()}.${column.field.toLowerCase()}`
    ))
    .map(column => ({
    table: column.qualified_table || column.table,
    field: column.field,
    comment: column.comment
    }));
  return [
    {
      role: "system",
      content: [
        "你是 NL2SQL 输出契约的物理字段绑定校验器，只解决未绑定业务列和聚合分组维度，不生成 SQL。",
        "所有 source_column 必须逐字来自 table_schema，不能编造。",
        "bindings 只返回 contract.result_sets 中 source_columns 为空的位置，position 从 1 开始并与 output 同序。",
        "结合业务列名、规则口径和字段备注判断 physical 或 calculated。若字段备注存在语义等价的预计算字段，且规则没有为该列明确给出计算公式，必须选择 physical。",
        "binding_candidates 是后端从真实字段备注检索出的高相关候选，优先逐项比较其业务含义；不能在候选中已有等价字段时声称‘没有对应物理字段’。",
        "只有规则正文明确给出该业务列的计算公式时才可选择 calculated；列名含‘比例’‘金额’‘天数’本身不构成计算公式。",
        "group_dimensions 只处理聚合结果。根据 question、semantic_plan.dimensions 和 coverage_checklist 判断用户真正询问的对象维度；仅用于 WHERE 过滤的主体不是分组输出维度。",
        "聚合结果必须列出所有用于区分结果行的业务维度，维度应位于聚合度量之前。",
        "scope_overrides 用于解决高优先级结果规则与全局语义计划的冲突。若结果规则明确禁止某个 semantic_plan.filters 条件，必须原样列入 excluded_filters；若某条非必选 supporting rule 正是冲突条件的来源，同时列入 excluded_rule_keys。",
        "只有规则正文能直接证明冲突时才排除；不得为了得到更多数据而擅自删除过滤。",
        "明细结果不需要填写 group_dimensions。不得修改已有结果集 key、业务列清单或已绑定字段。",
        `严格按 JSON schema 输出：${JSON.stringify(schema)}`,
        "只输出 JSON，不要输出 Markdown。"
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({
        question: payload.question,
        semantic_plan: payload?.retrieval_plan?.semantic_plan || {},
        coverage_checklist: payload?.retrieval_plan?.coverage_checklist || [],
        result_sets: contract.result_sets,
        binding_candidates: candidateGroups,
        required_rules: requiredSqlGenerationRules(payload).map(rule => ({
          key: rule.key,
          content: rule.content
        })),
        supporting_rules: (payload?.mandatory_context?.stages?.sql_generation || [])
          .filter(rule => !rule?.required)
          .map(rule => ({ key: rule.key, content: rule.content })),
        table_schema: tableSchema
      })
    }
  ];
}

function unresolvedBindingCandidates(payload, contract) {
  const columns = physicalColumnsForBinding(payload);
  return (contract?.result_sets || []).flatMap(resultSet => (
    (resultSet.output || []).flatMap((output, index) => {
      if (String(resultSet.source_columns?.[index] || "").trim()) return [];
      const candidates = columns
        .map(column => ({
          table: column.qualified_table || column.table,
          field: column.field,
          comment: column.comment,
          score: Math.max(
            scoreCandidateValue(output, column.comment),
            scoreCandidateValue(output, column.field)
          )
        }))
        .filter(candidate => candidate.score >= 0.18)
        .sort((left, right) => right.score - left.score)
        .slice(0, 12);
      return [{
        result_key: resultSet.key,
        position: index + 1,
        output,
        candidates
      }];
    })
  ));
}

function resolveSemanticColumnReference(columns, reference) {
  const direct = resolveContractSourceColumn(columns, reference);
  if (direct) return direct;
  const key = normalizeCandidateText(reference);
  const commentMatches = columns.filter(column => normalizeCandidateText(column.comment) === key);
  return commentMatches.length === 1 ? commentMatches[0] : null;
}

function sourceColumnFieldKey(value) {
  return String(value || "")
    .replace(/[`"']/g, "")
    .split(".")
    .filter(Boolean)
    .pop()
    ?.toLowerCase() || "";
}

function semanticRuleDimensionColumns(payload, columns, filterIdentifiers) {
  const question = normalizeCandidateText(payload?.question);
  const selectedRuleKeys = new Set(
    (payload?.retrieval_plan?.selected_rule_keys || [])
      .map(key => String(key || "").trim())
      .filter(Boolean)
  );
  const checklist = Array.isArray(payload?.retrieval_plan?.coverage_checklist)
    ? payload.retrieval_plan.coverage_checklist
    : [];
  const dimensionItemTypes = new Set(["dimension", "output", "object"]);
  const rulesByKey = new Map();
  ["planner_policy", "sql_generation"].forEach(stage => {
    (payload?.mandatory_context?.stages?.[stage] || []).forEach(rule => {
      const key = String(rule?.key || "").trim();
      if (!key || rule?.required || rulesByKey.has(key)) return;
      rulesByKey.set(key, rule);
    });
  });

  const resolved = [];
  rulesByKey.forEach((rule, key) => {
    if (!selectedRuleKeys.has(key)) return;
    const terms = [rule?.key, rule?.name]
      .flatMap(value => String(value || "").split(/[\/／|、，,\s]+/))
      .map(normalizeCandidateText)
      .filter(term => term.length >= 2);
    const matchedByQuestion = terms.some(term => question.includes(term));
    const matchedByChecklist = checklist.some(item => (
      String(item?.evidence_key || "").trim() === key
      && dimensionItemTypes.has(String(item?.item_type || "").toLowerCase())
    ));
    if (!matchedByQuestion && !matchedByChecklist) return;

    const identifiers = sqlExpressionIdentifiers(rule?.content || "");
    const candidates = columns.filter(column => (
      identifiers.has(column.field.toLowerCase())
      && !filterIdentifiers.has(column.field.toLowerCase())
    ));
    if (candidates.length !== 1) return;
    const candidate = candidates[0];
    resolved.push({
      table: candidate.qualified_table || candidate.table,
      field: candidate.field,
      output: candidate.comment || candidate.field
    });
  });

  return resolved.filter((item, index, all) => (
    all.findIndex(other => (
      other.table.toLowerCase() === item.table.toLowerCase()
      && other.field.toLowerCase() === item.field.toLowerCase()
    )) === index
  ));
}

function plannedGroupDimensionColumns(payload) {
  const columns = physicalColumnsForBinding(payload);
  const semanticPlan = payload?.retrieval_plan?.semantic_plan || {};
  const filterIdentifiers = new Set(
    (Array.isArray(semanticPlan.filters) ? semanticPlan.filters : [])
      .flatMap(filter => [...sqlExpressionIdentifiers(
        typeof filter === "string" ? filter : JSON.stringify(filter)
      )])
  );
  const ruleDimensions = semanticRuleDimensionColumns(payload, columns, filterIdentifiers);
  if (ruleDimensions.length) return ruleDimensions;
  const dimensions = (Array.isArray(semanticPlan.dimensions) ? semanticPlan.dimensions : [])
    .map(reference => resolveSemanticColumnReference(columns, reference))
    .filter(Boolean);
  const checklistFields = new Set(
    (Array.isArray(payload?.retrieval_plan?.coverage_checklist)
      ? payload.retrieval_plan.coverage_checklist
      : [])
      .filter(item => String(item?.item_type || "").toLowerCase() === "output")
      .flatMap(item => {
        const texts = [item?.evidence_key, item?.item, item?.note].filter(Boolean).map(String);
        return texts.flatMap(text => {
          const direct = resolveSemanticColumnReference(columns, text);
          const identifiers = [...sqlExpressionIdentifiers(text)]
            .map(identifier => resolveSemanticColumnReference(columns, identifier))
            .filter(Boolean);
          return [direct, ...identifiers].filter(Boolean).map(column => column.field.toLowerCase());
        });
      })
  );
  const unfilteredDimensions = dimensions
    .filter(column => !filterIdentifiers.has(column.field.toLowerCase()));
  const requestedDimensions = checklistFields.size
    ? unfilteredDimensions.filter(column => checklistFields.has(column.field.toLowerCase()))
    : unfilteredDimensions.length <= 3
      ? unfilteredDimensions
      : [];
  return requestedDimensions
    .map(column => ({
      table: column.qualified_table || column.table,
      field: column.field,
      output: column.comment || column.field
    }));
}

async function resolveIndependentOutputContractBindings(payload, contract) {
  const response = await callModelJson(
    buildIndependentOutputBindingMessages(payload, contract),
    { temperature: 0, maxTokens: 2200, timeoutMs: 40_000 }
  );
  return {
    model: response.model,
    usage: response.usage,
    data: response.data && typeof response.data === "object" ? response.data : {},
    raw: response.raw
  };
}

function applyIndependentOutputContractResolution(payload, contract, resolution) {
  const columns = physicalColumnsForBinding(payload);
  const plannedDimensions = plannedGroupDimensionColumns(payload);
  const plannedDimensionFields = new Set(plannedDimensions.map(item => item.field.toLowerCase()));
  const bindingItems = Array.isArray(resolution?.bindings) ? resolution.bindings : [];
  const dimensionItems = Array.isArray(resolution?.group_dimensions) ? resolution.group_dimensions : [];
  const overrideItems = Array.isArray(resolution?.scope_overrides) ? resolution.scope_overrides : [];
  const semanticFilters = Array.isArray(payload?.retrieval_plan?.semantic_plan?.filters)
    ? payload.retrieval_plan.semantic_plan.filters
    : [];
  const supportingRuleKeys = new Set(
    (payload?.mandatory_context?.stages?.sql_generation || [])
      .filter(rule => !rule?.required)
      .map(rule => String(rule.key || ""))
  );
  const resultSets = contract.result_sets.map(resultSet => {
    const output = [...(resultSet.output || [])];
    const sourceColumns = output.map((_, index) => String(resultSet.source_columns?.[index] || "").trim());
    const matchesResult = item => {
      const key = String(item?.result_key || "").trim();
      return key && (key === resultSet.key || key === resultSet.title);
    };
    bindingItems.filter(matchesResult).forEach(item => {
      const position = Number(item?.position || 0) - 1;
      if (position < 0 || position >= output.length || sourceColumns[position]) return;
      if (normalizeCandidateText(item?.output) !== normalizeCandidateText(output[position])) return;
      if (String(item?.binding_type || "").toLowerCase() !== "physical") return;
      const candidate = resolveContractSourceColumn(columns, item?.source_column);
      if (candidate) sourceColumns[position] = candidate.field;
    });
    const dimensionEntry = dimensionItems.find(matchesResult);
    const overrideEntry = overrideItems.find(matchesResult);
    const modelDimensions = (Array.isArray(dimensionEntry?.columns) ? dimensionEntry.columns : [])
      .map(item => {
        const candidate = resolveContractSourceColumn(columns, item?.source_column);
        if (!candidate) return null;
        return {
          output: String(item?.output || candidate.comment || candidate.field).trim(),
          source_column: candidate.field
        };
      })
      .filter(Boolean)
      .filter((item, index, all) => (
        all.findIndex(other => other.source_column.toLowerCase() === item.source_column.toLowerCase()) === index
      ));
    const requestedDimensions = dimensionEntry && plannedDimensions.length
      ? plannedDimensions.map(item => ({
          output: item.output,
          source_column: item.field
        }))
      : modelDimensions;
    const supersededModelDimensionFields = new Set(
      modelDimensions
        .map(item => sourceColumnFieldKey(item.source_column))
        .filter(field => field && !plannedDimensionFields.has(field))
    );
    if (dimensionEntry && supersededModelDimensionFields.size) {
      for (let index = sourceColumns.length - 1; index >= 0; index -= 1) {
        if (!supersededModelDimensionFields.has(sourceColumnFieldKey(sourceColumns[index]))) continue;
        sourceColumns.splice(index, 1);
        output.splice(index, 1);
      }
    }
    const dimensions = requestedDimensions
      .filter(item => !sourceColumns.some(source => (
        sourceColumnFieldKey(source) === sourceColumnFieldKey(item.source_column)
      )));
    if (dimensions.length) {
      output.unshift(...dimensions.map(item => item.output));
      sourceColumns.unshift(...dimensions.map(item => item.source_column));
    }
    const excludedFilters = (Array.isArray(overrideEntry?.excluded_filters)
      ? overrideEntry.excluded_filters
      : [])
      .map(filter => String(filter || "").trim())
      .filter(filter => semanticFilters.some(candidate => (
        normalizeCandidateText(typeof candidate === "string" ? candidate : JSON.stringify(candidate))
        === normalizeCandidateText(filter)
      )));
    const excludedRuleKeys = (Array.isArray(overrideEntry?.excluded_rule_keys)
      ? overrideEntry.excluded_rule_keys
      : [])
      .map(key => String(key || "").trim())
      .filter(key => supportingRuleKeys.has(key));
    return {
      ...resultSet,
      output,
      source_columns: sourceColumns,
      excluded_filters: excludedFilters,
      excluded_rule_keys: excludedRuleKeys
    };
  });
  return {
    ...contract,
    result_sets: resultSets
  };
}

function expectedColumnBindings(payload, expectedColumns = [], contractSourceColumns = []) {
  const columns = physicalColumnsForBinding(payload);
  return (expectedColumns || []).map((output, index) => {
    const name = String(output || "").trim();
    const key = normalizeCandidateText(name);
    const fieldMatches = columns.filter(column => normalizeCandidateText(column.field) === key);
    const commentMatches = columns.filter(column => normalizeCandidateText(column.comment) === key);
    const exactCandidate = fieldMatches.length === 1
      ? fieldMatches[0]
      : commentMatches.length === 1
        ? commentMatches[0]
        : null;
    const contractSource = String(contractSourceColumns[index] || "").trim();
    const contractCandidate = exactCandidate
      ? null
      : resolveContractSourceColumn(columns, contractSource);
    const candidate = exactCandidate || contractCandidate;
    return {
      position: index + 1,
      output: name,
      source_table: candidate?.qualified_table || candidate?.table || "",
      source_field: candidate?.field || "",
      source_comment: candidate?.comment || "",
      contract_source: contractSource,
      match_type: candidate
        ? exactCandidate
          ? fieldMatches.length === 1 ? "field_exact" : "comment_exact"
          : "semantic_contract"
        : "unresolved"
    };
  });
}

function independentOutputRuleScopes(contract, payload = null) {
  if (!contract?.use_independent_result_sets) return [];
  return contract.result_sets.map((resultSet, outputIndex) => ({
    ...resultSet,
    expected_columns: resultSet.output || [],
    expected_column_bindings: expectedColumnBindings(
      payload,
      resultSet.output || [],
      resultSet.source_columns || []
    ),
    output: resultSet.title,
    outputIndex
  }));
}

function mandatoryContextForOutput(context, scope, contract) {
  const stageRules = Array.isArray(context?.stages?.sql_generation)
    ? context.stages.sql_generation
    : [];
  const excludedRuleKeys = new Set(scope?.excluded_rule_keys || []);
  const requiredKeys = new Set([
    ...(scope.rule_keys || []),
    ...(contract?.shared_sql_rule_keys || [])
  ]);
  const rules = stageRules.filter(rule => (
    (!rule.required || requiredKeys.has(rule.key))
    && (rule.required || !excludedRuleKeys.has(rule.key))
  ));
  return {
    enabled: true,
    scoped_tables: context?.scoped_tables || [],
    rule_keys: rules.map(rule => rule.key),
    required_rule_keys: [...requiredKeys],
    required_stage_rule_keys: { sql_generation: [...requiredKeys] },
    stages: { sql_generation: rules },
    sql_filters: context?.sql_filters || [],
    warnings: context?.warnings || []
  };
}

function buildSqlRuleAuditMessages({ payload, scope, context, generated }) {
  const schema = {
    ok: true,
    applied_rule_keys: ["rule key actually satisfied"],
    violations: [{
      category: "field_structure | filter | formula | aggregation | other",
      rule_key: "string",
      predicate: "exact offending WHERE predicate when category=filter, otherwise empty",
      evidence_quote: "short exact quote from the rule proving the violation",
      issue: "specific mismatch",
      correction: "concrete correction"
    }],
    corrected_sql: "empty when ok=true; otherwise one complete corrected read-only SELECT/WITH SQL",
    reason: "short audit conclusion"
  };
  return [
    {
      role: "system",
      content: [
        "你是独立的 SQL 业务规则审计器，不负责生成查询结果。",
        "逐条比较 required_rules 正文、generation_scope 和 generated_sql 的实际语义；不要相信生成器自己声明的 applied_rule_keys。",
        "检查过滤符号、例外条件、聚合粒度、字段数量、字段顺序、别名、公式和禁止项是否真实一致。",
        "generation_scope.expected_column_bindings 已由后端对照真实表结构验证。source_field 非空时，它是对应 SELECT 位置的最终物理字段契约，优先于规则正文中互相冲突的描述；发现不一致必须在 corrected_sql 修正。",
        "字段数量、顺序、别名和物理字段绑定由后端结构契约唯一负责。不得用 required_rules 中冲突的早期描述推翻 generation_scope.expected_columns 或 expected_column_bindings。",
        "对于 source_field 为空的展示列，也要结合业务别名和 table_context 字段备注判断是否存在语义等价的物理字段。规则没有明确计算公式时，不得擅自用其他字段拼公式替代已有物理字段。",
        "修正 SQL 时必须保持 generation_scope.expected_columns 的数量、顺序和业务别名。",
        "每条 violation 必须填写 category。字段数量、顺序、别名或物理字段争议归为 field_structure；WHERE 条件归为 filter；计算表达式归为 formula；GROUP BY 或聚合函数归为 aggregation。",
        "filter violation 必须在 predicate 填写 SQL 中原样出现的单个 WHERE 条件，并在 evidence_quote 填写规则正文中能直接证明禁止该条件的原文。不得把规则未禁止的其他过滤一起判错。",
        "规则与语义计划冲突时以高优先级规则正文为准。",
        "只审计 required_rules 正文明示的 SQL 要求。不得从用户问题、表中其他字段、样例是否为空或业务常识推导额外字段、过滤条件、完整性要求或固定文案。",
        "用户问题、semantic_plan 和 supporting_rules 用于证明 SQL 中额外过滤或字段的合法来源。只要它们与 required_rules 不冲突，就不得以‘强制规则未要求’为由判错。",
        "只有 required_rules 明确写了禁止、不得、严禁、不增加或给出排他性条件时，才能把额外字段/过滤判为违规；规则仅给出一种筛选方式不等于禁止其他由用户问题要求的筛选。",
        "不得根据样例值为空、字段类型推测、数据质量或可能无结果来否定 SQL；这些不属于强制规则审计。",
        "固定文字、统计日期、提醒和总结属于回答层，不得要求它们出现在 SQL 或结果列中。",
        "业务名称过滤使用哪个字段已由上游语义计划和规则决定；除非 required_rules 明确要求其他字段，否则不要因为样例为空而否定该字段。",
        "如果确认存在违规，ok=false，并在 corrected_sql 直接返回一条已修复全部 violations 的完整只读 SQL；必须保留用户问题、semantic_plan 和 supporting_rules 要求的合法过滤。",
        "如果不存在能由 required_rules 正文直接证明的违规，ok=true 且 corrected_sql 为空。不要提出不影响规则符合性的建议。",
        `严格按 JSON schema 输出：${JSON.stringify(schema)}`,
        "只输出 JSON，不要输出 Markdown。"
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({
        question: payload.question,
        semantic_plan: payload?.retrieval_plan?.semantic_plan || {},
        generation_scope: payload.generation_scope || {
          output: scope.output,
          rule_keys: scope.rule_keys || []
        },
        required_rules: context.stages?.sql_generation?.filter(rule => rule.required) || [],
        supporting_rules: context.stages?.sql_generation?.filter(rule => !rule.required) || [],
        table_context: tableContextForPlanner(payload.table_context || []),
        generated_sql: generated.sql,
        generated_applied_rule_keys: generated.applied_rule_keys || []
      })
    }
  ];
}

async function auditSqlRuleCompliance(payload, scope, context, generated) {
  const response = await callModelJson(
    buildSqlRuleAuditMessages({ payload, scope, context, generated }),
    { temperature: 0, maxTokens: 3200, timeoutMs: 45_000 }
  );
  const data = response.data && typeof response.data === "object" ? response.data : {};
  const violations = (Array.isArray(data.violations) ? data.violations : [])
    .map(item => ({
      category: String(item?.category || "other").trim(),
      rule_key: String(item?.rule_key || "").trim(),
      predicate: String(item?.predicate || "").trim(),
      evidence_quote: String(item?.evidence_quote || "").trim(),
      issue: String(item?.issue || "").trim(),
      correction: String(item?.correction || "").trim()
    }))
    .filter(item => item.rule_key || item.issue);
  return {
    ok: data.ok === true && !violations.length,
    applied_rule_keys: Array.isArray(data.applied_rule_keys) ? data.applied_rule_keys.map(String) : [],
    violations,
    corrected_sql: looksLikeExecutableSelectSql(data.corrected_sql) ? normalizeSql(data.corrected_sql) : "",
    reason: String(data.reason || "").trim(),
    model: response.model,
    usage: response.usage
  };
}

function modelCallWasAborted(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return error?.name === "AbortError"
    || message.includes("aborted")
    || message.includes("abort")
    || message.includes("timeout")
    || message.includes("超时");
}

function topLevelSelectExpressions(sql) {
  const value = String(sql || "");
  let depth = 0;
  let quote = "";
  let selectStart = -1;
  let fromStart = -1;
  const isWordBoundary = char => !char || !/[A-Za-z0-9_$]/.test(char);
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote) {
        if (value[index + 1] === quote && quote !== "`") {
          index += 1;
        } else {
          quote = "";
        }
      } else if (char === "\\" && quote !== "`") {
        index += 1;
      }
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) continue;
    const remaining = value.slice(index);
    if (
      selectStart < 0
      && remaining.slice(0, 6).toUpperCase() === "SELECT"
      && isWordBoundary(value[index - 1])
      && isWordBoundary(value[index + 6])
    ) {
      selectStart = index + 6;
      index += 5;
      continue;
    }
    if (
      selectStart >= 0
      && remaining.slice(0, 4).toUpperCase() === "FROM"
      && isWordBoundary(value[index - 1])
      && isWordBoundary(value[index + 4])
    ) {
      fromStart = index;
      break;
    }
  }
  if (selectStart < 0 || fromStart <= selectStart) return [];
  const projection = value.slice(selectStart, fromStart);
  const expressions = [];
  let expressionStart = 0;
  depth = 0;
  quote = "";
  for (let index = 0; index < projection.length; index += 1) {
    const char = projection[index];
    if (quote) {
      if (char === quote) {
        if (projection[index + 1] === quote && quote !== "`") {
          index += 1;
        } else {
          quote = "";
        }
      } else if (char === "\\" && quote !== "`") {
        index += 1;
      }
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === "," && depth === 0) {
      expressions.push(projection.slice(expressionStart, index).trim());
      expressionStart = index + 1;
    }
  }
  expressions.push(projection.slice(expressionStart).trim());
  return expressions.filter(Boolean);
}

function topLevelSelectProjectionRange(sql) {
  const value = String(sql || "");
  let depth = 0;
  let quote = "";
  let selectStart = -1;
  const isBoundary = char => !char || !/[A-Za-z0-9_$]/.test(char);
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote) {
        if (value[index + 1] === quote && quote !== "`") index += 1;
        else quote = "";
      } else if (char === "\\" && quote !== "`") {
        index += 1;
      }
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) continue;
    const remaining = value.slice(index);
    if (
      selectStart < 0
      && remaining.slice(0, 6).toUpperCase() === "SELECT"
      && isBoundary(value[index - 1])
      && isBoundary(value[index + 6])
    ) {
      selectStart = index + 6;
      index += 5;
      continue;
    }
    if (
      selectStart >= 0
      && remaining.slice(0, 4).toUpperCase() === "FROM"
      && isBoundary(value[index - 1])
      && isBoundary(value[index + 4])
    ) {
      return {
        start: selectStart,
        end: index,
        expressions: splitTopLevelSqlExpressions(value.slice(selectStart, index))
      };
    }
  }
  return null;
}

function quoteSqlIdentifier(value) {
  return `\`${String(value || "").replace(/`/g, "``")}\``;
}

function enforceExpectedPhysicalBindings(scope, sql) {
  const range = topLevelSelectProjectionRange(sql);
  if (!range) return { sql: String(sql || ""), changes: [] };
  const expressions = [...range.expressions];
  const aliases = sqlAliasSummary(sql);
  const changes = [];
  (scope?.expected_column_bindings || [])
    .filter(binding => binding?.source_field)
    .forEach(binding => {
      const position = Number(binding.position || 0) - 1;
      const expression = expressions[position] || "";
      if (!expression) return;
      const expectedField = String(binding.source_field || "").trim();
      const identifiers = sqlExpressionIdentifiers(expression);
      const aliasMatches = normalizeCandidateText(aliases[position]) === normalizeCandidateText(binding.output);
      if (identifiers.has(expectedField.toLowerCase()) && aliasMatches) return;
      if (identifiers.has(expectedField.toLowerCase())) return;
      const distinctPrefix = position === 0 && /^\s*DISTINCT\b/i.test(expression) ? "DISTINCT " : "";
      expressions[position] = `${distinctPrefix}${quoteSqlIdentifier(expectedField)} AS ${quoteSqlIdentifier(binding.output)}`;
      changes.push({
        position: position + 1,
        output: binding.output,
        expected_field: expectedField,
        previous_expression: expression,
        corrected_expression: expressions[position]
      });
    });
  if (!changes.length) return { sql: String(sql || ""), changes };
  return {
    sql: `${String(sql || "").slice(0, range.start)}\n  ${expressions.join(",\n  ")}\n${String(sql || "").slice(range.end)}`,
    changes
  };
}

function topLevelKeywordEndAt(sql, index, words) {
  const isBoundary = char => !char || !/[A-Za-z0-9_$]/.test(char);
  let cursor = index;
  for (let wordIndex = 0; wordIndex < words.length; wordIndex += 1) {
    if (wordIndex > 0) {
      if (!/\s/.test(sql[cursor] || "")) return -1;
      while (/\s/.test(sql[cursor] || "")) cursor += 1;
    }
    const word = words[wordIndex];
    if (sql.slice(cursor, cursor + word.length).toUpperCase() !== word) return -1;
    if (!isBoundary(sql[cursor - 1]) || !isBoundary(sql[cursor + word.length])) return -1;
    cursor += word.length;
  }
  return cursor;
}

function findTopLevelSqlKeyword(sql, words, startIndex = 0) {
  const value = String(sql || "");
  let depth = 0;
  let quote = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote) {
        if (value[index + 1] === quote && quote !== "`") index += 1;
        else quote = "";
      } else if (char === "\\" && quote !== "`") {
        index += 1;
      }
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0 || index < startIndex) continue;
    const end = topLevelKeywordEndAt(value, index, words);
    if (end >= 0) return { start: index, end };
  }
  return null;
}

function splitTopLevelSqlExpressions(value) {
  const source = String(value || "");
  const expressions = [];
  let expressionStart = 0;
  let depth = 0;
  let quote = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === quote) {
        if (source[index + 1] === quote && quote !== "`") index += 1;
        else quote = "";
      } else if (char === "\\" && quote !== "`") {
        index += 1;
      }
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === "," && depth === 0) {
      expressions.push(source.slice(expressionStart, index).trim());
      expressionStart = index + 1;
    }
  }
  expressions.push(source.slice(expressionStart).trim());
  return expressions.filter(Boolean);
}

function topLevelGroupByExpressions(sql) {
  const value = String(sql || "");
  const groupBy = findTopLevelSqlKeyword(value, ["GROUP", "BY"]);
  if (!groupBy) return [];
  const clauseEndKeywords = [
    ["HAVING"],
    ["ORDER", "BY"],
    ["LIMIT"],
    ["UNION"],
    ["WINDOW"],
    ["FOR"]
  ];
  const clauseEnd = clauseEndKeywords
    .map(words => findTopLevelSqlKeyword(value, words, groupBy.end))
    .filter(Boolean)
    .sort((left, right) => left.start - right.start)[0];
  return splitTopLevelSqlExpressions(
    value.slice(groupBy.end, clauseEnd?.start ?? value.length).replace(/;\s*$/, "")
  );
}

function groupByProjectionCoverage(sql, selectExpressions, selectAliases) {
  const groupByExpressions = topLevelGroupByExpressions(sql);
  const selectedIdentifiers = selectExpressions.map(sqlExpressionIdentifiers);
  const aliasKeys = new Set((selectAliases || []).map(normalizeCandidateText).filter(Boolean));
  const missing = groupByExpressions.filter(expression => {
    const normalized = String(expression || "").replace(/`/g, "").trim();
    if (/^\d+$/.test(normalized)) return false;
    if (aliasKeys.has(normalizeCandidateText(normalized))) return false;
    const simpleField = normalized.match(/^(?:[A-Za-z_][A-Za-z0-9_$]*\.)*([A-Za-z_][A-Za-z0-9_$]*)$/);
    if (!simpleField) return false;
    const field = simpleField[1].toLowerCase();
    return !selectedIdentifiers.some(identifiers => identifiers.has(field));
  });
  return {
    expressions: groupByExpressions,
    missing,
    ok: !missing.length
  };
}

function sqlExpressionIdentifiers(expression) {
  return new Set(
    (String(expression || "")
      .replace(/`([^`]+)`/g, "$1")
      .match(/[A-Za-z_][A-Za-z0-9_$]*/g) || [])
      .map(identifier => identifier.toLowerCase())
  );
}

function scopedResultStructureCoverage(scope, generated) {
  const expected = (scope?.expected_columns || [])
    .map(value => String(value || "").trim())
    .filter(Boolean);
  const actual = sqlAliasSummary(generated?.sql);
  const expressions = topLevelSelectExpressions(generated?.sql);
  const expectedUnique = [];
  const expectedKeys = new Set();
  expected.forEach(column => {
    const key = normalizeCandidateText(column);
    if (!key || expectedKeys.has(key)) return;
    expectedKeys.add(key);
    expectedUnique.push({ column, key });
  });
  const actualItems = actual.map(column => ({
    column,
    key: normalizeCandidateText(column)
  }));
  const missing = expectedUnique
    .filter(expectedColumn => !actualItems.some(actualColumn => actualColumn.key === expectedColumn.key))
    .map(item => item.column);
  let previousIndex = -1;
  const outOfOrder = [];
  expectedUnique.forEach(expectedColumn => {
    const index = actualItems.findIndex(actualColumn => actualColumn.key === expectedColumn.key);
    if (index < 0) return;
    if (index < previousIndex) outOfOrder.push(expectedColumn.column);
    previousIndex = Math.max(previousIndex, index);
  });
  const minimumColumns = expectedUnique.length;
  const maximumColumns = expected.length || actual.length;
  const actualCount = expressions.length || actual.length;
  const groupByProjection = groupByProjectionCoverage(generated?.sql, expressions, actual);
  const columnCountOk = !expected.length
    ? actualCount > 0
    : actualCount === expected.length;
  const bindingMismatches = (scope?.expected_column_bindings || [])
    .filter(binding => binding?.source_field)
    .map(binding => {
      const expression = expressions[Number(binding.position || 0) - 1] || "";
      const identifiers = sqlExpressionIdentifiers(expression);
      return identifiers.has(String(binding.source_field).toLowerCase())
        ? null
        : {
            position: binding.position,
            output: binding.output,
            expected_field: binding.source_field,
            actual_expression: expression
          };
    })
    .filter(Boolean);
  const executable = looksLikeExecutableSelectSql(generated?.sql);
  return {
    ok: executable
      && columnCountOk
      && !bindingMismatches.length
      && !missing.length
      && !outOfOrder.length
      && groupByProjection.ok,
    executable,
    expected,
    actual,
    expressions,
    expected_count: expected.length,
    actual_count: actualCount,
    missing,
    out_of_order: outOfOrder,
    column_count_ok: columnCountOk,
    binding_contract_ok: !bindingMismatches.length,
    binding_mismatches: bindingMismatches,
    group_by_expressions: groupByProjection.expressions,
    group_by_projection_ok: groupByProjection.ok,
    missing_group_by_projections: groupByProjection.missing,
    label_contract_ok: !missing.length && !outOfOrder.length,
    minimum_alias_count: minimumColumns,
    maximum_alias_count: maximumColumns
  };
}

function scopedResultFailure(scope, stage, error, detail = null) {
  const message = error?.message || String(error);
  const failure = new Error(`结果集“${scope?.output || scope?.title || scope?.key || "未命名"}”${stage}失败：${message}`);
  failure.cause = error;
  failure.result_set_key = scope?.key || "";
  failure.result_set_title = scope?.output || scope?.title || "";
  failure.result_set_stage = stage;
  failure.detail = detail;
  return failure;
}

function rejectedScopeFiltersFromFailure(previousFailure, payload) {
  const semanticFilters = Array.isArray(payload?.retrieval_plan?.semantic_plan?.filters)
    ? payload.retrieval_plan.semantic_plan.filters
    : [];
  const violations = previousFailure?.detail?.audit?.violations || [];
  return semanticFilters.filter(filter => {
    const filterText = typeof filter === "string" ? filter : JSON.stringify(filter);
    const filterKey = normalizeCandidateText(filterText);
    return violations.some(violation => {
      if (violation?.category !== "filter") return false;
      const predicateKey = normalizeCandidateText(violation.predicate);
      const issueKey = normalizeCandidateText(violation.issue);
      return (predicateKey && predicateKey === filterKey)
        || (filterKey && issueKey.includes(filterKey));
    });
  });
}

function supportingRuleKeysForRejectedFilters(payload, rejectedFilters) {
  if (!rejectedFilters.length) return [];
  const filterIdentifiers = new Set(
    rejectedFilters.flatMap(filter => [...sqlExpressionIdentifiers(
      typeof filter === "string" ? filter : JSON.stringify(filter)
    )])
  );
  const supportingRuleKeys = new Set(
    (payload?.mandatory_context?.stages?.sql_generation || [])
      .filter(rule => !rule?.required)
      .map(rule => String(rule.key || ""))
  );
  return (payload?.retrieval_plan?.coverage_checklist || [])
    .filter(item => String(item?.item_type || "").toLowerCase() === "filter")
    .filter(item => {
      const evidenceIdentifiers = sqlExpressionIdentifiers(
        `${item?.item || ""} ${item?.note || ""}`
      );
      return [...evidenceIdentifiers].some(identifier => filterIdentifiers.has(identifier));
    })
    .map(item => String(item?.evidence_key || "").trim())
    .filter(key => supportingRuleKeys.has(key));
}

function auditFilterViolationSupported(violation, payload, context) {
  if (violation?.category !== "filter") return true;
  const rule = (context?.stages?.sql_generation || [])
    .find(item => item?.key === violation.rule_key);
  if (!rule) return false;
  const ruleContent = String(rule.content || "");
  const evidence = String(violation.evidence_quote || "").trim();
  if (evidence && !normalizeCandidateText(ruleContent).includes(normalizeCandidateText(evidence))) {
    return false;
  }
  const predicateIdentifiers = sqlExpressionIdentifiers(violation.predicate || violation.issue);
  const referencedColumns = physicalColumnsForBinding(payload)
    .filter(column => predicateIdentifiers.has(column.field.toLowerCase()));
  if (!referencedColumns.length) return true;
  const normalizedRule = normalizeCandidateText(ruleContent);
  return referencedColumns.some(column => (
    normalizedRule.includes(normalizeCandidateText(column.field))
    || (column.comment && normalizedRule.includes(normalizeCandidateText(column.comment)))
  ));
}

async function generateIndependentResultSet(payload, contract, scope, index, attempt = 1, previousFailure = null) {
  const rejectedFilters = rejectedScopeFiltersFromFailure(previousFailure, payload);
  const rejectedRuleKeys = supportingRuleKeysForRejectedFilters(payload, rejectedFilters);
  const effectiveScope = {
    ...scope,
    excluded_filters: [...new Set([...(scope?.excluded_filters || []), ...rejectedFilters])],
    excluded_rule_keys: [...new Set([...(scope?.excluded_rule_keys || []), ...rejectedRuleKeys])]
  };
  const scopedContext = mandatoryContextForOutput(payload.mandatory_context, effectiveScope, contract);
  const excludedFilterKeys = new Set(
    (effectiveScope.excluded_filters || []).map(filter => normalizeCandidateText(filter))
  );
  const sourceRetrievalPlan = payload?.retrieval_plan || {};
  const sourceSemanticPlan = sourceRetrievalPlan.semantic_plan || {};
  const scopedRetrievalPlan = {
    ...sourceRetrievalPlan,
    selected_rule_keys: (sourceRetrievalPlan.selected_rule_keys || [])
      .filter(key => !effectiveScope.excluded_rule_keys.includes(key)),
    semantic_plan: {
      ...sourceSemanticPlan,
      filters: (Array.isArray(sourceSemanticPlan.filters) ? sourceSemanticPlan.filters : [])
        .filter(filter => !excludedFilterKeys.has(normalizeCandidateText(
          typeof filter === "string" ? filter : JSON.stringify(filter)
        )))
    }
  };
  const buildScopedPayload = feedback => ({
    ...payload,
    retrieval_plan: scopedRetrievalPlan,
    mandatory_context: scopedContext,
    generation_scope: {
      key: scope.key || `result_${index + 1}`,
      output: scope.output,
      expected_columns: scope.expected_columns || [],
      expected_column_bindings: scope.expected_column_bindings || [],
      purpose: scope.purpose || `独立落实规则 ${scope.rule_keys.join("、")}`,
      rule_keys: scope.rule_keys,
      excluded_filters: effectiveScope.excluded_filters,
      excluded_rule_keys: effectiveScope.excluded_rule_keys
    },
    rule_contract_feedback: feedback || null
  });
  const retryFeedback = previousFailure
    ? {
        stage: previousFailure.result_set_stage || "structure_contract",
        violations: [
          ...(previousFailure.detail?.audit?.violations || []),
          ...(previousFailure.detail?.binding_mismatches || []),
          ...(previousFailure.detail?.missing_group_by_projections || []).map(expression => ({
            issue: `GROUP BY 维度 ${expression} 未出现在 SELECT 输出列中`,
            correction: `把 ${expression} 作为业务维度列加入 SELECT，并保留聚合度量`
          }))
        ],
        previous_sql: previousFailure.detail?.previous_sql || "",
        previous_error: previousFailure.message || String(previousFailure)
      }
    : null;
  const scopedPayload = buildScopedPayload(retryFeedback);

  const generationStartedAt = Date.now();
  let response;
  try {
    response = await callScopedResultSqlModel(scopedPayload, {
      temperature: attempt > 1 ? 0 : 0.02,
      maxTokens: attempt > 1 ? 5800 : 5200
    });
  } catch (error) {
    throw scopedResultFailure(scope, "SQL 生成", error);
  }
  const generationMs = Date.now() - generationStartedAt;
  let generated = normalizeGeneratedSqlData(response.data, scopedPayload);
  if (!generated.sql) {
    throw scopedResultFailure(scope, "SQL 生成", new Error("没有生成可执行 SQL"));
  }
  const bindingEnforcement = enforceExpectedPhysicalBindings(scope, generated.sql);
  if (bindingEnforcement.changes.length) {
    generated.sql = bindingEnforcement.sql;
    generated.warnings = [
      ...(generated.warnings || []),
      `已按真实字段绑定契约修正 ${bindingEnforcement.changes.length} 个 SELECT 列。`
    ];
  }

  let structure = scopedResultStructureCoverage(scope, generated);
  const auditStartedAt = Date.now();
  let audit;
  let auditMode = "model";
  try {
    audit = await auditSqlRuleCompliance(scopedPayload, scope, scopedContext, generated);
  } catch (error) {
    const sharedRuleKeys = contract?.shared_sql_rule_keys || [];
    if (!modelCallWasAborted(error) || !structure.ok || sharedRuleKeys.length) {
      throw scopedResultFailure(scope, "规则审计", error, structure);
    }
    auditMode = "structural_fallback";
    audit = {
      ok: true,
      applied_rule_keys: [...new Set(scope.rule_keys || [])],
      violations: [],
      corrected_sql: "",
      reason: "模型规则审计超时，本地只读 SQL 与字段结构契约校验通过，保留已生成结果集。",
      model: "deterministic-structure-audit",
      usage: null,
      skipped_model_error: error.message || String(error)
    };
  }
  const auditMs = Date.now() - auditStartedAt;
  if (structure.ok && audit.violations?.length) {
    const ignoredViolations = audit.violations
      .filter(item => (
        item.category === "field_structure"
        || !auditFilterViolationSupported(item, scopedPayload, scopedContext)
      ));
    if (ignoredViolations.length) {
      const ignoredSet = new Set(ignoredViolations);
      const activeViolations = audit.violations.filter(item => !ignoredSet.has(item));
      audit = {
        ...audit,
        ok: activeViolations.length === 0,
        violations: activeViolations,
        ignored_contract_violations: ignoredViolations,
        reason: activeViolations.length
          ? audit.reason
          : "字段结构由后端契约裁决；缺少规则字段证据的过滤指控已忽略。"
      };
    }
  }

  if (!audit.ok) {
    throw scopedResultFailure(
      scope,
      "规则审计",
      new Error(`未通过：${audit.violations.map(item => item.issue).join("；") || audit.reason}`),
      { audit, structure, previous_sql: generated.sql }
    );
  }

  if (!structure.ok) {
    throw scopedResultFailure(
      scope,
      "结构契约校验",
      new Error(
        `期望 ${structure.expected_count} 列，识别到 ${structure.actual_count} 列`
        + `${structure.binding_mismatches.length
          ? `；字段绑定错误 ${structure.binding_mismatches.map(item => `${item.output} 应使用 ${item.expected_field}`).join("、")}`
          : ""}`
        + `${structure.missing_group_by_projections.length
          ? `；分组维度未输出 ${structure.missing_group_by_projections.join("、")}`
          : ""}`
        + `${structure.missing.length
          ? `；缺少业务列 ${structure.missing.join("、")}`
          : ""}`
        + `${structure.out_of_order.length
          ? `；业务列顺序错误 ${structure.out_of_order.join("、")}`
          : ""}`
      ),
      { ...structure, previous_sql: generated.sql }
    );
  }

  const verifiedRuleKeys = [...new Set([
    ...(scopedContext.required_stage_rule_keys?.sql_generation || []),
    ...(audit.applied_rule_keys || [])
  ])];
  generated.applied_rule_keys = [...new Set([
    ...(generated.applied_rule_keys || []),
    ...verifiedRuleKeys
  ])];
  const coverage = ruleCoverageForStage(scopedContext, "sql_generation", generated);
  if (!coverage.ok) {
    throw scopedResultFailure(
      scope,
      "规则覆盖校验",
      new Error(`仍缺少 ${coverage.missing_rule_keys.join("、")}`),
      coverage
    );
  }
  response = {
    ...response,
    usage: { generation: response.usage, audit: audit.usage }
  };
  return {
    response,
    coverage,
    audit,
    structure,
    diagnostics: {
      attempt,
      generation_ms: generationMs,
      generation_retried: Boolean(response.usage?.generation?.initial_error),
      audit_ms: auditMs,
      audit_mode: auditMode,
      audit_model_error: audit.skipped_model_error || ""
    },
    definition: {
      key: scope.key || `result_${index + 1}`,
      title: String(generated.result_title || scope.output).trim(),
      purpose: String(generated.result_purpose || scope.purpose || `落实规则 ${scope.rule_keys.join("、")}`).trim(),
      sql: generated.sql,
      applied_rule_keys: coverage.applied_rule_keys,
      display_formats: generated.display_formats || []
    }
  };
}

async function generateIndependentResultSets(payload, contract) {
  const scopes = independentOutputRuleScopes(contract, payload);
  if (!scopes.length) return null;
  const responses = new Array(scopes.length);
  const initial = await Promise.allSettled(
    scopes.map((scope, index) => generateIndependentResultSet(payload, contract, scope, index, 1))
  );
  const failedIndexes = [];
  initial.forEach((result, index) => {
    if (result.status === "fulfilled") responses[index] = result.value;
    else failedIndexes.push(index);
  });

  if (failedIndexes.length) {
    const retried = await Promise.allSettled(
      failedIndexes.map(index => generateIndependentResultSet(
        payload,
        contract,
        scopes[index],
        index,
        2,
        initial[index]?.reason || null
      ))
    );
    retried.forEach((result, retryIndex) => {
      const index = failedIndexes[retryIndex];
      if (result.status === "fulfilled") responses[index] = result.value;
      else responses[index] = {
        error: result.reason,
        diagnostics: {
          attempt: 2,
          failed_stage: result.reason?.result_set_stage || "unknown",
          error: result.reason?.message || String(result.reason)
        }
      };
    });
  }

  const unresolved = responses
    .map((response, index) => ({ response, scope: scopes[index] }))
    .filter(item => !item.response?.definition);
  if (unresolved.length) {
    throw new Error(
      `独立结果集定向重试后仍未完成：${unresolved.map(item => (
        `${item.scope.output}（${item.response?.diagnostics?.failed_stage || "未知阶段"}：${item.response?.diagnostics?.error || "未知错误"}）`
      )).join("；")}`
    );
  }

  const mappedRuleKeys = new Set(scopes.flatMap(scope => scope.rule_keys || []));
  const requiredSqlRules = (payload?.mandatory_context?.stages?.sql_generation || [])
    .filter(rule => rule?.required);
  const deferredRendererRuleKeys = new Set(contract?.renderer_only_rule_keys || []);
  const sharedSqlRuleKeys = new Set(contract?.shared_sql_rule_keys || []);
  const deferredRendererRules = requiredSqlRules.filter(rule => deferredRendererRuleKeys.has(rule.key));
  const unresolvedRules = requiredSqlRules.filter(rule => (
    !mappedRuleKeys.has(rule.key)
    && !deferredRendererRuleKeys.has(rule.key)
    && !sharedSqlRuleKeys.has(rule.key)
  ));
  if (unresolvedRules.length) return null;

  const resultSets = responses.map(item => item.definition);
  return {
    model: responses.map(item => item.response.model).filter(Boolean).join(" + ") || config.model,
    raw: responses.map(item => item.response.raw || "").join("\n"),
    usage: responses.map(item => item.response.usage),
    data: {
      answer: `已按语义计划生成 ${resultSets.length} 个独立结果集。`,
      answer_type: "sql_needed",
      decision: {
        intent: payload?.retrieval_plan?.intent || "detail_query",
        selected_metric_key: null,
        selected_metric_keys: payload?.retrieval_plan?.selected_metric_keys || [],
        selected_rule_keys: payload?.retrieval_plan?.selected_rule_keys || [],
        confidence: 0.9,
        reason: "不同输出结构已按语义计划并行生成，避免用 UNION 强行合并。"
      },
      sql_plan: resultSets.map(item => ({
        part: "RESULT_SET",
        value: item.title,
        source: item.applied_rule_keys.join("、"),
        note: item.purpose
      })),
      applied_rule_keys: [...new Set(resultSets.flatMap(item => item.applied_rule_keys))],
      not_applicable_rules: deferredRendererRules.map(rule => ({
        key: rule.key,
        reason: "该规则只约束最终回答文字，不需要生成独立 SQL；将在 renderer_rule 阶段执行。"
      })),
      display_formats: [],
      sql: "",
      result_sets: resultSets,
      warnings: []
    },
    scopes: scopes.map((scope, index) => ({
      output: scope.output,
      rule_keys: scope.rule_keys,
      audit: responses[index]?.audit || null,
      structure: responses[index]?.structure || null,
      diagnostics: responses[index]?.diagnostics || null
    }))
  };
}

function buildSqlRepairMessages({ payload, generated, validation, error, attempt }) {
  const schema = {
    answer: "string",
    answer_type: "sql_needed | clarification_needed | no_evidence",
    decision: {
      intent: "metric_query | trend_analysis | period_overview | table_profile | dimension_summary | detail_query | rule_explanation | sql_resultset_lookup | unknown",
      selected_metric_key: "string or null",
      selected_metric_keys: ["string"],
      selected_rule_keys: ["string"],
      confidence: 0.0,
      reason: "string"
    },
    sql_plan: [{ part: "SELECT | FROM | WHERE | GROUP BY | RULE | CHECK | REPAIR", value: "string", source: "string", note: "string" }],
    sql: "single read-only SELECT SQL",
    warnings: ["string"]
  };
  return [
    {
      role: "system",
      content: [
        "你是生产级 NL2SQL 的 SQL 自动修复器。",
        "上一条 SQL 已经通过只读安全校验，但数据库执行失败。你的任务是根据数据库错误修复 SQL，并输出一条新的、可执行的只读 SELECT。",
        "不要重新理解业务问题，不要扩大查询范围，不要改变用户口径；只修复导致执行失败的 SQL 结构、字段引用、别名、UNION/CTE/聚合写法等问题。",
        "必须保留 payload.qa_config、payload.mandatory_context、已选业务指标、强制过滤和用户问题中的时间/维度要求。",
        "只能使用 payload.semantic_catalog、payload.table_context、payload.resolved_sql_resultsets 中真实存在的表、字段、指标和规则；不要编造字段或表。",
        "如果错误是 SELECT statements have different number of columns，说明当前结果集内 UNION/UNION ALL 的各 SELECT 列数不一致；保留当前结果集的业务目的，改成单个 SELECT 的多个聚合列，或保证 UNION 每段列数、列序和类型一致。",
        "如果错误是 table \"schema.table\" does not exist，优先检查是否把全限定表名整体加了引号；正确写法是 `schema`.`table`，或在当前数据库下直接写 `table`。",
        "当前修复对象只代表一个结果集。不要通过删除用户要求的其他独立结果来规避错误；多结果集由外层协议分别执行。",
        "SQL 必须是单条只读 SELECT 或 WITH 查询；不要输出 INSERT/UPDATE/DELETE/CREATE/DROP/SET/USE。",
        "answer 只说明修复了什么，不要编造具体数值。",
        "禁止出现“分子/分母”表述。",
        `严格按这个 JSON schema 输出：${JSON.stringify(schema)}`,
        "只输出 JSON，不要输出 Markdown。"
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({
        attempt,
        question: payload.question,
        qa_config: payload.qa_config || null,
        semantic_catalog: payload.semantic_catalog || {},
        table_context: payload.table_context || [],
        retrieval_plan: payload.retrieval_plan || {},
        mandatory_context: payload.mandatory_context || {},
        resolved_sql_resultsets: payload.resolved_sql_resultsets || [],
        failed_sql: validation?.sql || generated?.sql || "",
        database_error: error,
        previous_decision: generated?.decision || {},
        previous_sql_plan: generated?.sql_plan || [],
        previous_warnings: generated?.warnings || []
      })
    }
  ];
}

function parseResultNumber(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value).trim().replace(/,/g, "");
  if (!text || !/^-?\d+(?:\.\d+)?$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function normalizeDisplayFormats(formats = [], columns = []) {
  const rawFormats = Array.isArray(formats)
    ? formats
    : formats && typeof formats === "object"
      ? Object.entries(formats).map(([column, value]) => ({ column, ...(value && typeof value === "object" ? value : { format: value }) }))
      : [];
  const columnSet = new Set((columns || []).map(String));
  const normalized = rawFormats
    .map(item => {
      const column = String(item?.column || item?.name || item?.alias || "").trim();
      if (!column || (columnSet.size && !columnSet.has(column))) return null;
      const rawFormat = String(item?.format || item?.value_format || item?.type || "").toLowerCase();
      if (!rawFormat) return null;
      const format = rawFormat === "percentage" ? "percent" : rawFormat;
      const hasExplicitScale = item?.display_scale != null
        || item?.result_scale != null
        || item?.sql_scale != null
        || item?.scale != null;
      const defaultScale = format === "percent" ? 100 : 1;
      const scale = Number(hasExplicitScale
        ? (item?.display_scale ?? item?.result_scale ?? item?.sql_scale ?? item?.scale)
        : defaultScale);
      const precision = item?.precision == null ? null : Number(item.precision);
      return {
        column,
        metric_key: item?.metric_key || item?.key || null,
        format,
        suffix: item?.suffix ?? (format === "percent" ? "%" : ""),
        precision: Number.isFinite(precision) ? precision : null,
        scale: Number.isFinite(scale) && scale !== 0 ? scale : 1,
        display_scale: Number.isFinite(scale) && scale !== 0 ? scale : 1,
        scale_applied: Boolean(item?.scale_applied || item?.sql_scaled || item?.value_scaled),
        thousand_separator: Boolean(
          item?.thousand_separator
          || item?.use_grouping
          || item?.grouping
          || item?.comma_grouping
          || item?.comma
        ),
        source: item?.source || ""
      };
    })
    .filter(Boolean);
  const priority = item => {
    const source = String(item.source || "");
    if (/metric_config|metric/.test(source)) return 3;
    if (/deterministic|expansion/.test(source)) return 2;
    return 1;
  };
  const byColumnAndMetric = new Map();
  normalized.forEach(item => {
    const key = `${item.column}::${item.metric_key || ""}`;
    const previous = byColumnAndMetric.get(key);
    if (!previous || priority(item) >= priority(previous)) {
      byColumnAndMetric.set(key, item);
    }
  });
  return [...byColumnAndMetric.values()];
}

function presentationRuleText(rule) {
  const spec = rule?.spec && typeof rule.spec === "object" ? rule.spec : {};
  return [
    rule?.key,
    rule?.name,
    rule?.summary,
    rule?.content,
    rule?.answer,
    spec.content,
    spec.summary,
    spec.answer,
    spec.rule,
    spec.description,
    Array.isArray(spec.requirements) ? spec.requirements.join("\n") : "",
    Array.isArray(spec.rules) ? spec.rules.join("\n") : ""
  ].filter(Boolean).join("\n");
}

function resultPresentationRules(payload) {
  const rules = semanticCatalog(payload).result_presentation;
  return Array.isArray(rules) ? rules : [];
}

const DEFAULT_PRESENTATION_STAGES = ["final_answer", "result_table"];
const PRESENTATION_STAGE_ALIASES = new Map([
  ["answer", "final_answer"],
  ["final", "final_answer"],
  ["final_answer", "final_answer"],
  ["summary", "final_answer"],
  ["natural_answer", "final_answer"],
  ["result", "result_table"],
  ["result_table", "result_table"],
  ["table", "result_table"],
  ["data_table", "result_table"],
  ["grid", "result_table"],
  ["chart", "chart"],
  ["visual", "chart"],
  ["visualization", "chart"],
  ["all", "all"],
  ["both", "all"]
]);

function normalizePresentationStage(value) {
  const text = String(value || "").trim().toLowerCase().split("-").join("_").split(" ").join("_");
  return PRESENTATION_STAGE_ALIASES.get(text) || text;
}

function emptyPresentationDirectives(stage = "all") {
  return {
    stage: normalizePresentationStage(stage) || "all",
    active_rule_count: 0,
    rules: [],
    display_formats: [],
    result_table: {
      add_total_row: false,
      total_columns: [],
      label_column: "",
      label_text: "合计",
      include_in_download: true
    },
    answer: {
      require_insight: false,
      require_formula: false
    },
    warnings: []
  };
}

function exactResultColumns(values = [], columns = []) {
  const allowed = new Set((columns || []).map(String));
  return [...new Set((Array.isArray(values) ? values : [])
    .map(item => String(item || "").trim())
    .filter(item => item && (!allowed.size || allowed.has(item))))];
}

function exactResultColumn(value, columns = []) {
  const text = String(value || "").trim();
  if (!text) return "";
  return (columns || []).map(String).includes(text) ? text : "";
}

function normalizePresentationDirectives(data, columns = [], stage = "all") {
  const source = data && typeof data === "object" ? data : {};
  const table = source.result_table || source.table || {};
  const answer = source.answer || source.final_answer || {};
  const normalized = emptyPresentationDirectives(source.stage || stage);
  normalized.active_rule_count = Number(source.active_rule_count || 0) || 0;
  normalized.rules = Array.isArray(source.rules) ? source.rules.map(rule => ({
    key: String(rule?.key || ""),
    name: String(rule?.name || ""),
    stages: Array.isArray(rule?.stages) ? rule.stages.map(normalizePresentationStage).filter(Boolean) : [],
    directive: String(rule?.directive || rule?.interpreted_as || ""),
    reasoning: String(rule?.reasoning || rule?.reason || "")
  })) : [];
  normalized.result_table = {
    add_total_row: Boolean(table.add_total_row ?? table.total_row ?? table.requires_total_row),
    total_columns: exactResultColumns(table.total_columns || table.totalColumns || [], columns),
    label_column: exactResultColumn(table.label_column || table.labelColumn || "", columns),
    label_text: String(table.label_text || table.labelText || "合计").trim() || "合计",
    include_in_download: table.include_in_download == null ? true : Boolean(table.include_in_download)
  };
  normalized.answer = {
    require_insight: Boolean(answer.require_insight ?? answer.requires_insight ?? answer.insight),
    require_formula: Boolean(answer.require_formula ?? answer.requires_formula ?? answer.formula)
  };
  normalized.display_formats = normalizeDisplayFormats(source.display_formats || source.displayFormats || [], columns);
  normalized.warnings = Array.isArray(source.warnings) ? source.warnings.map(item => String(item || "").trim()).filter(Boolean) : [];
  return normalized;
}

function mergePresentationDirectives(base, extra, columns = []) {
  const left = normalizePresentationDirectives(base, columns);
  const right = normalizePresentationDirectives(extra, columns, left.stage);
  const merged = emptyPresentationDirectives(right.stage || left.stage);
  merged.active_rule_count = Math.max(left.active_rule_count, right.active_rule_count, left.rules.length + right.rules.length);
  merged.rules = [...left.rules, ...right.rules];
  merged.result_table = {
    add_total_row: Boolean(left.result_table.add_total_row || right.result_table.add_total_row),
    total_columns: exactResultColumns([...left.result_table.total_columns, ...right.result_table.total_columns], columns),
    label_column: right.result_table.label_column || left.result_table.label_column,
    label_text: right.result_table.label_text || left.result_table.label_text || "合计",
    include_in_download: left.result_table.include_in_download !== false && right.result_table.include_in_download !== false
  };
  merged.answer = {
    require_insight: Boolean(left.answer.require_insight || right.answer.require_insight),
    require_formula: Boolean(left.answer.require_formula || right.answer.require_formula)
  };
  merged.display_formats = normalizeDisplayFormats([...left.display_formats, ...right.display_formats], columns);
  merged.warnings = [...new Set([...left.warnings, ...right.warnings])];
  return merged;
}

function presentationDirectiveNames(directives) {
  return [
    directives?.result_table?.add_total_row ? "表格合计行" : "",
    directives?.answer?.require_formula ? "回答展示公式" : "",
    directives?.answer?.require_insight ? "回答补充业务判断" : "",
    (directives?.display_formats || []).length ? "数值格式化" : ""
  ].filter(Boolean);
}

function resultPresentationRuleStages(rule) {
  const spec = rule?.spec && typeof rule.spec === "object" ? rule.spec : {};
  const stages = [
    ...(Array.isArray(rule?.applies_to) ? rule.applies_to : []),
    ...(Array.isArray(rule?.presentation_stages) ? rule.presentation_stages : []),
    ...(Array.isArray(spec.applies_to) ? spec.applies_to : []),
    ...(Array.isArray(spec.presentation_stages) ? spec.presentation_stages : [])
  ].map(normalizePresentationStage).filter(Boolean);
  if (!stages.length || stages.includes("all")) return [...DEFAULT_PRESENTATION_STAGES];
  return [...new Set(stages)];
}

function structuredPresentationDirectivesFromRules(payload, columns = []) {
  let directives = emptyPresentationDirectives("all");
  for (const rule of resultPresentationRules(payload)) {
    const spec = rule?.spec && typeof rule.spec === "object" ? rule.spec : {};
    const structured = rule?.presentation_directives
      || rule?.directives
      || spec.presentation_directives
      || spec.directives
      || null;
    const inline = structured || (spec.result_table || spec.answer || spec.display_formats ? spec : null);
    if (!inline) continue;
    directives = mergePresentationDirectives(directives, {
      ...inline,
      rules: [{
        key: rule?.key || rule?.key_name || "",
        name: rule?.name || "",
        stages: resultPresentationRuleStages(rule),
        directive: "structured_spec",
        reasoning: "语义条目已经提供结构化展示配置。"
      }]
    }, columns);
  }
  return directives;
}

function presentationRulePayload(rule) {
  return {
    key: rule?.key || rule?.key_name || "",
    name: rule?.name || "",
    content: presentationRuleText(rule),
    stages: resultPresentationRuleStages(rule)
  };
}

function cloneJsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function presentationDirectiveCacheKey(payload, columns = []) {
  const rules = resultPresentationRules(payload).map(presentationRulePayload);
  if (!rules.length || !columns.length) return "";
  return JSON.stringify({
    rules,
    columns: (columns || []).map(String),
    generated_display_formats: payload?.generated_display_formats || []
  });
}

function rememberPresentationDirective(cacheKey, directives) {
  if (!cacheKey) return;
  if (presentationDirectiveCache.size >= 80) {
    const firstKey = presentationDirectiveCache.keys().next().value;
    if (firstKey) presentationDirectiveCache.delete(firstKey);
  }
  presentationDirectiveCache.set(cacheKey, cloneJsonValue(directives));
}

function buildPresentationDirectiveMessages({ payload, columns, rows }) {
  const schema = {
    result_table: {
      add_total_row: true,
      total_columns: ["exact result column names that should be summed"],
      label_column: "exact result column name for the total label, or empty string",
      label_text: "合计",
      include_in_download: true
    },
    answer: {
      require_insight: true,
      require_formula: false
    },
    display_formats: [{
      column: "exact result column name",
      format: "number | percent",
      display_scale: 1,
      suffix: "",
      precision: 2,
      thousand_separator: true,
      reason: "string"
    }],
    rules: [{
      key: "semantic rule key",
      name: "semantic rule name",
      stages: ["final_answer", "result_table"],
      directive: "short structured interpretation",
      reasoning: "why this directive follows from the rule"
    }],
    warnings: ["string"]
  };
  return [
    {
      role: "system",
      content: [
        "你是 NL2SQL 的结果展示规则编译器。",
        "你的任务是理解 semantic_catalog.result_presentation 中的自然语言展示要求，并把它们编译成结构化 JSON directive。",
        "你只处理展示层：结果表格如何显示、最终回答如何表达、数字格式如何展示。不要改变 SQL、WHERE、SELECT、指标口径或数据过滤。",
        "必须基于用户问题、真实结果列名、少量结果样例和展示规则综合判断。",
        "result_table.total_columns 必须只使用 result_columns 中精确存在的列名；不要输出不存在的列。",
        "如果规则要求表格合计行，你要判断哪些真实结果列可以加总，并写入 total_columns；比例、比率、同比、环比等不可加总的列不要放入 total_columns，除非规则明确要求。",
        "如果规则没有要求合计行，add_total_row 必须为 false。",
        "如果规则要求百分数、小数位、千分位、单位等，写入 display_formats。display_formats.column 也必须是精确结果列名。",
        "如果规则要求回答给业务判断，answer.require_insight=true。",
        "如果规则要求展示计算公式或口径，answer.require_formula=true。",
        "无法确定时不要猜，写 warnings，并保持对应 directive 为 false 或空数组。",
        `严格按这个 JSON schema 输出：${JSON.stringify(schema)}`,
        "只输出 JSON，不要输出 Markdown。"
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({
        question: payload.question,
        qa_config: payload.qa_config || null,
        result_columns: columns,
        sample_rows: (rows || []).slice(0, 8),
        result_presentation: resultPresentationRules(payload).map(presentationRulePayload),
        generated_display_formats: payload?.generated_display_formats || []
      })
    }
  ];
}

async function resolveResultPresentationDirectives(payload, columns = [], rows = []) {
  const structured = structuredPresentationDirectivesFromRules(payload, columns);
  if (!resultPresentationRules(payload).length) return structured;
  const cacheKey = presentationDirectiveCacheKey(payload, columns);
  if (cacheKey && presentationDirectiveCache.has(cacheKey)) {
    return mergePresentationDirectives(structured, cloneJsonValue(presentationDirectiveCache.get(cacheKey)), columns);
  }
  if (!config.apiKey) {
    return mergePresentationDirectives(structured, {
      warnings: ["未配置模型 API，未能理解自然语言结果展示要求；仅使用结构化展示配置。"]
    }, columns);
  }
  try {
    const compiled = await callModelJson(
      buildPresentationDirectiveMessages({ payload, columns, rows }),
      { temperature: 0.02, maxTokens: 1800 }
    );
    const directives = mergePresentationDirectives(structured, normalizePresentationDirectives(compiled.data || {}, columns), columns);
    rememberPresentationDirective(cacheKey, directives);
    return directives;
  } catch (error) {
    return mergePresentationDirectives(structured, {
      warnings: [`结果展示规则理解失败：${error.message || String(error)}`]
    }, columns);
  }
}

function presentationDirectivesFromPayload(payload, columns = []) {
  return normalizePresentationDirectives(
    payload?.result_presentation_directives || payload?.presentation_directives || {},
    columns
  );
}

function displayFormatsFromResultPresentation(payload, columns = []) {
  if (!columns.length) return [];
  return presentationDirectivesFromPayload(payload, columns).display_formats;
}

function resultPresentationRequiresInsight(payload) {
  return presentationDirectivesFromPayload(payload).answer.require_insight;
}

function resultPresentationRequiresFormula(payload) {
  return presentationDirectivesFromPayload(payload).answer.require_formula;
}

function selectedMetricKeysForAnswer(payload, generated) {
  return [...new Set([
    generated?.decision?.selected_metric_key,
    ...(generated?.decision?.selected_metric_keys || []),
    payload?.retrieval_plan?.selected_metric_key,
    ...(payload?.retrieval_plan?.selected_metric_keys || [])
  ].filter(Boolean).map(String))];
}

function metricDisplayName(metric, fallback = "") {
  return metric?.name || metric?.entry?.name || metric?.metric?.name || fallback;
}

function humanMetricFormula(metric, metrics) {
  const expression = metricExpression(metric);
  if (!expression) return "";
  const dependencyNameByVariable = new Map();
  metricDependencySpecs(metric).forEach(dep => {
    const depMetric = metrics.get(dep.metricKey);
    const depName = metricDisplayName(depMetric, dep.metricKey);
    if (dep.variable) dependencyNameByVariable.set(String(dep.variable), depName);
    if (dep.metricKey) dependencyNameByVariable.set(String(dep.metricKey), depName);
  });
  return String(expression)
    .replace(/\b[A-Za-z_][A-Za-z0-9_]*\b/g, token => {
      if (dependencyNameByVariable.has(token)) return dependencyNameByVariable.get(token);
      const matched = metrics.get(token);
      if (matched) return metricDisplayName(matched, token);
      if (/average_period/i.test(token)) return "期间平均";
      return token;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function selectedDerivedMetricFormulaNotes(payload, generated) {
  const knowledgeNotes = knowledgeMetricsFromPlan(payload?.retrieval_plan)
    .map(metric => metric.formula ? `${metric.name}=${metric.formula}` : "")
    .filter(Boolean);
  if (!resultPresentationRequiresFormula(payload)) return knowledgeNotes;
  const metrics = metricCatalogMap(payload);
  const configuredNotes = selectedMetricKeysForAnswer(payload, generated)
    .map(key => {
      const metric = metrics.get(key);
      if (!metric || metricKind(metric) !== "derived") return "";
      const formula = humanMetricFormula(metric, metrics);
      if (!formula) return "";
      return `${metricDisplayName(metric, key)}=${formula}`;
    })
    .filter(Boolean);
  return [...new Set([...configuredNotes, ...knowledgeNotes])];
}

function rendererDisplayFormats(payload, generated, columns = []) {
  return normalizeDisplayFormats([
    ...(Array.isArray(generated?.display_formats) ? generated.display_formats : []),
    ...displayFormatsFromResultPresentation(payload, columns)
  ], columns);
}

function displayFormatForColumn(formats = [], column = "") {
  const name = String(column || "");
  return (formats || []).find(item => item.column === name) || null;
}

function isPercentDisplayFormat(format) {
  return String(format?.format || "").toLowerCase() === "percent";
}

function isTotalableResultColumn(column, rows = [], formats = []) {
  const name = String(column || "");
  const lower = name.toLowerCase();
  if (/(id|code|编码|代码|编号|单号|凭证|订单|期间|年度|年份|月份|日期|时间|货币|币种|currency|cur|gjahr|poper|belnr|rbukrs|racct|rcntr|dept)/i.test(name)) {
    return false;
  }
  if (/(率|比例|占比|比率|同比|环比|增长率|增幅|margin|ratio|rate|roe|roa|yoy|mom)/i.test(name)) {
    return false;
  }
  if (isPercentDisplayFormat(displayFormatForColumn(formats, name))) {
    return false;
  }
  const looksLikeAmount = /(金额|合计|余额|收入|成本|费用|利润|税额|价|值|数量|重量|总额|净额|amount|amt|money|balance|revenue|cost|profit|price|value|qty|quantity|wsl|tsl|dmbtr|wrbtr|menge)/i.test(lower);
  return looksLikeAmount && rows.some(row => parseResultNumber(row?.[column]) != null);
}

function formatResultNumber(value) {
  if (!Number.isFinite(value)) return "";
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

function formatDisplayNumber(value, precision = null, useGrouping = false) {
  if (!Number.isFinite(value)) return "";
  if (useGrouping) {
    if (Number.isFinite(precision)) {
      return new Intl.NumberFormat("zh-CN", {
        minimumFractionDigits: precision,
        maximumFractionDigits: precision
      }).format(value);
    }
    return new Intl.NumberFormat("zh-CN", {
      maximumFractionDigits: 6
    }).format(value);
  }
  if (Number.isFinite(precision)) {
    return value.toFixed(precision).replace(/0+$/, "").replace(/\.$/, "");
  }
  return String(value);
}

function formatValueWithDisplayFormat(value, format) {
  const number = parseResultNumber(value);
  if (!format || number == null) return String(value ?? "");
  const precision = Number.isFinite(format.precision)
    ? format.precision
    : isPercentDisplayFormat(format)
      ? 2
      : null;
  const scale = format.scale_applied ? 1 : Number(format.scale || 1);
  const scaled = number * (Number.isFinite(scale) ? scale : 1);
  const rounded = Number.isFinite(precision)
    ? Math.round((scaled + Number.EPSILON) * (10 ** precision)) / (10 ** precision)
    : scaled;
  return `${formatDisplayNumber(rounded, precision, Boolean(format.thousand_separator))}${format.suffix || ""}`;
}

function formatResultCellForAnswer(column, value, formats = []) {
  if (value == null || value === "") return "";
  return formatValueWithDisplayFormat(value, displayFormatForColumn(formats, column));
}

function displayNumberForObservation(column, value, formats = []) {
  const number = parseResultNumber(value);
  if (number == null) return null;
  const format = displayFormatForColumn(formats, column);
  const scale = format?.scale_applied ? 1 : Number(format?.scale || 1);
  const scaled = number * (Number.isFinite(scale) ? scale : 1);
  return Number.isFinite(scaled) ? scaled : null;
}

function singleRowObservationFromResult(columns = [], row = {}, formats = []) {
  const visible = columns
    .map(column => ({
      column,
      value: row?.[column],
      display: formatResultCellForAnswer(column, row?.[column], formats),
      number: displayNumberForObservation(column, row?.[column], formats),
      format: displayFormatForColumn(formats, column)
    }))
    .filter(item => item.value != null && item.value !== "" && item.display);
  if (!visible.length) return "";

  const countOnly = visible.every(item => /^(total_rows|row_count|count|cnt)$/i.test(String(item.column || "")));
  if (countOnly) return "";

  const percentItems = visible.filter(item => isPercentDisplayFormat(item.format));
  const named = pattern => visible.find(item => pattern.test(String(item.column || "")));
  const revenue = named(/营业收入|收入|revenue/i);
  const cost = named(/营业成本|成本|cost/i);
  const profit = named(/净利润|利润总额|营业利润|利润|profit/i);
  const margin = percentItems.find(item => /净利润率|净利率|销售毛利率|毛利率|利润率|收益率|报酬率|margin|roe|roa/i.test(String(item.column || "")));
  const ratio = percentItems.find(item => /资产负债率|负债率|比例|占比|比率|率|ratio/i.test(String(item.column || "")));

  if (percentItems.length >= 2) {
    const positiveRatios = percentItems.filter(item => Number.isFinite(item.number) && item.number > 0);
    const negativeRatios = percentItems.filter(item => Number.isFinite(item.number) && item.number < 0);
    const profitRatios = percentItems.filter(item => /毛利率|利润率|收益率|报酬率|margin|roe|roa/i.test(String(item.column || "")));
    const cashRatio = percentItems.find(item => /现金|速动|流动|偿债|liquid|quick|cash/i.test(String(item.column || "")));
    if (negativeRatios.length) {
      return `整体来看，${negativeRatios.map(item => item.column).join("、")}为负，说明当前口径下部分经营或偿债指标承压，建议继续结合明细和历史趋势定位原因。`;
    }
    if (profitRatios.length && cashRatio && positiveRatios.length === percentItems.length) {
      return `整体来看，盈利类指标和${cashRatio.column}均为正，说明当前口径下盈利空间和现金保障表现相对稳定；后续可以和历史期间或预算口径一起看趋势。`;
    }
    if (profitRatios.length && positiveRatios.length === percentItems.length) {
      return `整体来看，盈利类指标均为正，说明当前口径下经营结果能够形成利润；若要判断质量，还需要继续和历史期间或预算目标对比。`;
    }
    if (positiveRatios.length) {
      return `这些比率类指标是在同一口径下计算的，适合一起观察结构变化；单期结果更适合继续和历史期间对比。`;
    }
  }

  if (margin && Number.isFinite(margin.number)) {
    if (margin.number < 0) {
      return `${margin.column}为负，说明当前口径下收入、成本或利润项组合后呈现压力，建议后续结合明细或历史趋势继续看原因。`;
    }
    if (margin.number >= 15) {
      return `从这个单期结果看盈利空间相对更明显；后续可以和历史期间或预算口径一起看趋势。`;
    }
    if (margin.number > 0) {
      return `当前口径下该指标为正，说明结果表中的收入能够形成利润；单期结果更适合继续和历史期间对比。`;
    }
    return `${margin.column}接近 0，说明当前口径下利润空间较薄，建议结合收入和成本明细继续看。`;
  }

  if (ratio && Number.isFinite(ratio.number)) {
    return `这类比率单独看只能说明当前口径下的水平，更适合和历史期间、预算或管理目标一起比较。`;
  }

  if (revenue && cost && Number.isFinite(revenue.number) && Number.isFinite(cost.number)) {
    const direction = revenue.number >= cost.number ? "高于" : "低于";
    return `从收入和成本的关系看，${revenue.column}${direction}${cost.column}，可以继续结合利润率或期间趋势判断经营质量。`;
  }

  if (profit && Number.isFinite(profit.number)) {
    return profit.number >= 0
      ? `${profit.column}为正，说明当前筛选口径下已形成利润；如果要判断质量，建议继续结合收入规模和利润率。`
      : `${profit.column}为负，说明当前筛选口径下利润承压；建议继续查看成本、费用或期间变化。`;
  }

  const amountItems = visible.filter(item => !isPercentDisplayFormat(item.format) && Number.isFinite(item.number));
  if (amountItems.length >= 2) {
    return "这些数值是在同一筛选口径下并列查询的结果，适合放在一起看规模、结构和相互关系。";
  }
  return "";
}

function presentationInsightFromSingleRow(columns = [], row = {}, formats = []) {
  const visible = columns
    .map(column => ({
      column,
      value: row?.[column],
      number: displayNumberForObservation(column, row?.[column], formats),
      format: displayFormatForColumn(formats, column)
    }))
    .filter(item => item.value != null && item.value !== "" && Number.isFinite(item.number));
  if (!visible.length) return "";
  const percentItems = visible.filter(item => isPercentDisplayFormat(item.format));
  if (percentItems.length) {
    const negative = percentItems.filter(item => item.number < 0);
    if (negative.length) {
      return `${negative.map(item => item.column).join("、")}为负，说明当前口径下这些比率指标需要关注，建议继续按期间或明细拆分定位原因。`;
    }
    return "这些比率类结果更适合结合历史期间或预算目标一起看，这样能判断当前水平是改善、稳定还是承压。";
  }
  if (visible.length >= 2) {
    return "这些指标在同一口径下并列展示，适合先看规模和结构；如果要判断好坏，还需要继续和历史期间、预算或组织维度对比。";
  }
  return "当前结果给出了单一指标数值，更适合作为基准；后续可以按期间、组织或科目明细继续拆分看趋势和结构。";
}

function formatExecutionRowsForDisplay(execution, formats = []) {
  const columns = execution?.columns || [];
  const rows = execution?.rows || [];
  if (!columns.length || !rows.length) return [];
  return rows.map(row => Object.fromEntries(columns.map(column => [
    column,
    formatValueWithDisplayFormat(row?.[column], displayFormatForColumn(formats, column))
  ])));
}

function buildDisplayTotalRow(columns = [], rows = [], formats = [], tableDirective = {}) {
  if (!columns.length || rows.length <= 1) return null;
  const totalColumns = exactResultColumns(tableDirective.total_columns || [], columns)
    .filter(column => rows.some(row => parseResultNumber(row?.[column]) != null));
  if (!totalColumns.length) return null;
  const labelColumn = exactResultColumn(tableDirective.label_column || "", columns)
    || columns.find(column => !totalColumns.includes(column));
  if (!labelColumn) return null;
  const labelText = String(tableDirective.label_text || "合计").trim() || "合计";
  const totalRow = {};
  columns.forEach(column => {
    if (totalColumns.includes(column)) {
      const sum = rows.reduce((total, row) => {
        const value = parseResultNumber(row?.[column]);
        return value == null ? total : total + value;
      }, 0);
      totalRow[column] = formatValueWithDisplayFormat(sum, displayFormatForColumn(formats, column)) || formatResultNumber(sum);
    } else {
      totalRow[column] = column === labelColumn ? labelText : "";
    }
  });
  totalRow.__isTotalRow = true;
  return totalRow;
}

function buildExecutionDisplay(payload, generated, execution) {
  const columns = execution?.columns || [];
  const directives = presentationDirectivesFromPayload(payload, columns);
  const formats = rendererDisplayFormats(payload, generated, columns);
  const rows = formatExecutionRowsForDisplay(execution, formats);
  const requiresTotalRow = directives.result_table.add_total_row;
  const totalRow = requiresTotalRow ? buildDisplayTotalRow(columns, execution?.rows || [], formats, directives.result_table) : null;
  return {
    columns,
    rows: totalRow ? [...rows, totalRow].slice(0, 51) : rows.slice(0, 50),
    formats,
    total_row_required: requiresTotalRow,
    total_row_applied: Boolean(totalRow),
    total_row: totalRow,
    presentation_directives: directives
  };
}


function currencyColumnForAmountColumn(column, columns = []) {
  const name = String(column || "");
  const candidates = [
    name.replace(/金额/g, "货币"),
    name.replace(/金额/g, "币种"),
    name.replace(/amount/ig, "currency"),
    name.replace(/amt/ig, "currency")
  ].filter(candidate => candidate && candidate !== name);
  const byKnownPair = {
    "总账金额": "总账货币",
    "本币金额": "本币货币",
    wsl: "rwcur",
    tsl: "rtcur"
  };
  if (byKnownPair[name]) candidates.unshift(byKnownPair[name]);
  return candidates.find(candidate => columns.includes(candidate)) || "";
}

function buildExecutionResultSummary(execution, displayFormats = []) {
  const columns = execution?.columns || [];
  const rows = execution?.rows || [];
  if (!columns.length || !rows.length) {
    return { row_count: execution?.row_count || 0, totals: [] };
  }
  const totals = columns
    .filter(column => isTotalableResultColumn(column, rows, displayFormats))
    .map(column => {
      const sum = rows.reduce((total, row) => {
        const value = parseResultNumber(row?.[column]);
        return value == null ? total : total + value;
      }, 0);
      const currencyColumn = currencyColumnForAmountColumn(column, columns);
      const currencies = currencyColumn
        ? [...new Set(rows.map(row => row?.[currencyColumn]).filter(Boolean).map(String))]
        : [];
      return {
        column,
        value: formatResultCellForAnswer(column, sum, displayFormats) || formatResultNumber(sum),
        raw_value: sum,
        currency_column: currencyColumn || null,
        currency: currencies.length === 1 ? currencies[0] : null
      };
    });
  return { row_count: execution.row_count || rows.length, totals };
}

function resultPeriodContext(execution = {}) {
  const columns = execution?.columns || [];
  const rows = execution?.rows || [];
  if (!columns.length || !rows.length) return { period_column: "", periods: [] };
  const periodColumn = columns.find(column => /(期间|年月|月份|年度|年份|period|year|month|date)/i.test(String(column || "")));
  if (!periodColumn) return { period_column: "", periods: [] };
  const periods = [...new Set(rows.map(row => row?.[periodColumn]).filter(value => value != null && value !== "").map(String))];
  if (!periods.length) return { period_column: periodColumn, periods: [] };
  return {
    period_column: periodColumn,
    periods,
    current_period: periods[periods.length - 1] || "",
    comparison_periods: periods.slice(0, -1)
  };
}

function ensureFinalAnswerPeriodContext(finalData, execution) {
  const context = resultPeriodContext(execution);
  if (!context.periods || context.periods.length < 2) return finalData;
  const answer = String(finalData?.answer || "").trim();
  const missing = context.periods.filter(period => period && !answer.includes(period));
  if (!missing.length) return finalData;
  const periodText = context.comparison_periods?.length
    ? `本次结果按${context.period_column}对比：${context.comparison_periods.join("、")} 对比 ${context.current_period}。`
    : `本次结果包含${context.period_column}：${context.periods.join("、")}。`;
  return {
    ...finalData,
    answer: [periodText, answer].filter(Boolean).join(" "),
    warnings: finalData?.warnings || []
  };
}

function resultSummaryText(summary) {
  const totals = summary?.totals || [];
  if (!totals.length) return "";
  return totals
    .map(item => `${item.column}合计为${item.value}${item.currency ? ` ${item.currency}` : ""}`)
    .join("，");
}

function hasAnalyticalResultDimension(execution) {
  const columns = execution?.columns || [];
  const rows = execution?.rows || [];
  if (rows.length <= 1) return false;
  return columns.some(column => /(年份|年度|年月|月份|季度|期间|日期|year|month|period|date)/i.test(String(column || "")));
}

function deterministicAnswerFromExecution(execution, generated, mandatoryContext, payload) {
  const columns = execution?.columns || [];
  const rows = execution?.rows || [];
  if (rows.length !== 1 || !columns.length || columns.length > 8) return null;
  const row = rows[0] || {};
  const displayFormats = rendererDisplayFormats(payload, generated, columns);
  const labelMap = {
    total_rows: "共有",
    row_count: "共有",
    count: "共有",
    cnt: "共有"
  };
  const parts = columns.map(column => {
    const value = row[column];
    if (value == null || value === "") return "";
    const lower = String(column).toLowerCase();
    if (labelMap[lower]) {
      return `${labelMap[lower]} ${Number(value).toLocaleString("zh-CN")} 条数据`;
    }
    return `${column}为${formatResultCellForAnswer(column, value, displayFormats)}`;
  }).filter(Boolean);
  if (!parts.length) return null;
  const observation = singleRowObservationFromResult(columns, row, displayFormats);
  const presentationInsight = !observation && resultPresentationRequiresInsight(payload)
    ? presentationInsightFromSingleRow(columns, row, displayFormats)
    : "";
  const formulaNotes = selectedDerivedMetricFormulaNotes(payload, generated);
  const filters = (mandatoryContext?.sql_filters || [])
    .map(item => item.reason || item.source || item.id)
    .filter(Boolean);
  const suffix = filters.length ? `口径：${compactList(filters, 6)}。` : "";
  return {
    answer: [
      `${parts.join("，")}。`,
      formulaNotes.length ? `计算公式：${formulaNotes.join("；")}。` : "",
      observation || presentationInsight || "",
      suffix
    ].filter(Boolean).join(" "),
    answer_type: "final_answer",
    warnings: generated?.warnings || []
  };
}

function enforceAnswerResultSummary(finalData, execution, generated, payload) {
  const displayFormats = rendererDisplayFormats(payload, generated, execution?.columns || []);
  const summary = buildExecutionResultSummary(execution, displayFormats);
  if ((execution?.rows || []).length <= 1) return { finalData, summary };
  const summaryLine = resultSummaryText(summary);
  if (!summaryLine) return { finalData, summary };
  if (hasAnalyticalResultDimension(execution) && finalData?.answer) {
    return { finalData, summary };
  }
  const rowCount = execution?.row_count || execution?.rows?.length || 0;
  const deterministicAnswer = `已查询到${rowCount}行，${summaryLine}。`;
  return {
    summary,
    finalData: {
      ...finalData,
      answer: deterministicAnswer,
      answer_type: finalData.answer_type || "final_answer",
      warnings: finalData.warnings || []
    }
  };
}

function buildFinalAnswerMessages({ payload, generated, validation, execution, resultSets = [], ruleContractFeedback = null }) {
  const displayFormats = rendererDisplayFormats(payload, generated, execution?.columns || []);
  const displayRows = formatExecutionRowsForDisplay(execution, displayFormats).slice(0, 80);
  const resultSummary = buildExecutionResultSummary(execution, displayFormats);
  const periodContext = resultPeriodContext(execution);
  const answerResultSets = (Array.isArray(resultSets) ? resultSets : [])
    .filter(item => item?.execution?.executed)
    .slice(0, 8)
    .map(item => {
      const formats = Array.isArray(item?.display?.formats)
        ? item.display.formats
        : rendererDisplayFormats(payload, { ...generated, display_formats: item?.display_formats || [] }, item.execution?.columns || []);
      return {
        key: item.key,
        title: item.title,
        purpose: item.purpose,
        applied_rule_keys: item.applied_rule_keys || [],
        sql: item.sql,
        executed: true,
        row_count: item.execution.row_count,
        columns: item.execution.columns,
        rows: formatExecutionRowsForDisplay(item.execution, formats).slice(0, 30),
        display_formats: formats,
        presentation_directives: item.result_presentation_directives || null,
        result_summary: buildExecutionResultSummary(item.execution, formats)
      };
    });
  const formulaNotes = selectedDerivedMetricFormulaNotes(payload, generated);
  const presentationDirectives = presentationDirectivesFromPayload(payload, execution?.columns || []);
  const presentationRequirements = Array.isArray(semanticCatalog(payload).result_presentation)
    ? semanticCatalog(payload).result_presentation.slice(0, 8).map(item => ({
        key: item.key || item.key_name,
        name: item.name,
        content: presentationRuleText(item),
        applies_to: item.applies_to || item.presentation_stages || item.spec?.applies_to || item.spec?.presentation_stages || []
      }))
    : [];
  const schema = {
    answer: "string",
    answer_type: "final_answer | empty_result | clarification_needed",
    applied_rule_keys: ["renderer rule key actually fulfilled by this answer and its result tables"],
    not_applicable_rules: [{ key: "renderer rule key", reason: "explicit applicability condition not satisfied" }],
    warnings: ["string"]
  };
  return [
    {
      role: "system",
      content: [
        "你是问数结果解释助手。现在 SQL 已经执行，你要根据执行结果回答用户。",
        "只能根据 result.rows 和 result_sets 中的数据回答，不要补造数据。",
        "如果 result_sets 非空，说明一个问题返回了多个独立结果集。必须综合所有结果集回答，按 title/purpose 区分其业务用途，不得因为字段结构不同而遗漏其中任何一张。",
        "如果 display_formats 指定了某列的展示口径，例如 percent、suffix、precision，回答必须使用该展示口径，不要改回数据库原始小数。",
        "result_presentation 是最终回答/展示要求，必须遵守；例如要求百分数、单位、总结、图表或原始项展示时，回答要按这些要求组织。",
        "mandatory_context.stages.renderer_rule 是本轮目标表的回答规则契约。priority>=100 的规则必须逐条处置：实际落实后写入 applied_rule_keys；只有规则正文明确声明的适用条件不成立时，才能写入 not_applicable_rules 并给出具体理由。",
        "规则要求固定文字、截止日期、对象名称或提醒语时，answer 必须真正包含完整信息，不能只在 applied_rule_keys 中声称已执行。runtime_context.current_date 是本次系统日期；规则要求前一天或上月末时据此计算。",
        "result_sets 中已经真实生成的独立表格也属于 renderer_rule 的执行证据。规则要求三张表时，必须确认对应结果集均存在，不能把三张表只概括成一个数字。",
        "输出前检查 mandatory_context.required_stage_rule_keys.renderer_rule：每个 key 必须出现在 applied_rule_keys 或 not_applicable_rules 中。",
        "如果 rule_contract_feedback 存在，必须重写完整 answer 并补齐其中 missing_rule_keys；不要只解释遗漏原因。",
        "presentation_directives 是展示规则编译后的结构化结果；最终回答应优先遵守其中 answer 和 display_formats 的要求。",
        "如果 presentation_directives.answer.require_formula=true，并且 selected_metric_formulas 非空，回答中必须简短写出这些公式。",
        "如果 knowledge_metrics 非空，即使企业语义目录没有父指标，也要说明这些指标本次按通行定义计算，并简短给出公式；不要把模型知识说成企业已配置口径。",
        "如果 presentation_directives.answer.require_insight=true，回答需要补充一句基于结果值的业务判断。",
        "如果回答涉及合计、总额、金额汇总，必须使用 result_summary.totals 中的值，禁止自行心算或改写。",
        "如果 result_period_context 中有多个期间，回答必须点明当前期和对比期；不要只说同比、增长而省略比较基准。",
        "如果结果为空，要明确说未查到数据，并结合 SQL 口径说明可能原因。",
        "回答要自然，不要只机械复述字段和值。推荐结构：先给结论，再补一句口径或解释；如果结果是比率、周转率、利润率等指标，可以用一句话说明它代表什么，但只能基于已命中的指标和结果，不要扩展到数据库没有返回的数据。",
        "当结果包含经营、盈利、偿债、现金、周转等业务指标时，必须补一句“整体来看/从结果看/需要关注”的业务判断。判断要来自结果表中的列和值，例如盈利水平、现金保障、偿债压力、增长放缓或结构变化；不要空泛地说“仅供参考”。",
        "如果结果有多列，先概括核心结论，再按用户问题顺序列出关键数值。不要输出 Markdown 表格。",
        "不要自行生成表格或 display；页面表格由后端使用数据库真实执行结果渲染。",
        "禁止出现“分子/分母”表述。",
        `严格按这个 JSON schema 输出：${JSON.stringify(schema)}`,
        "只输出 JSON，不要输出 Markdown。"
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({
        question: payload.question,
        runtime_context: {
          current_date: new Intl.DateTimeFormat("zh-CN", {
            timeZone: "Asia/Shanghai",
            year: "numeric",
            month: "2-digit",
            day: "2-digit"
          }).format(new Date())
        },
        qa_config: payload.qa_config || null,
        mandatory_context: mandatoryContextForStage(payload.mandatory_context, "renderer_rule"),
        rule_contract_feedback: ruleContractFeedback,
        sql: validation?.sql || generated?.sql || "",
        decision: generated.decision,
        sql_plan: generated.sql_plan,
        result: {
          executed: execution.executed,
          row_count: execution.row_count,
          columns: execution.columns,
          rows: displayRows
        },
        result_sets: answerResultSets,
        display_formats: displayFormats,
        presentation_directives: presentationDirectives,
        result_presentation: presentationRequirements,
        selected_metric_formulas: formulaNotes,
        knowledge_metrics: knowledgeMetricsFromPlan(payload?.retrieval_plan),
        result_period_context: periodContext,
        result_summary: resultSummary
      })
    }
  ];
}

function normalizeFinalAnswerRuleData(data) {
  const normalized = data && typeof data === "object" ? { ...data } : {};
  normalized.applied_rule_keys = [...new Set((Array.isArray(normalized.applied_rule_keys) ? normalized.applied_rule_keys : [])
    .map(value => String(value || "").trim())
    .filter(Boolean))];
  normalized.not_applicable_rules = (Array.isArray(normalized.not_applicable_rules) ? normalized.not_applicable_rules : [])
    .map(item => typeof item === "string" ? { key: item, reason: "" } : item)
    .map(item => ({
      key: String(item?.key || "").trim(),
      reason: String(item?.reason || "").trim()
    }))
    .filter(item => item.key);
  if (!Array.isArray(normalized.warnings)) normalized.warnings = [];
  return normalized;
}

async function callFinalAnswerWithRuleCoverage(args, options = {}) {
  const maxTokens = Number(options.maxTokens || 2400);
  let response = await callModelJson(
    buildFinalAnswerMessages(args),
    { temperature: 0.08, maxTokens }
  );
  let data = normalizeFinalAnswerRuleData(response.data);
  let coverage = ruleCoverageForStage(args.payload?.mandatory_context, "renderer_rule", data);
  if (!coverage.ok) {
    const repaired = await callModelJson(
      buildFinalAnswerMessages({
        ...args,
        ruleContractFeedback: {
          stage: "renderer_rule",
          missing_rule_keys: coverage.missing_rule_keys,
          previous_answer: data
        }
      }),
      { temperature: 0.03, maxTokens: Math.max(maxTokens, 3200) }
    );
    data = normalizeFinalAnswerRuleData(repaired.data);
    coverage = ruleCoverageForStage(args.payload?.mandatory_context, "renderer_rule", data);
    response = {
      ...repaired,
      usage: {
        initial: response.usage,
        repair: repaired.usage
      }
    };
  }
  if (!coverage.ok) {
    data.warnings = [
      ...new Set([
        ...(data.warnings || []),
        `最终回答仍未完整落实强制规则：${coverage.missing_rule_keys.join("、")}`
      ])
    ];
  }
  data.rule_execution = coverage;
  return { ...response, data, rule_coverage: coverage };
}

function normalizeGeneratedSqlData(data, payload) {
  const normalized = normalizeModelData(data, payload);
  if (!normalized.decision) normalized.decision = {};
  if (!Array.isArray(normalized.decision.selected_metric_keys)) {
    normalized.decision.selected_metric_keys = normalized.decision.selected_metric_key ? [normalized.decision.selected_metric_key] : [];
  }
  normalized.decision.selected_metric_keys = [
    ...new Set([
      ...(payload?.retrieval_plan?.selected_metric_keys || []),
      ...(normalized.decision.selected_metric_keys || [])
    ].filter(Boolean))
  ];
  if (!normalized.decision.selected_metric_key && normalized.decision.selected_metric_keys.length) {
    normalized.decision.selected_metric_key = normalized.decision.selected_metric_keys[0];
  }
  if (!Array.isArray(normalized.decision.selected_rule_keys)) normalized.decision.selected_rule_keys = [];
  normalized.decision.selected_rule_keys = [
    ...new Set([
      ...(payload?.retrieval_plan?.selected_rule_keys || []),
      ...(normalized.decision.selected_rule_keys || [])
    ].filter(Boolean))
  ];
  if (!normalized.decision.intent || normalized.decision.intent === "unknown") {
    normalized.decision.intent = payload?.retrieval_plan?.intent || "unknown";
  }
  if (!Array.isArray(normalized.sql_plan)) normalized.sql_plan = [];
  normalized.sql_plan = [
    ...(payload?.retrieval_plan?.sql_plan || []),
    ...normalized.sql_plan
  ];
  normalized.display_formats = [
    ...(payload?.retrieval_plan?.display_formats || []),
    ...(Array.isArray(normalized.display_formats) ? normalized.display_formats : [])
  ];
  normalized.applied_rule_keys = [...new Set((Array.isArray(normalized.applied_rule_keys) ? normalized.applied_rule_keys : [])
    .map(value => String(value || "").trim())
    .filter(Boolean))];
  normalized.not_applicable_rules = (Array.isArray(normalized.not_applicable_rules) ? normalized.not_applicable_rules : [])
    .map(item => typeof item === "string" ? { key: item, reason: "" } : item)
    .map(item => ({
      key: String(item?.key || "").trim(),
      reason: String(item?.reason || "").trim()
    }))
    .filter(item => item.key);
  if (!Array.isArray(normalized.warnings)) normalized.warnings = [];
  return normalized;
}

function ruleCoverageForStage(context, stage, data) {
  const required = [...new Set(context?.required_stage_rule_keys?.[stage] || [])];
  const applied = new Set([
    ...(Array.isArray(data?.applied_rule_keys) ? data.applied_rule_keys : []),
    ...(Array.isArray(data?.result_sets)
      ? data.result_sets.flatMap(item => Array.isArray(item?.applied_rule_keys) ? item.applied_rule_keys : [])
      : [])
  ].map(String));
  const notApplicable = new Map((Array.isArray(data?.not_applicable_rules) ? data.not_applicable_rules : [])
    .map(item => [String(item?.key || ""), String(item?.reason || "")])
    .filter(([key]) => key));
  const dispositioned = new Set([...applied, ...notApplicable.keys()]);
  return {
    stage,
    required_rule_keys: required,
    applied_rule_keys: [...applied],
    not_applicable_rules: [...notApplicable].map(([key, reason]) => ({ key, reason })),
    missing_rule_keys: required.filter(key => !dispositioned.has(String(key))),
    ok: required.every(key => dispositioned.has(String(key)))
  };
}

function resultSetTraceSuffix(definition, index) {
  const key = String(definition?.key || `result_${index + 1}`)
    .replace(/[^A-Za-z0-9_\-]+/g, "_")
    .slice(0, 40);
  return `${index + 1}_${key || `result_${index + 1}`}`;
}

function failedResultSet(definition, sql, validation, message, warnings = []) {
  return {
    key: definition.key,
    title: definition.title,
    purpose: definition.purpose,
    applied_rule_keys: definition.applied_rule_keys || [],
    sql: validation?.sql || sql || "",
    sql_validation: validation?.ok === false
      ? validation
      : validation
        ? { ok: true, ...validation }
        : { ok: false, error: message },
    execution: { executed: false, columns: [], rows: [], row_count: 0, message },
    result_presentation_directives: null,
    display: null,
    warnings: [...new Set([...(warnings || []), message].filter(Boolean))],
    error: message
  };
}

async function executeGeneratedResultSet({
  definition,
  index,
  payload,
  generated,
  mandatoryContext,
  entityResolutionCache,
  pushTrace,
  emitProgress
}) {
  const suffix = resultSetTraceSuffix(definition, index);
  const label = definition.title || `查询结果 ${index + 1}`;
  let working = normalizeGeneratedSqlData({
    ...generated,
    sql: definition.sql,
    result_sets: [],
    display_formats: [
      ...(Array.isArray(generated?.display_formats) ? generated.display_formats : []),
      ...(Array.isArray(definition.display_formats) ? definition.display_formats : [])
    ]
  }, payload);
  enforceMandatoryContextOnGenerated(working, mandatoryContext, payload);

  const entityStartedAt = Date.now();
  const entityResolution = await resolveGeneratedTextEntities(working.sql, payload, entityResolutionCache);
  working.sql = entityResolution.sql;
  if (entityResolution.resolutions.length) {
    working.sql_plan = [
      ...(working.sql_plan || []),
      ...entityResolution.resolutions.map(item => ({
        part: "WHERE",
        value: item.applied_sql,
        source: "entity_resolution",
        note: `用户名称“${item.input_value}”已根据数据库候选解析为 ${item.matched_values.join("、")}`
      }))
    ];
    pushTrace(traceItem(
      "entity_resolution",
      `解析业务名称：${label}`,
      "success",
      entityStartedAt,
      entityResolution.resolutions.map(item => `${item.field}: ${item.input_value} -> ${item.matched_values.join(" / ")}`).join("；"),
      { key: definition.key, title: label, resolutions: entityResolution.resolutions },
      `“${label}”中的业务名称已用数据库登记值校准。`,
      {
        id: `entity_resolution_${suffix}`,
        purpose: "处理用户简称与数据库完整登记名称不一致的问题。",
        finding: entityResolution.resolutions.map(item => `${item.input_value} -> ${item.matched_values.join(" / ")}`).join("；"),
        decision: "使用数据候选改写文本实体过滤，不改变编码和固定口径。"
      }
    ));
  }

  let validation;
  let startedAt = Date.now();
  emitProgress(
    `sql_validation_${suffix}`,
    "sql_validation",
    `检查结果集：${label}`,
    startedAt,
    `正在独立校验“${label}”的只读 SQL。`,
    {
      purpose: "每个结果集独立做只读和授权表校验。",
      finding: "等待校验结果。",
      decision: "当前结果集校验通过后才会执行，不影响其他结果集。"
    }
  );
  try {
    validation = validateReadOnlySql(working.sql, payload);
    pushTrace(traceItem(
      "sql_validation",
      `检查结果集：${label}`,
      "success",
      startedAt,
      `引用表：${validation.usedTables.join(", ") || "无"}`,
      { key: definition.key, title: label, ...validation },
      `“${label}”已通过只读和授权表校验。`,
      {
        id: `sql_validation_${suffix}`,
        purpose: "每个结果集独立做只读和授权表校验。",
        finding: `引用表：${validation.usedTables.join("、") || "无"}`,
        decision: "允许执行当前结果集。"
      }
    ));
  } catch (error) {
    const message = error.message || String(error);
    pushTrace(traceItem(
      "sql_validation",
      `检查结果集：${label}`,
      "failed",
      startedAt,
      message,
      { key: definition.key, title: label, sql: working.sql, error: message },
      `“${label}”没有通过安全校验；其他结果集仍可继续。`,
      {
        id: `sql_validation_${suffix}`,
        purpose: "阻止不安全或越权 SQL。",
        finding: message,
        decision: "仅停止当前结果集。"
      }
    ));
    return failedResultSet(definition, working.sql, { ok: false, error: message }, `SQL 校验失败：${message}`, working.warnings);
  }

  let execution;
  startedAt = Date.now();
  emitProgress(
    `sql_execution_${suffix}`,
    "sql_execution",
    `查询结果集：${label}`,
    startedAt,
    `正在独立查询“${label}”。`,
    {
      purpose: "执行当前结果集的已校验 SQL。",
      finding: "等待数据库返回。",
      decision: "当前结果集失败时尝试单独修复，不丢弃其他成功结果。"
    }
  );
  try {
    execution = await executeSql(validation.sql);
    pushTrace(traceItem(
      "sql_execution",
      `查询结果集：${label}`,
      execution.executed ? "success" : "skipped",
      startedAt,
      execution.executed ? `返回 ${execution.row_count} 行` : execution.message,
      { key: definition.key, title: label, ...execution },
      execution.executed ? `“${label}”已返回 ${execution.row_count} 行。` : `“${label}”未执行数据库查询。`,
      {
        id: `sql_execution_${suffix}`,
        purpose: "执行当前结果集的已校验 SQL。",
        finding: execution.executed ? `返回 ${execution.row_count} 行` : execution.message,
        decision: execution.executed ? "保留该结果集。" : "保留 SQL，标记为未执行。"
      }
    ));
  } catch (error) {
    const originalError = error.message || String(error);
    pushTrace(traceItem(
      "sql_execution",
      `查询结果集：${label}`,
      "failed",
      startedAt,
      originalError,
      { key: definition.key, title: label, sql: validation.sql, error: originalError },
      `“${label}”执行失败，正在只修复这一条 SQL；其他结果集不受影响。`,
      {
        id: `sql_execution_${suffix}`,
        purpose: "执行当前结果集的已校验 SQL。",
        finding: originalError,
        decision: "进入当前结果集的自动修复。"
      }
    ));

    const repairStartedAt = Date.now();
    emitProgress(
      `sql_repair_${suffix}`,
      "sql_repair",
      `修复结果集：${label}`,
      repairStartedAt,
      `数据库返回错误，正在单独重写“${label}”的 SQL。`,
      {
        purpose: "只修复当前失败结果集，不重新生成整轮答案。",
        finding: originalError,
        decision: "修复后重新校验并执行当前结果集。"
      }
    );
    try {
      const repair = await callModelJson(
        buildSqlRepairMessages({
          payload,
          generated: working,
          validation,
          error: originalError,
          attempt: 1
        }),
        { temperature: 0.03, maxTokens: 4096 }
      );
      const repaired = normalizeGeneratedSqlData({
        ...working,
        ...(repair.data || {}),
        result_sets: []
      }, payload);
      if (!repaired.sql) throw new Error("模型没有返回修复后的 SQL");
      if (normalizeSql(repaired.sql) === normalizeSql(validation.sql)) {
        throw new Error("模型返回的修复 SQL 与失败 SQL 相同");
      }
      working = repaired;
      enforceMandatoryContextOnGenerated(working, mandatoryContext, payload);
      validation = validateReadOnlySql(working.sql, payload);
      execution = await executeSql(validation.sql);
      pushTrace(traceItem(
        "sql_repair",
        `修复结果集：${label}`,
        execution.executed ? "success" : "skipped",
        repairStartedAt,
        execution.executed ? `修复后返回 ${execution.row_count} 行` : execution.message,
        { key: definition.key, title: label, sql: validation.sql, execution },
        execution.executed ? `“${label}”已独立修复并执行成功。` : `“${label}”修复后未执行数据库查询。`,
        {
          id: `sql_repair_${suffix}`,
          purpose: "只修复当前失败结果集。",
          finding: execution.executed ? `返回 ${execution.row_count} 行` : execution.message,
          decision: execution.executed ? "保留修复后的结果。" : "保留修复 SQL，标记为未执行。"
        }
      ));
    } catch (repairError) {
      const repairMessage = repairError.message || String(repairError);
      const message = `SQL 执行失败：${originalError}；自动修复失败：${repairMessage}`;
      pushTrace(traceItem(
        "sql_repair",
        `修复结果集：${label}`,
        "failed",
        repairStartedAt,
        repairMessage,
        { key: definition.key, title: label, sql: validation.sql, original_error: originalError, repair_error: repairMessage },
        `“${label}”修复失败；已保留错误，其他结果集继续返回。`,
        {
          id: `sql_repair_${suffix}`,
          purpose: "只修复当前失败结果集。",
          finding: repairMessage,
          decision: "停止当前结果集，保留其他结果。"
        }
      ));
      return failedResultSet(definition, validation.sql, { ok: true, ...validation }, message, working.warnings);
    }
  }

  if (!execution?.executed) {
    return {
      key: definition.key,
      title: definition.title,
      purpose: definition.purpose,
      applied_rule_keys: definition.applied_rule_keys || [],
      sql: validation.sql,
      sql_validation: { ok: true, ...validation },
      execution,
      result_presentation_directives: null,
      display: null,
      warnings: [...new Set([...(working.warnings || []), execution?.message].filter(Boolean))],
      error: ""
    };
  }

  const presentationStartedAt = Date.now();
  emitProgress(
    `result_presentation_${suffix}`,
    "result_presentation",
    `理解展示规则：${label}`,
    presentationStartedAt,
    `正在把“${label}”的展示要求编译成结构化指令。`,
    {
      purpose: "让每个结果集按自己的字段结构应用展示规则。",
      finding: `结果列：${compactList(execution.columns || [], 8) || "无"}`,
      decision: "只影响当前表格展示，不修改 SQL 和原始数据。"
    }
  );
  const presentationPayload = {
    ...payload,
    generated_display_formats: working.display_formats || []
  };
  const directives = await resolveResultPresentationDirectives(
    presentationPayload,
    execution.columns || [],
    execution.rows || []
  );
  presentationPayload.result_presentation_directives = directives;
  const display = buildExecutionDisplay(presentationPayload, working, execution);
  pushTrace(traceItem(
    "result_presentation",
    `理解展示规则：${label}`,
    directives.warnings?.length ? "skipped" : "success",
    presentationStartedAt,
    presentationDirectiveNames(directives).join("、") || "没有需要执行的展示指令",
    { key: definition.key, title: label, directives },
    `“${label}”的展示指令已独立编译。`,
    {
      id: `result_presentation_${suffix}`,
      purpose: "让每个结果集按自己的字段结构应用展示规则。",
      finding: presentationDirectiveNames(directives).join("、") || "未产生展示指令",
      decision: "将指令应用到当前结果表。"
    }
  ));
  return {
    key: definition.key,
    title: definition.title,
    purpose: definition.purpose,
    applied_rule_keys: definition.applied_rule_keys || [],
    sql: validation.sql,
    sql_validation: { ok: true, ...validation },
    execution,
    result_presentation_directives: directives,
    display,
    warnings: [...new Set([...(working.warnings || []), ...(directives.warnings || [])].filter(Boolean))],
    error: ""
  };
}

function elapsedMs(startedAt) {
  return Date.now() - startedAt;
}

function traceItem(stage, label, status, startedAt, detail = "", artifact = null, summary = "", audit = {}) {
  const meta = audit && typeof audit === "object" ? audit : {};
  return {
    id: meta.id || meta.trace_id || "",
    stage,
    label,
    status,
    duration_ms: elapsedMs(startedAt),
    summary,
    detail,
    purpose: meta.purpose || "",
    finding: meta.finding || "",
    decision: meta.decision || "",
    conclusion: meta.conclusion || "",
    artifact
  };
}

function timingStepLabel(stage, label = "") {
  const map = {
    question_config: "应用问数配置",
    table_exploration: "查看数据源",
    agent_loop: "思考规划",
    knowledge_fallback: "补充通用指标公式",
    sql_resultset_lookup: "补查目录",
    retrieval_planning: "规划检索",
    semantic_plan: "校验语义计划",
    metric_expansion: "展开指标口径",
    sql_generation: "生成 SQL",
    mandatory_sql_enforcement: "落实固定口径",
    sql_validation: "校验 SQL",
    sql_execution: "执行查询",
    sql_repair: "自动修复 SQL",
    entity_resolution: "解析业务名称",
    result_presentation: "理解展示规则",
    answer_generation: "整理回答"
  };
  return String(label || "").trim() || map[stage] || stage || "执行步骤";
}

function timingStepSummary(item) {
  return String(
    item?.finding ||
      item?.decision ||
      item?.detail ||
      item?.summary ||
      item?.conclusion ||
      ""
  ).trim();
}

function buildTimingSteps(trace = []) {
  return (Array.isArray(trace) ? trace : [])
    .filter(item => item && item.status !== "running")
    .map((item, index) => {
      const duration = Number(item.duration_ms || 0);
      return {
        id: item.id || `${item.stage || "step"}_${index + 1}`,
        order: index + 1,
        stage: item.stage || "",
        label: timingStepLabel(item.stage, item.label),
        raw_label: item.label || "",
        status: item.status || "",
        duration_ms: Number.isFinite(duration) ? duration : 0,
        summary: timingStepSummary(item)
      };
    });
}

function compactList(values, max = 4) {
  const list = [...new Set((values || []).filter(Boolean).map(String))];
  if (list.length <= max) return list.join("、");
  return `${list.slice(0, max).join("、")}等 ${list.length} 项`;
}

function semanticEntryLabel(payload, type, key) {
  const entries = Array.isArray(semanticCatalog(payload)[type]) ? semanticCatalog(payload)[type] : [];
  const entry = entries.find(item => item?.key === key || item?.name === key);
  if (!entry) return key;
  return entry.name && entry.name !== key ? `${entry.name}（${key}）` : key;
}

function semanticEntryLabels(payload, type, keys, max = 4) {
  return compactList((keys || []).map(key => semanticEntryLabel(payload, type, key)), max);
}

function lookupRequestSummary(lookups, max = 3) {
  const items = (lookups || []).map(item => {
    const terms = compactList(item.terms || [], 4);
    return terms ? `${terms}` : "";
  }).filter(Boolean);
  return compactList(items, max);
}

function retrievalPlanSummary(payload, plan) {
  const metricText = semanticEntryLabels(payload, "business_metric", plan.selected_metric_keys, 4);
  const ruleText = semanticEntryLabels(payload, "logic_text", plan.selected_rule_keys, 3);
  const lookupText = lookupRequestSummary(plan.sql_resultset_lookups, 3);
  const base = metricText
    ? `先理解问题，确认可直接使用 ${metricText}`
    : "先理解问题，当前没有直接命中的业务指标";
  const rulePart = ruleText ? `，同时参考 ${ruleText}` : "";
  if (plan.needs_sql_resultset) {
    return `${base}${rulePart}；另有 ${lookupText || "部分对象"} 需要补编码或备注，所以会再查一次 SQL结果集。`;
  }
  return `${base}${rulePart}；这些依据已经足够进入 SQL 生成。`;
}

function resultsetRowSummary(resultsets) {
  const terms = new Set((resultsets || []).flatMap(item => item.query_terms || []).map(String));
  const rows = (resultsets || []).flatMap(item => item.rows || []);
  const codeColumns = [...new Set((resultsets || []).flatMap(item => item.code_columns || []))];
  const nameColumns = [...new Set((resultsets || []).flatMap(item => item.name_columns || []))];
  const fallbackCodeColumns = ["总账科目编码", "科目编码", "account_code", "code", "racct", "saknr", "hkont"];
  const fallbackNameColumns = ["总账科目名称", "科目名称", "account_name", "name", "txt20", "txt30", "txt50", "txtlg", "description"];
  const finalCodeColumns = codeColumns.length ? codeColumns : fallbackCodeColumns;
  const finalNameColumns = nameColumns.length ? nameColumns : fallbackNameColumns;
  const exactRows = rows.filter(row => terms.has(String(rowValueByColumns(row, finalNameColumns))));
  const selectedRows = exactRows.length ? exactRows : rows;
  return selectedRows.slice(0, 5).map(row => {
    const code = rowValueByColumns(row, finalCodeColumns);
    const name = rowValueByColumns(row, finalNameColumns);
    return code && name ? `${name}=${code}` : name || code || "";
  }).filter(Boolean).join("、");
}

function resolvedItemsFromResultsets(plan, resultsets = []) {
  const terms = coverageTermsNeedingLookup(plan);
  const items = [];
  for (const term of terms) {
    const normalizedTerm = normalizeCandidateText(term);
    let best = null;
    for (const resultset of resultsets || []) {
      const columns = resultset.columns || Object.keys((resultset.rows || [])[0] || {});
      const lookupColumns = {
        codeColumns: resultset.code_columns?.length ? resultset.code_columns : resultsetLookupColumns(columns).codeColumns,
        nameColumns: resultset.name_columns?.length ? resultset.name_columns : resultsetLookupColumns(columns).nameColumns,
        searchableColumns: resultset.searchable_columns?.length ? resultset.searchable_columns : resultsetLookupColumns(columns).searchableColumns
      };
      for (const row of resultset.rows || []) {
        const name = rowValueByColumns(row, lookupColumns.nameColumns);
        const code = rowValueByColumns(row, lookupColumns.codeColumns);
        const searchableValues = [...new Set([
          name,
          code,
          ...lookupColumns.searchableColumns.map(column => row?.[column])
        ].filter(value => value != null && String(value) !== "").map(String))];
        const exact = searchableValues.some(value => normalizeCandidateText(value) === normalizedTerm);
        const score = exact
          ? 2
          : Math.max(...searchableValues.map(value => scoreCandidateValue(term, value)), 0);
        if (!best || score > best.score) {
          const remark = String(row?.备注 || row?.remark || row?.note || "").trim();
          const needsReverse = /需要置反/.test(remark) && !/(不需要置反|无需置反|不置反)/.test(remark);
          best = {
            item: term,
            name,
            code,
            score,
            resultset_key: resultset.key,
            remark,
            result_factor: needsReverse ? -1 : 1
          };
        }
      }
    }
    if (best && best.score >= 0.42) items.push(best);
  }
  return items;
}

function sqlAliasSummary(sql) {
  const value = String(sql || "");
  const backtickAliases = [...value.matchAll(/\bAS\s+`([^`]+)`/gi)].map(match => match[1].trim());
  const plainAliases = [...value.matchAll(/\bAS\s+([A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5（）() -]*?)(?=\s+(?:FROM|WHERE|GROUP|ORDER|HAVING|LIMIT|UNION)\b|,|$)/gi)]
    .map(match => match[1].trim());
  return [...new Set([...backtickAliases, ...plainAliases])]
    .filter(Boolean);
}

function plannedOutputColumns(payload) {
  const outputs = payload?.retrieval_plan?.semantic_plan?.output;
  return [...new Set((Array.isArray(outputs) ? outputs : [])
    .map(item => String(item || "").trim())
    .filter(Boolean))];
}

function enforcePlannedOutputAliases(generated, payload) {
  const expected = plannedOutputColumns(payload);
  const actual = sqlAliasSummary(generated?.sql);
  const missing = expected.filter(name => !actual.includes(name));
  if (!missing.length) {
    return { applied: false, expected, actual, missing: [], reason: "输出列已符合语义计划" };
  }
  if (!expected.length || actual.length !== expected.length) {
    return {
      applied: false,
      expected,
      actual,
      missing,
      reason: `计划输出 ${expected.length} 列，SQL 实际输出 ${actual.length} 列，不能安全自动改名`
    };
  }
  const aliasMap = new Map(actual.map((name, index) => [name, expected[index]]));
  let replaced = 0;
  generated.sql = String(generated.sql || "").replace(
    /\bAS\s+(?:`([^`]+)`|([A-Za-z_][A-Za-z0-9_]*))/gi,
    (match, quotedAlias, plainAlias) => {
      const current = String(quotedAlias || plainAlias || "").trim();
      const next = aliasMap.get(current);
      if (!next || next === current) return match;
      replaced += 1;
      return `AS ${sqlIdentifier(next)}`;
    }
  );
  if (replaced !== actual.length) {
    return {
      applied: false,
      expected,
      actual: sqlAliasSummary(generated.sql),
      missing,
      reason: "SQL 别名结构不能安全映射到语义计划"
    };
  }
  generated.display_formats = (generated.display_formats || []).map(format => ({
    ...format,
    column: aliasMap.get(format?.column) || format?.column
  }));
  generated.sql_plan = [
    ...(generated.sql_plan || []),
    {
      part: "CHECK",
      value: expected.join("、"),
      source: "semantic_output_contract",
      note: "SQL 最终列名必须与 semantic_plan.output 保持一致。"
    }
  ];
  return {
    applied: true,
    expected,
    actual: sqlAliasSummary(generated.sql),
    missing: [],
    reason: "已按语义计划统一最终结果列名"
  };
}

function safePreview(value, max = 1200) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function sqlGenerationArtifact(generated) {
  return {
    intent: generated.decision?.intent || "",
    selected_metric_key: generated.decision?.selected_metric_key || null,
    selected_metric_keys: generated.decision?.selected_metric_keys || [],
    selected_rule_keys: generated.decision?.selected_rule_keys || [],
    confidence: generated.decision?.confidence ?? null,
    reason: generated.decision?.reason || "",
    sql_plan: (generated.sql_plan || []).slice(0, 12),
    sql: generated.sql || "",
    warnings: generated.warnings || []
  };
}

function sqlRepairArtifact({ failedSql, repairedSql, error, enforcement, validation, attempt }) {
  return {
    attempt,
    error,
    failed_sql: failedSql || "",
    repaired_sql: repairedSql || "",
    mandatory_enforcement: enforcement || null,
    validation: validation ? validationArtifact(validation) : null
  };
}

function validationArtifact(validation) {
  return {
    used_tables: validation.usedTables || [],
    allowed_tables: validation.allowedTables || [],
    sql: validation.sql || ""
  };
}

function executionArtifact(execution) {
  return {
    executed: Boolean(execution.executed),
    row_count: execution.row_count || 0,
    columns: execution.columns || [],
    sample_rows: (execution.rows || []).slice(0, 5),
    message: execution.message || ""
  };
}

function answerArtifact(finalData) {
  return {
    answer_type: finalData.answer_type || "",
    answer: safePreview(finalData.answer || "", 800),
    warnings: finalData.warnings || []
  };
}

function retrievalPlanArtifact(plan) {
  return {
    intent: plan.intent || "",
    selected_metric_keys: plan.selected_metric_keys || [],
    selected_rule_keys: plan.selected_rule_keys || [],
    needs_sql_resultset: Boolean(plan.needs_sql_resultset),
    sql_resultset_lookups: plan.sql_resultset_lookups || [],
    coverage_checklist: plan.coverage_checklist || [],
    semantic_plan: plan.semantic_plan || {},
    display_formats: plan.display_formats || [],
    summary: plan.summary || "",
    warnings: plan.warnings || []
  };
}

function semanticCatalogKeySet(payload, type) {
  return new Set(semanticEntries(payload, type)
    .flatMap(entry => [entry?.key, entry?.name])
    .filter(Boolean)
    .map(String));
}

function semanticCatalogAnyKeySet(payload) {
  return new Set([
    "business_metric",
    "logic_text",
    "result_presentation",
    "sql_resultset",
    "standard_qa",
    "table_column_note"
  ].flatMap(type => [...semanticCatalogKeySet(payload, type)]));
}

function validateRetrievalPlanAgainstCatalog(payload, plan) {
  const next = normalizeRetrievalPlanData(plan || {});
  const metricKeys = semanticCatalogKeySet(payload, "business_metric");
  const ruleKeys = semanticCatalogKeySet(payload, "logic_text");
  const resultsetKeys = semanticCatalogKeySet(payload, "sql_resultset");
  const anySemanticKeys = semanticCatalogAnyKeySet(payload);
  const removed = { metrics: [], rules: [], resultsets: [] };
  next.selected_metric_keys = (next.selected_metric_keys || []).filter(key => {
    const ok = metricKeys.has(String(key));
    if (!ok) removed.metrics.push(key);
    return ok;
  });
  next.selected_rule_keys = (next.selected_rule_keys || []).filter(key => {
    const normalizedKey = String(key);
    const ok = ruleKeys.has(normalizedKey);
    if (!ok && metricKeys.has(normalizedKey) && !next.selected_metric_keys.includes(normalizedKey)) {
      next.selected_metric_keys.push(normalizedKey);
    }
    if (!ok && !anySemanticKeys.has(normalizedKey)) removed.rules.push(key);
    return ok;
  });
  next.sql_resultset_lookups = (next.sql_resultset_lookups || []).filter(item => {
    const ok = resultsetKeys.has(String(item.key));
    if (!ok) removed.resultsets.push(item.key);
    return ok;
  });
  next.needs_sql_resultset = Boolean(next.sql_resultset_lookups.length);
  const warnings = [];
  if (removed.metrics.length) warnings.push(`语义计划引用了不存在的业务指标，已忽略：${compactList(removed.metrics, 6)}`);
  if (removed.rules.length) warnings.push(`语义计划引用了不存在的业务规则，已忽略：${compactList(removed.rules, 6)}`);
  if (removed.resultsets.length) warnings.push(`语义计划引用了不存在的 SQL结果集，已忽略：${compactList(removed.resultsets, 6)}`);
  next.warnings = [...new Set([...(next.warnings || []), ...warnings])];
  return {
    plan: next,
    removed,
    warnings,
    changed: Boolean(removed.metrics.length || removed.rules.length || removed.resultsets.length)
  };
}

function semanticEntries(payload, type) {
  const entries = semanticCatalog(payload)[type];
  return Array.isArray(entries) ? entries : [];
}

function buildMandatoryContext(payload, plan) {
  const manifest = buildRuleExecutionManifest(payload, plan);
  const semanticFilters = semanticSqlFilters(payload, plan);
  const ruleKeys = manifest.rule_keys;
  const filters = [];
  const seenFilters = new Set();
  semanticFilters.forEach(item => {
    const signature = sqlConditionSignature(item?.sql || "");
    if (!signature || seenFilters.has(signature)) return;
    seenFilters.add(signature);
    filters.push(item);
  });
  const warnings = [];
  return {
    enabled: Boolean(ruleKeys.length || filters.length || warnings.length),
    rule_keys: [...new Set(ruleKeys)],
    rule_labels: semanticEntryLabels(payload, "logic_text", ruleKeys, 8),
    scoped_tables: manifest.scoped_tables,
    rules: manifest.rules,
    stages: manifest.stages,
    required_rule_keys: manifest.required_rule_keys,
    required_stage_rule_keys: manifest.required_stage_rule_keys,
    sql_filters: filters,
    warnings
  };
}

function mandatoryContextSummary(context) {
  if (!context?.enabled) return "没有识别到需要强制注入的公共口径。";
  const parts = [];
  if (context.rule_labels) parts.push(`规则：${context.rule_labels}`);
  if (context.sql_filters?.length) {
    parts.push(`过滤：${context.sql_filters.map(item => item.sql.replace(/\s+/g, " ")).join("；")}`);
  }
  if (context.warnings?.length) parts.push(`未强制项：${context.warnings.join("；")}`);
  return parts.join("；");
}

function mandatoryContextForStage(context, stage) {
  const rules = Array.isArray(context?.stages?.[stage]) ? context.stages[stage] : [];
  const required = Array.isArray(context?.required_stage_rule_keys?.[stage])
    ? context.required_stage_rule_keys[stage]
    : [];
  return {
    enabled: Boolean(rules.length || context?.sql_filters?.length),
    scoped_tables: context?.scoped_tables || [],
    rule_keys: rules.map(rule => rule.key),
    required_rule_keys: required,
    required_stage_rule_keys: { [stage]: required },
    stages: { [stage]: rules },
    sql_filters: stage === "sql_generation" ? context?.sql_filters || [] : [],
    warnings: context?.warnings || []
  };
}

function semanticCatalogForSqlPrompt(payload) {
  const catalog = semanticCatalog(payload);
  return {
    ...catalog,
    logic_text: []
  };
}

function tableContextForPlanner(context) {
  return (Array.isArray(context) ? context : []).map(table => ({
    table: table?.table || "",
    qualified_table: table?.qualified_table || "",
    columns: (Array.isArray(table?.columns) ? table.columns : []).map(column => ({
      name: column?.name || "",
      type: column?.type || "",
      comment: column?.comment || "",
      sample_values: (Array.isArray(column?.sample_values) ? column.sample_values : []).slice(0, 1)
    })),
    sample_rows: (Array.isArray(table?.sample_rows) ? table.sample_rows : []).slice(0, 1),
    sample_row_count: Number(table?.sample_row_count || 0),
    error: table?.error || ""
  }));
}

function mandatoryContextArtifact(context) {
  return {
    rule_keys: context?.rule_keys || [],
    rule_labels: context?.rule_labels || "",
    scoped_tables: context?.scoped_tables || [],
    rules: context?.rules || [],
    required_rule_keys: context?.required_rule_keys || [],
    required_stage_rule_keys: context?.required_stage_rule_keys || {},
    sql_filters: context?.sql_filters || [],
    warnings: context?.warnings || []
  };
}

function enforceMandatoryContextOnGenerated(generated, context, payload = null) {
  const filters = context?.sql_filters || [];
  if (!filters.length || !generated?.sql) {
    return { sql: generated?.sql || "", applied: [], replaced: [], skipped: [], warnings: context?.warnings || [] };
  }
  const targetTables = [
    ...selectedPayloadTables(payload || {}),
    ...catalogTables(payload || {})
  ];
  const enforcement = appendWhereConditions(generated.sql, filters, { targetTables });
  generated.sql = enforcement.sql;
  const forced = [...enforcement.applied, ...enforcement.replaced];
  if (forced.length) {
    generated.sql_plan = [
      ...(generated.sql_plan || []),
      ...forced.map(item => ({
        part: "WHERE",
        value: item.sql,
        source: item.source || "mandatory_context",
        note: `后端强制口径：${item.reason || item.id || ""}`.trim()
      }))
    ];
  }
  generated.warnings = [
    ...(generated.warnings || []),
    ...(context?.warnings || [])
  ].filter(Boolean);
  return { ...enforcement, warnings: context?.warnings || [] };
}

function metricCatalogMap(payload) {
  const metrics = Array.isArray(semanticCatalog(payload).business_metric)
    ? semanticCatalog(payload).business_metric
    : [];
  return new Map(metrics.map(metric => [metric.key, metric]));
}

function computableMetricKeys(payload, keys = []) {
  const metrics = metricCatalogMap(payload);
  const canCompute = (key, stack = []) => {
    const metric = metrics.get(key);
    if (!metric || stack.includes(key)) return false;
    if (metricKind(metric) !== "derived") {
      return Boolean(metricSourceTable(metric) && metricMeasure(metric).field);
    }
    const deps = metricDependencySpecs(metric);
    return Boolean(metricExpression(metric) && deps.length && deps.every(dep => canCompute(dep.metricKey, [...stack, key])));
  };
  return [...new Set(keys)].filter(key => canCompute(key));
}

function metricScopeExpression(metric) {
  const scope = metric?.scope_filter;
  const lines = Array.isArray(scope)
    ? scope
    : Array.isArray(scope?.expression_lines)
      ? scope.expression_lines
      : typeof scope === "string"
        ? scope.split(/\r?\n/)
        : [];
  return lines
    .map(line => String(line || "").trimEnd())
    .filter(Boolean)
    .join("\n")
    .replace(/^\s*AND\s+/i, "")
    .trim();
}

function metricSourceTable(metric) {
  return metric?.metric?.source_table || metric?.source_table || "";
}

function metricMeasure(metric) {
  const measure = metric?.metric?.measure || metric?.measure || {};
  return {
    field: measure.field || "",
    aggregation: String(measure.aggregation || "SUM").toUpperCase(),
    resultFactor: Number(measure.result_factor ?? 1)
  };
}

function metricKind(metric) {
  return metric?.metric_kind || metric?.entry?.metric_kind || "base";
}

function metricDependencies(metric) {
  const deps = Array.isArray(metric?.metric?.dependencies)
    ? metric.metric.dependencies
    : Array.isArray(metric?.dependency_keys)
      ? metric.dependency_keys
      : Array.isArray(metric?.dependencies)
        ? metric.dependencies
        : [];
  return deps
    .map(dep => typeof dep === "string" ? dep : dep?.metric_key || dep?.key || "")
    .filter(Boolean);
}

function metricExpression(metric) {
  return metric?.metric?.expression || metric?.expression || "";
}

function normalizeMetricPresentation(raw = {}, fallbackSource = "metric_config") {
  const rawFormat = String(raw.format || raw.value_format || raw.type || "").toLowerCase();
  const format = rawFormat === "percentage" ? "percent" : rawFormat;
  if (!format) return null;
  const defaultScale = format === "percent" ? 100 : 1;
  const scale = Number(raw.display_scale ?? raw.result_scale ?? raw.sql_scale ?? raw.scale ?? defaultScale);
  const precision = raw.precision == null ? (format === "percent" ? 2 : null) : Number(raw.precision);
  const normalizedScale = Number.isFinite(scale) && scale !== 0 ? scale : defaultScale;
  return {
    format,
    display_scale: normalizedScale,
    sql_scale: normalizedScale,
    suffix: raw.suffix ?? (format === "percent" ? "%" : ""),
    precision: Number.isFinite(precision) ? precision : null,
    source: raw.source || fallbackSource
  };
}

function presentationFromGeneratedDisplayFormats(metric, column, generatedFormats = []) {
  const formats = normalizeDisplayFormats(generatedFormats);
  const key = String(metric?.key || "");
  const byMetricKey = formats.find(item => item.metric_key && String(item.metric_key) === key);
  const byColumn = formats.find(item => item.column === column);
  const format = byMetricKey || byColumn;
  if (!format) return null;
  return {
    format: format.format,
    display_scale: Number(format.scale || 1),
    sql_scale: Number(format.scale || 1),
    suffix: format.suffix || "",
    precision: format.precision,
    source: format.source || "model_display_formats"
  };
}

function metricPresentation(metric, column = "", generatedFormats = []) {
  const raw = metric?.metric?.presentation
    || metric?.metric?.display
    || metric?.presentation
    || metric?.display
    || metric?.value_format
    || null;
  const explicit = typeof raw === "string"
    ? normalizeMetricPresentation({ format: raw }, "metric_config")
    : raw && typeof raw === "object"
      ? normalizeMetricPresentation(raw, "metric_config")
      : null;
  if (explicit) return explicit;
  const generated = presentationFromGeneratedDisplayFormats(metric, column, generatedFormats);
  if (generated) return generated;
  return {
    format: "number",
    display_scale: 1,
    sql_scale: 1,
    suffix: "",
    precision: null,
    source: "default"
  };
}

function applyMetricPresentationToSql(expression, presentation) {
  return expression;
}

function metricDisplayFormat(metric, column, presentation) {
  if (!presentation || presentation.format === "number") return null;
  const scale = Number(presentation.display_scale ?? presentation.sql_scale ?? 1);
  return {
    column,
    metric_key: metric?.key || null,
    format: presentation.format,
    precision: presentation.precision,
    suffix: presentation.suffix || "",
    scale: Number.isFinite(scale) && scale !== 0 ? scale : 1,
    display_scale: Number.isFinite(scale) && scale !== 0 ? scale : 1,
    scale_applied: false,
    source: presentation.source || "metric"
  };
}

function hasAnalyticalSqlShape(sql) {
  const text = normalizeSql(sql || "");
  if (!text) return false;
  return /\b(GROUP\s+BY|OVER\s*\(|LAG\s*\(|LEAD\s*\(|WITH)\b/i.test(text)
    || /同比|环比|增长率|增长额|年份|月份|季度/i.test(text);
}

function safeMetricAlias(key) {
  return `__${String(key || "").replace(/[^\w$]/g, "_")}`;
}

function replaceMetricTokens(expression, replacements) {
  let next = String(expression || "");
  [...replacements.keys()]
    .sort((a, b) => b.length - a.length)
    .forEach(key => {
      next = next.replace(new RegExp(`\\b${escapeRegExp(key)}\\b`, "g"), replacements.get(key));
    });
  return next;
}

function unresolvedFormulaTokens(expression) {
  return String(expression || "")
    .replace(/`[^`]+`/g, "")
    .match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) || [];
}

const ALLOWED_FORMULA_TOKENS = new Set([
  "ABS",
  "CASE",
  "CAST",
  "CEIL",
  "CEILING",
  "COALESCE",
  "ELSE",
  "END",
  "FLOOR",
  "GREATEST",
  "IF",
  "IFNULL",
  "LEAST",
  "NULL",
  "NULLIF",
  "ROUND",
  "THEN",
  "WHEN"
]);

function unresolvedMetricFormulaTokens(expression, replacements) {
  const replacementKeys = new Set(
    [...(replacements?.keys?.() || [])].flatMap(key => {
      const text = String(key || "");
      return [text, text.toLowerCase()];
    })
  );
  return unresolvedFormulaTokens(expression)
    .filter(token => !replacementKeys.has(token) && !replacementKeys.has(token.toLowerCase()))
    .filter(token => !ALLOWED_FORMULA_TOKENS.has(token.toUpperCase()));
}

function metricDependencySpecs(metric) {
  const raw = Array.isArray(metric?.metric?.dependency_specs)
    ? metric.metric.dependency_specs
    : Array.isArray(metric?.dependency_specs)
      ? metric.dependency_specs
      : Array.isArray(metric?.dependencies) && metric.dependencies.some(item => item && typeof item === "object")
        ? metric.dependencies
        : [];
  const items = raw.length
    ? raw
    : metricDependencies(metric).map(key => ({ metric_key: key, variable: key, period_role: "current_period" }));
  return items
    .map(item => {
      const metricKey = typeof item === "string" ? item : item?.metric_key || item?.key;
      if (!metricKey) return null;
      return {
        metricKey,
        variable: typeof item === "string" ? item : item?.variable || item?.alias || metricKey,
        periodRole: typeof item === "string" ? "current_period" : item?.period_role || item?.periodRole || "current_period",
        note: typeof item === "string" ? "" : item?.note || ""
      };
    })
    .filter(Boolean);
}

function sqlConditionSignature(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function uniqueSqlConditions(conditions = []) {
  const seen = new Set();
  return conditions
    .map(item => String(item || "").trim().replace(/^\s*AND\s+/i, ""))
    .filter(Boolean)
    .filter(item => {
      const signature = sqlConditionSignature(item);
      if (seen.has(signature)) return false;
      seen.add(signature);
      return true;
    });
}

function metricMatchNames(metric) {
  const aliases = Array.isArray(metric?.aliases)
    ? metric.aliases
    : String(metric?.aliases || "").split(/[、,，\n]/);
  return [metric?.name, metric?.key, ...aliases]
    .map(item => normalizeCandidateText(item))
    .filter(Boolean);
}

function stripMetricRatioSuffix(value) {
  const text = normalizeCandidateText(value);
  const suffixes = ["百分比", "百分率", "比例", "占比", "比率", "率"];
  const suffix = suffixes.find(item => text.endsWith(item));
  if (!suffix) return { core: text, suffix: "" };
  return {
    core: text.slice(0, -suffix.length),
    suffix
  };
}

function metricPhraseMatchesText(name, target) {
  if (!name || !target) return false;
  if (name === target) return true;
  if (name.length >= 4 && target.includes(name)) return true;
  if (target.length >= 4 && name.includes(target)) return true;

  const metricRatio = stripMetricRatioSuffix(name);
  const targetRatio = stripMetricRatioSuffix(target);
  const ratioLikeTarget = /(比例|占比|比率|百分比|百分率|率)/.test(target);
  if (
    metricRatio.suffix
    && ratioLikeTarget
    && metricRatio.core.length >= 3
    && target.includes(metricRatio.core)
  ) {
    return true;
  }
  if (
    targetRatio.suffix
    && targetRatio.core.length >= 3
    && name.includes(targetRatio.core)
  ) {
    return true;
  }
  return scoreCandidateValue(name, target) >= 0.84 || scoreCandidateValue(target, name) >= 0.84;
}

function metricMatchesCoverageItem(metric, item) {
  const target = normalizeCandidateText(item);
  if (!target) return false;
  return metricMatchNames(metric).some(name => metricPhraseMatchesText(name, target));
}

function filterSelectedMetricKeysByCoverage(payload, metrics, selectedKeys) {
  const checklist = normalizeCoverageChecklist(payload?.retrieval_plan?.coverage_checklist || []);
  const items = checklist.map(item => item.item).filter(Boolean);
  const plannedKeys = new Set([
    ...(payload?.retrieval_plan?.semantic_plan?.metrics || []),
    ...(payload?.retrieval_plan?.selected_metric_keys || [])
  ].filter(Boolean).map(String));
  if (!items.length) return selectedKeys;
  const filtered = selectedKeys.filter(key => {
    if (plannedKeys.has(String(key))) return true;
    const metric = metrics.get(key);
    if (!metric) return false;
    return items.some(item => metricMatchesCoverageItem(metric, item));
  });
  return filtered;
}

function warningContradictsResolvedItems(warning, resolvedItems = []) {
  const text = String(warning || "");
  return resolvedItems.some(item => {
    const name = String(item?.item || "").trim();
    if (!name || !text.includes(name)) return false;
    return /(未在|未定义|未找到|缺少|缺失|无法|不能|推断|可能|猜测)/.test(text);
  });
}

function resolvedLookupEvidenceItemsFromPayload(payload) {
  const checklist = normalizeCoverageChecklist(payload?.retrieval_plan?.coverage_checklist || []);
  const resolved = Array.isArray(payload?.resolved_sql_resultsets) ? payload.resolved_sql_resultsets : [];
  const resolvedKeys = new Set(resolved
    .filter(resultset => Number(resultset?.row_count || 0) > 0 || (Array.isArray(resultset?.rows) && resultset.rows.length > 0))
    .map(resultset => String(resultset?.key || "").trim())
    .filter(Boolean));
  return checklist
    .filter(item => item.status === "covered" && item.evidence_type === "sql_resultset")
    .filter(item => !item.evidence_key || !resolvedKeys.size || resolvedKeys.has(item.evidence_key))
    .map(item => ({
      item: item.item,
      evidence_key: item.evidence_key,
      note: item.note
    }));
}

function warningContradictsResolvedLookupEvidence(warning, payload, execution = null) {
  const text = String(warning || "");
  if (!/(未在|未定义|未找到|未查到|没有找到|查不到|缺少|缺失|无法|不能|推断|可能|猜测|证据不足)/.test(text)) {
    return false;
  }
  if (execution && (!execution.executed || Number(execution.row_count || 0) <= 0)) {
    return false;
  }
  const resolvedItems = resolvedLookupEvidenceItemsFromPayload(payload);
  if (!resolvedItems.length) return false;
  const mentionsResolvedItem = resolvedItems.some(item => [item.item, item.evidence_key, item.note]
    .filter(Boolean)
    .some(value => text.includes(value)));
  if (mentionsResolvedItem) return true;
  return /(指标|业务指标|语义|目录|结果集|映射|编码|科目|枚举|规则|口径|依据|证据)/.test(text);
}

function directoryLookupConditionTemplate(payload) {
  const text = semanticEntries(payload, "logic_text")
    .map(entry => semanticEntryContextText(entry))
    .join("\n");
  const match = text.match(/`?([A-Za-z_][\w$]*)`?\s+LIKE\s+'%\/(?:科目编码|编码|code|CODE)\/%'/i)
    || text.match(/`?([A-Za-z_][\w$]*)`?\s+LIKE\s+['"][^'"]*(?:科目编码|编码|code|CODE)[^'"]*['"]/i);
  if (!match) return null;
  return {
    field: match[1],
    build: code => `${sqlIdentifier(match[1])} LIKE ${sqlLiteral(`%/${code}/%`)}`
  };
}

function sourceMeasureField(metrics, sourceTable) {
  const fields = [...new Set([...metrics.values()]
    .filter(metric => metricKind(metric) !== "derived" && metricSourceTable(metric) === sourceTable)
    .map(metric => metricMeasure(metric).field)
    .filter(Boolean)
    .filter(field => field !== "*"))];
  return fields.length === 1 ? fields[0] : fields[0] || "";
}

function directoryLookupMeasureField(payload, metrics, sourceTable) {
  const text = semanticEntries(payload, "logic_text")
    .map(entry => semanticEntryContextText(entry))
    .join("\n");
  const match = text.match(/(?:金额字段|数值字段|度量字段|measure\s*field)\s*[：:]\s*`?([A-Za-z_][\w$]*)`?/i);
  return match?.[1] || sourceMeasureField(metrics, sourceTable);
}

function genericResolvedLookupExpression(payload, metrics, sourceTable, item) {
  const code = String(item?.code || "").trim();
  if (!code) return null;
  const template = directoryLookupConditionTemplate(payload);
  const measureField = directoryLookupMeasureField(payload, metrics, sourceTable);
  if (!template || !measureField) return null;
  const condition = template.build(code);
  const aggregate = `SUM(CASE WHEN ${condition} THEN ${sqlIdentifier(measureField)} ELSE 0 END)`;
  const factor = Number(item.result_factor || 1);
  if (factor === 1) return aggregate;
  if (factor === -1) return `-(${aggregate})`;
  return `${factor} * (${aggregate})`;
}

function genericAggregateExpression(metric, extraCondition = "") {
  const measure = metricMeasure(metric);
  if (!measure.field || !measure.aggregation) return null;
  const field = measure.field === "*" ? "*" : sqlIdentifier(measure.field);
  const aggregation = String(measure.aggregation || "SUM").toUpperCase();
  const scope = metricScopeExpression(metric);
  const combinedScope = [extraCondition, scope].filter(Boolean).join(" AND ");
  let expression = "";
  if (aggregation === "SUM") {
    expression = combinedScope
      ? `SUM(CASE WHEN ${combinedScope} THEN ${field} ELSE 0 END)`
      : `SUM(${field})`;
  } else if (aggregation === "COUNT") {
    expression = combinedScope
      ? `SUM(CASE WHEN ${combinedScope} THEN 1 ELSE 0 END)`
      : `COUNT(${field})`;
  } else if (aggregation === "COUNT_DISTINCT") {
    if (measure.field === "*") return null;
    expression = combinedScope
      ? `COUNT(DISTINCT CASE WHEN ${combinedScope} THEN ${field} ELSE NULL END)`
      : `COUNT(DISTINCT ${field})`;
  } else if (["AVG", "MIN", "MAX"].includes(aggregation)) {
    expression = combinedScope
      ? `${aggregation}(CASE WHEN ${combinedScope} THEN ${field} ELSE NULL END)`
      : `${aggregation}(${field})`;
  } else {
    return null;
  }
  const factor = Number(measure.resultFactor || 1);
  if (factor === 1) return expression;
  if (factor === -1) return `-(${expression})`;
  return `${factor} * (${expression})`;
}

function buildGenericDeterministicMetricSql(payload, generated, mandatoryContext, metrics, selectedKeys, resolvedItems = []) {
  if (!selectedKeys.length && !resolvedItems.length) return null;
  const baseRequirements = new Map();
  const sourceTables = new Set();
  const additionalTimeValues = new Set();
  const fallbackSourceTable = () => [...sourceTables][0] || selectedPayloadTables(payload)[0] || catalogTables(payload)[0] || "";

  const aggregateForRole = (metric, sourceTable, roleName, scopedToPeriod) => {
    const timeField = genericYearColumn(payload, sourceTable);
    const times = genericRequestedTimeValues(payload, sourceTable);
    const current = times[times.length - 1] || "";
    const expressionAt = value => {
      if (!timeField || !value) return genericAggregateExpression(metric);
      additionalTimeValues.add(value);
      return genericAggregateExpression(metric, `${sqlIdentifier(timeField)} = ${sqlLiteral(value)}`);
    };
    if (roleName === "average_begin_end" && current) {
      const previous = previousYearEndGenericTimeValue(current);
      if (!previous) return null;
      const previousExpression = expressionAt(previous);
      const currentExpression = expressionAt(current);
      if (!previousExpression || !currentExpression) return null;
      return `(${previousExpression} + ${currentExpression}) / 2`;
    }
    if (roleName === "previous_year_end" && current) return expressionAt(previousYearEndGenericTimeValue(current));
    if (scopedToPeriod && current && times.length <= 1) return genericAggregateExpression(metric);
    return genericAggregateExpression(metric);
  };

  const addBaseRequirement = (key, dep = {}) => {
    const metric = metrics.get(key);
    if (!metric || metricKind(metric) === "derived") return null;
    const sourceTable = metricSourceTable(metric);
    if (!sourceTable) return null;
    const roleName = String(dep.periodRole || dep.period_role || "current_period");
    const scopedToPeriod = Boolean(dep.periodRole || dep.period_role || dep.variable || dep.alias);
    const expression = aggregateForRole(metric, sourceTable, roleName, scopedToPeriod);
    if (!expression) return null;
    const requirementKey = `${key}::${roleName}::${dep.variable || dep.alias || key}`;
    const alias = safeMetricAlias(`generic__${requirementKey}`);
    if (!baseRequirements.has(requirementKey)) {
      baseRequirements.set(requirementKey, { key, metric, sourceTable, alias, expression });
      sourceTables.add(sourceTable);
    }
    return sqlIdentifier(baseRequirements.get(requirementKey).alias);
  };

  const addResolvedRequirement = item => {
    const sourceTable = fallbackSourceTable();
    if (!sourceTable) return null;
    const expression = genericResolvedLookupExpression(payload, metrics, sourceTable, item);
    if (!expression) return null;
    const alias = safeMetricAlias(`lookup__${item.code || item.item}`);
    const key = `lookup::${item.item}::${item.code || ""}`;
    if (!baseRequirements.has(key)) {
      baseRequirements.set(key, { key, metric: null, sourceTable, alias, expression });
      sourceTables.add(sourceTable);
    }
    return sqlIdentifier(baseRequirements.get(key).alias);
  };

  const resolveMetricExpression = (key, depSpec = {}, stack = []) => {
    const metric = metrics.get(key);
    if (!metric || stack.includes(key)) return null;
    if (metricKind(metric) !== "derived") return addBaseRequirement(key, depSpec);
    const deps = metricDependencySpecs(metric);
    if (!deps.length) return null;
    const replacements = new Map();
    for (const dep of deps) {
      const childExpression = resolveMetricExpression(dep.metricKey, dep, [...stack, key]);
      if (!childExpression) return null;
      replacements.set(dep.variable || dep.metricKey, `(${childExpression})`);
      if (!replacements.has(dep.metricKey)) replacements.set(dep.metricKey, `(${childExpression})`);
    }
    const formula = metricExpression(metric);
    const expression = replaceMetricTokens(formula, replacements);
    if (!expression || unresolvedMetricFormulaTokens(formula, replacements).length) return null;
    return expression;
  };

  const outputColumns = [];
  const displayFormats = [];
  for (const key of selectedKeys) {
    const metric = metrics.get(key);
    if (!metric) return null;
    const name = metric.name || key;
    const expression = resolveMetricExpression(key);
    if (!expression) return null;
    const presentation = metricPresentation(metric, name, generated?.display_formats || []);
    const displayFormat = metricDisplayFormat(metric, name, presentation);
    if (displayFormat) displayFormats.push(displayFormat);
    outputColumns.push({ key, metric, name, expression: applyMetricPresentationToSql(expression, presentation) });
  }
  for (const item of resolvedItems) {
    const expression = addResolvedRequirement(item);
    if (!expression) continue;
    const name = item.item || item.name || item.code;
    if (!name || outputColumns.some(column => column.name === name)) continue;
    outputColumns.push({ key: `lookup::${item.code || name}`, metric: null, name, expression });
  }
  if (selectedKeys.length === 1 && metricKind(metrics.get(selectedKeys[0])) === "derived") {
    for (const item of baseRequirements.values()) {
      if (selectedKeys.includes(item.key)) continue;
      const name = item.metric?.name || item.key;
      if (outputColumns.some(column => column.name === name)) continue;
      outputColumns.push({
        key: item.key,
        metric: item.metric,
        name,
        expression: sqlIdentifier(item.alias)
      });
    }
  }
  if (!outputColumns.length || !baseRequirements.size) return null;

  if (sourceTables.size > 1) {
    const sourceGroups = [...sourceTables].map((sourceTable, index) => ({
      sourceTable,
      cteName: `metric_source_${index + 1}`,
      requirements: [...baseRequirements.values()].filter(item => item.sourceTable === sourceTable)
    }));
    if (sourceGroups.some(group => !group.requirements.length)) return null;
    const ctes = sourceGroups.map(group => {
      const columnNames = new Set((tableContextForSource(payload, group.sourceTable)?.columns || [])
        .map(column => String(column?.name || column || ""))
        .filter(Boolean));
      const applicableMandatoryFilters = (mandatoryContext?.sql_filters || []).filter(item => {
        const field = String(item?.field || "").replaceAll("`", "").trim();
        return field && columnNames.has(field);
      });
      const sourceWhereLines = uniqueSqlConditions([
        ...genericTimeSqlFilters(payload, group.sourceTable).map(item => item.sql),
        ...applicableMandatoryFilters.map(item => item.sql)
      ]);
      return [
        `${sqlIdentifier(group.cteName)} AS (`,
        "  SELECT",
        group.requirements
          .map(item => `    ${item.expression} AS ${sqlIdentifier(item.alias)}`)
          .join(",\n"),
        `  FROM ${quotedTableName(group.sourceTable)}`,
        sourceWhereLines.length
          ? [
              "  WHERE",
              sourceWhereLines.map((line, lineIndex) => `    ${lineIndex ? "AND " : ""}${line}`).join("\n")
            ].join("\n")
          : "",
        ")"
      ].filter(Boolean).join("\n");
    });
    const sql = [
      "WITH",
      ctes.join(",\n"),
      "SELECT",
      outputColumns.map(column => `  ${column.expression} AS ${sqlIdentifier(column.name)}`).join(",\n"),
      "FROM",
      sourceGroups
        .map((group, index) => `  ${index ? "CROSS JOIN " : ""}${sqlIdentifier(group.cteName)}`)
        .join("\n")
    ].join("\n");
    return {
      sql,
      selectedKeys,
      baseKeys: [...new Set([...baseRequirements.values()].map(item => item.key))],
      sourceTable: [...sourceTables].join(", "),
      sourceTables: [...sourceTables],
      displayFormats,
      warnings: ["多表派生指标已按来源表分别聚合，再组合计算公式。"]
    };
  }

  const sourceTable = [...sourceTables][0];
  const timeField = genericYearColumn(payload, sourceTable);
  const requestedTimes = genericRequestedTimeValues(payload, sourceTable);
  const roleTimeFilters = timeField && additionalTimeValues.size
    ? [{
        sql: `${sqlIdentifier(timeField)} IN (${[...additionalTimeValues].sort().map(sqlLiteral).join(", ")})`
      }]
    : [];
  const whereLines = uniqueSqlConditions([
    ...(roleTimeFilters.length ? roleTimeFilters : genericTimeSqlFilters(payload, sourceTable)).map(item => item.sql),
    ...(mandatoryContext?.sql_filters || [])
      .map(item => item.sql)
  ]);
  const innerSelects = [...baseRequirements.values()]
    .map(item => `    ${item.expression} AS ${sqlIdentifier(item.alias)}`);
  const wantsYoy = /yoy|同比|增长|趋势|变化|对比/i.test([
    payload?.question,
    payload?.retrieval_plan?.intent,
    payload?.retrieval_plan?.summary,
    ...(payload?.retrieval_plan?.semantic_plan?.calculations || []),
    ...(payload?.retrieval_plan?.semantic_plan?.output || [])
  ].filter(Boolean).join("\n"));
  if (timeField && requestedTimes.length > 1) {
    const periodWhereLines = uniqueSqlConditions([
      `${sqlIdentifier(timeField)} IN (${requestedTimes.map(sqlLiteral).join(", ")})`,
      ...(mandatoryContext?.sql_filters || []).map(item => item.sql)
    ]);
    const periodBaseSql = [
      "period_base AS (",
      "  SELECT",
      [
        `    ${sqlIdentifier(timeField)} AS ${sqlIdentifier("__period")}`,
        ...innerSelects
      ].join(",\n"),
      `  FROM ${quotedTableName(sourceTable)}`,
      "  WHERE",
      periodWhereLines.map((line, index) => `    ${index ? "AND " : ""}${line}`).join("\n"),
      `  GROUP BY ${sqlIdentifier(timeField)}`,
      ")"
    ].join("\n");
    const metricSql = [
      "period_metrics AS (",
      "  SELECT",
      [
        `    ${sqlIdentifier("__period")} AS ${sqlIdentifier("期间")}`,
        ...outputColumns.map(column => `    ${column.expression} AS ${sqlIdentifier(column.name)}`)
      ].join(",\n"),
      "  FROM period_base",
      ")"
    ].join("\n");
    const finalSelects = [
      `  ${sqlIdentifier("期间")}`,
      ...outputColumns.map(column => `  ${sqlIdentifier(column.name)}`)
    ];
    if (wantsYoy) {
      outputColumns.forEach(column => {
        const yoyName = `${column.name}同比增长率`;
        finalSelects.push([
          "  CASE",
          `    WHEN LAG(${sqlIdentifier(column.name)}) OVER (ORDER BY ${sqlIdentifier("期间")}) IS NULL OR LAG(${sqlIdentifier(column.name)}) OVER (ORDER BY ${sqlIdentifier("期间")}) = 0 THEN NULL`,
          `    ELSE (${sqlIdentifier(column.name)} - LAG(${sqlIdentifier(column.name)}) OVER (ORDER BY ${sqlIdentifier("期间")})) / LAG(${sqlIdentifier(column.name)}) OVER (ORDER BY ${sqlIdentifier("期间")})`,
          `  END AS ${sqlIdentifier(yoyName)}`
        ].join("\n"));
        displayFormats.push({
          column: yoyName,
          metric_key: null,
          format: "percent",
          precision: 2,
          suffix: "%",
          scale: 100,
          display_scale: 100,
          scale_applied: false,
          source: "generic_time_series"
        });
      });
    }
    const sql = [
      "WITH",
      periodBaseSql,
      ",",
      metricSql,
      "SELECT",
      finalSelects.join(",\n"),
      "FROM period_metrics",
      `ORDER BY ${sqlIdentifier("期间")}`
    ].join("\n");
    return {
      sql,
      selectedKeys,
      baseKeys: [...baseRequirements.keys()],
      sourceTable,
      displayFormats,
      warnings: []
    };
  }
  const outerSelects = outputColumns.map(column => `  ${column.expression} AS ${sqlIdentifier(column.name)}`);
  const sql = [
    "SELECT",
    outerSelects.join(",\n"),
    "FROM (",
    "  SELECT",
    innerSelects.join(",\n"),
    `  FROM ${quotedTableName(sourceTable)}`,
    whereLines.length
      ? [
          "  WHERE",
          whereLines.map((line, index) => `    ${index ? "AND " : ""}${line}`).join("\n")
        ].join("\n")
      : "",
    ") base"
  ].filter(Boolean).join("\n");

  return {
    sql,
    selectedKeys,
    baseKeys: [...baseRequirements.keys()],
    sourceTable,
    displayFormats,
    warnings: []
  };
}

function buildDeterministicMetricSql(payload, generated, mandatoryContext) {
  const candidateSelectedKeys = [...new Set([
    generated?.decision?.selected_metric_key,
    ...(generated?.decision?.selected_metric_keys || []),
    ...(generated?.display_formats || []).map(item => item?.metric_key || item?.key).filter(Boolean)
  ].filter(Boolean))];
  const metrics = metricCatalogMap(payload);
  const allResolvedItems = resolvedItemsFromResultsets(payload?.retrieval_plan, payload?.resolved_sql_resultsets || []);
  let selectedKeys = filterSelectedMetricKeysByCoverage(payload, metrics, candidateSelectedKeys);
  selectedKeys = expandSelectedMetricKeysByBreakdown(payload, metrics, selectedKeys);
  const plannedOutputs = (payload?.retrieval_plan?.semantic_plan?.output || [])
    .map(item => String(item || "").trim())
    .filter(Boolean);
  const resolvedItems = selectedKeys.length || !plannedOutputs.length
    ? allResolvedItems
    : allResolvedItems.filter(item => plannedOutputs.some(output => (
        metricPhraseMatchesText(item?.item, output)
        || metricPhraseMatchesText(output, item?.item)
      )));
  if (!selectedKeys.length && !resolvedItems.length) return null;
  const selectedMetrics = selectedKeys.map(key => metrics.get(key)).filter(Boolean);
  if (selectedKeys.length && !selectedMetrics.length) return null;
  const genericMetricSql = buildGenericDeterministicMetricSql(payload, generated, mandatoryContext, metrics, selectedKeys, resolvedItems);
  if (genericMetricSql) return genericMetricSql;
  return null;
}

function deterministicSeedFromRetrievalPlan(payload, plan) {
  const selectedMetricKeys = [...new Set([
    ...(plan?.selected_metric_keys || []),
    ...(Array.isArray(plan?.semantic_plan?.metrics) ? plan.semantic_plan.metrics : [])
  ].filter(Boolean))];
  const selectedRuleKeys = [...new Set([
    ...(plan?.selected_rule_keys || []),
    ...(Array.isArray(plan?.semantic_plan?.rules) ? plan.semantic_plan.rules : [])
  ].filter(Boolean))];
  if (!selectedMetricKeys.length) return null;
  return {
    answer: "",
    answer_type: "sql_needed",
    decision: {
      intent: plan?.intent || "unknown",
      selected_metric_key: selectedMetricKeys[0] || null,
      selected_metric_keys: selectedMetricKeys,
      selected_rule_keys: selectedRuleKeys,
      reason: plan?.summary || "语义计划已具备可编译的指标或目录编码。"
    },
    sql_plan: Array.isArray(plan?.sql_plan) ? plan.sql_plan : [],
    display_formats: Array.isArray(plan?.display_formats) ? plan.display_formats : [],
    sql: "",
    warnings: Array.isArray(plan?.warnings) ? plan.warnings : []
  };
}

async function callNl2Sql(payload, options = {}) {
  const totalStartedAt = Date.now();
  const trace = [];
  const report = typeof options.report === "function" ? options.report : null;
  let activeRetrievalPlan = null;
  const emitTrace = item => {
    if (report) report({ type: "trace", item, elapsed_ms: elapsedMs(totalStartedAt) });
  };
  const pushTrace = item => {
    trace.push(item);
    emitTrace(item);
  };
  const emitProgress = (id, stage, label, startedAt, summary = "", audit = {}) => {
    emitTrace(traceItem(stage, label, "running", startedAt, "", null, summary, { ...audit, id }));
  };
  const finishPayload = data => ({
    ...data,
    retrieval_plan: data.retrieval_plan || activeRetrievalPlan,
    trace,
    timings: {
      total_ms: elapsedMs(totalStartedAt),
      steps: buildTimingSteps(trace),
      trace
    }
  });

  let stageStartedAt = Date.now();
  let tableContext = [];
  emitProgress(
    "table_exploration",
    "table_exploration",
    "读取表结构和样例",
    stageStartedAt,
    "先读取当前数据源的真实字段和样例，避免只靠语义猜字段。",
    {
      purpose: "用真实表结构和样例数据给语义判断兜底。",
      finding: "等待数据库返回表结构和样例。",
      decision: "读取后会交给模型一起判断。"
    }
  );
  try {
    tableContext = await loadTableContext(payload);
    payload = {
      ...payload,
      table_context: tableContext
    };
    pushTrace(traceItem(
      "table_exploration",
      "读取表结构和样例",
      "success",
      stageStartedAt,
      `读取 ${tableContext.length} 张表`,
      {
        tables: tableContext.map(table => ({
          table: table.table,
          description: table.description || "",
          column_count: Array.isArray(table.columns) ? table.columns.length : 0,
          sample_row_count: Array.isArray(table.sample_rows) ? table.sample_rows.length : 0
        }))
      },
      `已读取 ${tableContext.length} 张表的结构和样例，后续判断会优先使用真实字段。`,
      {
        id: "table_exploration",
        purpose: "用真实表结构和样例数据给语义判断兜底。",
        finding: `读取 ${tableContext.length} 张表`,
        decision: "把 schema 和样例交给后续模型判断。"
      }
    ));
  } catch (error) {
    pushTrace(traceItem(
      "table_exploration",
      "读取表结构失败",
      "failed",
      stageStartedAt,
      error.message || String(error),
      null,
      "尝试读取真实表结构失败；本次会退回只依赖语义目录。",
      {
        id: "table_exploration",
        purpose: "用真实表结构给语义检索兜底。",
        finding: error.message || String(error),
        decision: "不阻断问答，后续只依赖语义目录继续。"
      }
    ));
  }

  let loopResult;
  stageStartedAt = Date.now();
  try {
    // Always understand the full question before any deterministic SQL shortcut.
    loopResult = await runSemanticAgentLoop(payload, pushTrace, emitProgress);
  } catch (error) {
    pushTrace(traceItem(
      "agent_loop",
      "判断下一步",
      "failed",
      stageStartedAt,
      error.message || String(error),
      null,
      "模型没有完成下一步判断；本次会改用当前表结构和语义继续尝试 SQL 生成。",
      {
        id: "agent_loop",
        purpose: "由模型决定下一步，而不是固定流水线。",
        finding: error.message || String(error),
        decision: "不直接失败，继续进入 SQL 生成。"
      }
    ));
    loopResult = {
      mode: "sql",
      retrievalPlan: {
        intent: "unknown",
        selected_metric_keys: [],
        selected_rule_keys: [],
        disabled_mandatory_filter_ids: [],
        needs_sql_resultset: false,
        sql_resultset_lookups: [],
        summary: "",
        warnings: [error.message || String(error)]
      },
      resolvedSqlResultsets: []
    };
  }

  let retrievalPlan = loopResult?.retrievalPlan || {
    intent: "unknown",
    selected_metric_keys: [],
    selected_rule_keys: [],
    disabled_mandatory_filter_ids: [],
    needs_sql_resultset: false,
    sql_resultset_lookups: [],
    summary: "",
    warnings: []
  };
  let resolvedSqlResultsets = loopResult?.resolvedSqlResultsets || [];
  const planValidationStartedAt = Date.now();
  const planValidation = validateRetrievalPlanAgainstCatalog(payload, retrievalPlan);
  retrievalPlan = planValidation.plan;
  activeRetrievalPlan = retrievalPlan;
  if (planValidation.changed || retrievalPlan.selected_metric_keys.length || retrievalPlan.selected_rule_keys.length || retrievalPlan.needs_sql_resultset) {
    pushTrace(traceItem(
      "semantic_plan",
      "校验语义计划",
      planValidation.changed ? "skipped" : "success",
      planValidationStartedAt,
      planValidation.changed ? planValidation.warnings.join("；") : `意图：${retrievalPlan.intent || "unknown"}；指标：${semanticEntryLabels(payload, "business_metric", retrievalPlan.selected_metric_keys, 6) || "无"}`,
      retrievalPlanArtifact(retrievalPlan),
      planValidation.changed
        ? "模型给出的计划里有不存在的语义 key，已在进入 SQL 生成前剔除。"
        : "语义计划已通过目录校验，后续 SQL 只能基于这些已验证依据和真实表结构生成。",
      {
        id: "semantic_plan_validation",
        purpose: "把模型的理解结果先校验成可执行计划，避免无效指标、规则或目录污染 SQL。",
        finding: planValidation.changed ? planValidation.warnings.join("；") : retrievalPlan.summary || `意图=${retrievalPlan.intent || "unknown"}`,
        decision: "使用校验后的 semantic plan 进入 SQL 生成或指标编译。"
      }
    ));
  }

  if (loopResult?.mode === "direct") {
    const direct = loopResult.directAnswer || {};
    return {
      model: config.model,
      data: finishPayload({
        answer: direct.answer || "当前问题还缺少必要信息。",
        answer_type: direct.answer_type || "clarification_needed",
        decision: direct.decision || {
          intent: retrievalPlan.intent || "unknown",
          selected_metric_key: retrievalPlan.selected_metric_keys?.[0] || null,
          selected_metric_keys: retrievalPlan.selected_metric_keys || [],
          selected_rule_keys: retrievalPlan.selected_rule_keys || [],
          reason: retrievalPlan.summary || ""
        },
        sql_plan: direct.sql_plan || [],
        sql: direct.sql || "",
        resolved_sql_resultsets: resolvedSqlResultsets,
        mandatory_context: { enabled: false, rule_keys: [], rule_labels: "", sql_filters: [], warnings: [] },
        warnings: direct.warnings || retrievalPlan.warnings || [],
        execution: { executed: false, columns: [], rows: [], row_count: 0, message: "本轮不需要执行 SQL。" },
        sql_validation: { ok: true, skipped: true, error: "" }
      }),
      raw: "",
      usage: null
    };
  }

  stageStartedAt = Date.now();
  const mandatoryContext = buildMandatoryContext(payload, retrievalPlan);
  if (mandatoryContext.rule_keys.length) {
    retrievalPlan.selected_rule_keys = [
      ...new Set([
        ...mandatoryContext.rule_keys,
        ...(retrievalPlan.selected_rule_keys || [])
      ])
    ];
  }
  activeRetrievalPlan = retrievalPlan;
  pushTrace(traceItem(
    "mandatory_context",
    "编译规则执行契约",
    "success",
    stageStartedAt,
    mandatoryContextSummary(mandatoryContext),
    mandatoryContextArtifact(mandatoryContext),
    `已按目标表 ${mandatoryContext.scoped_tables?.join("、") || "未确定"} 编译规则，并按注入阶段分别交给 SQL、执行和回答层。`,
    {
      id: "mandatory_context",
      purpose: "把召回到的自然语言规则转换成有作用域、有阶段、可校验的执行契约。",
      finding: mandatoryContextSummary(mandatoryContext),
      decision: "只向后续阶段注入与目标表匹配的规则。"
    }
  ));

  const focusedTableContext = scopedTableContextForPlan(payload, retrievalPlan);
  const focusedSemanticCatalog = scopedSemanticCatalogForPlan(payload, retrievalPlan, mandatoryContext);
  const enrichedPayload = {
    ...payload,
    data_source: mandatoryContext.scoped_tables?.join(", ") || payload.data_source,
    semantic_catalog: focusedSemanticCatalog,
    table_context: focusedTableContext,
    retrieval_plan: retrievalPlan,
    mandatory_context: mandatoryContext,
    resolved_sql_resultsets: resolvedSqlResultsets
  };

  stageStartedAt = Date.now();
  let generation = {
    model: config.model,
    data: loopResult?.generated || null,
    raw: "",
    usage: null,
    source: loopResult?.generated ? "agent_loop" : "sql_generator"
  };
  let generationStartedAt = stageStartedAt;
  let independentOutputContract = null;
  if (!generation.data && requiredSqlGenerationRules(enrichedPayload).length >= 2) {
    const contractStartedAt = Date.now();
    emitProgress(
      "output_contract_compilation",
      "output_contract",
      "编译多结果集契约",
      contractStartedAt,
      "正在理解强制规则分别约束独立表格、共同 SQL 口径还是最终回答文案。",
      {
        purpose: "先把自然语言规则编译成结构化输出契约，再生成 SQL。",
        finding: `待分类规则：${requiredSqlGenerationRules(enrichedPayload).map(rule => rule.key).join("、")}`,
        decision: "按规则正文语义分类，不把列清单误当成多张表。"
      }
    );
    try {
      independentOutputContract = await compileIndependentOutputContract(enrichedPayload);
      pushTrace(traceItem(
        "output_contract",
        "编译多结果集契约",
        independentOutputContract?.use_independent_result_sets ? "success" : "skipped",
        contractStartedAt,
        independentOutputContract?.use_independent_result_sets
          ? `独立结果集：${independentOutputContract.result_sets.map(item => item.title).join("、")}`
          : independentOutputContract?.reason || "规则不要求多个独立结果集",
        independentOutputContract,
        independentOutputContract?.use_independent_result_sets
          ? "规则已被分成独立结果表、共享 SQL 口径和仅回答文案，后续不会跨层误审。"
          : "没有形成可靠的多结果集契约，交给普通 SQL 生成器整体处理。",
        {
          id: "output_contract_compilation",
          purpose: "把强制规则编译成结构化输出职责。",
          finding: independentOutputContract?.reason || "完成规则分类",
          decision: independentOutputContract?.use_independent_result_sets
            ? "按契约并行生成独立结果集。"
            : "使用普通 SQL 生成。"
        }
      ));
    } catch (error) {
      pushTrace(traceItem(
        "output_contract",
        "编译多结果集契约",
        "failed",
        contractStartedAt,
        error.message || String(error),
        null,
        "输出契约编译失败，交给普通 SQL 生成器整体处理，不使用不可靠的列名匹配。",
        {
          id: "output_contract_compilation",
          purpose: "把强制规则编译成结构化输出职责。",
          finding: error.message || String(error),
          decision: "退回普通 SQL 生成。"
        }
      ));
    }
  }
  if (!generation.data && independentOutputRuleScopes(independentOutputContract, enrichedPayload).length >= 2) {
    const decompositionStartedAt = Date.now();
    generationStartedAt = decompositionStartedAt;
    emitProgress(
      "sql_decomposition",
      "sql_decomposition",
      "并行生成独立结果集",
      decompositionStartedAt,
      "检测到多个由强制规则定义的不同输出结构，正在分别生成 SQL。",
      {
        purpose: "让每张不同结构的结果表独立生成，避免单次大提示超时或 UNION 列数冲突。",
        finding: `计划输出：${compactList(independentOutputContract.result_sets.map(item => item.title), 6)}`,
        decision: "并行生成，完成后统一做规则覆盖和 SQL 安全校验。"
      }
    );
    try {
      const decomposed = await generateIndependentResultSets(enrichedPayload, independentOutputContract);
      if (decomposed?.data) {
        generation = {
          model: decomposed.model,
          data: decomposed.data,
          raw: decomposed.raw,
          usage: decomposed.usage,
          source: "sql_decomposition"
        };
        pushTrace(traceItem(
          "sql_decomposition",
          "并行生成独立结果集",
          "success",
          decompositionStartedAt,
          `生成 ${decomposed.data.result_sets.length} 个结果集`,
          { scopes: decomposed.scopes, result_sets: decomposed.data.result_sets.map(item => ({ key: item.key, title: item.title, applied_rule_keys: item.applied_rule_keys })) },
          "不同结构的结果表已分别生成，后续会逐表校验和执行。",
          {
            id: "sql_decomposition",
            purpose: "让每张不同结构的结果表独立生成。",
            finding: `生成 ${decomposed.data.result_sets.length} 个结果集`,
            decision: "进入统一规则覆盖校验。"
          }
        ));
      }
    } catch (error) {
      pushTrace(traceItem(
        "sql_decomposition",
        "并行生成独立结果集",
        "failed",
        decompositionStartedAt,
        error.message || String(error),
        null,
        "独立结果集生成未完成，本轮会退回普通 SQL 生成器。",
        {
          id: "sql_decomposition",
          purpose: "让每张不同结构的结果表独立生成。",
          finding: error.message || String(error),
          decision: "退回普通 SQL 生成。"
        }
      ));
    }
  }
  if (!generation.data) {
    generationStartedAt = Date.now();
    const deterministicSeed = knowledgeMetricsFromPlan(retrievalPlan).length
      ? null
      : deterministicSeedFromRetrievalPlan(enrichedPayload, retrievalPlan);
    if (deterministicSeed) {
      const normalizedSeed = normalizeGeneratedSqlData(deterministicSeed, enrichedPayload);
      const deterministicPreview = buildDeterministicMetricSql(enrichedPayload, normalizedSeed, mandatoryContext);
      const analyticalIntent = queryRequestsAnalyticalSql(enrichedPayload, retrievalPlan);
      if (deterministicPreview?.sql && (!analyticalIntent || hasAnalyticalSqlShape(deterministicPreview.sql))) {
        generation = {
          model: "deterministic-compiler",
          data: deterministicSeed,
          raw: "",
          usage: null,
          source: "deterministic_compiler"
        };
        pushTrace(traceItem(
          "sql_generation",
          "直接编译 SQL",
          "success",
          generationStartedAt,
          `输出：${compactList(sqlAliasSummary(deterministicPreview.sql), 8) || "未识别输出列"}`,
          {
            selected_metric_keys: deterministicPreview.selectedKeys || retrievalPlan.selected_metric_keys || [],
            base_metric_keys: deterministicPreview.baseKeys || [],
            resolved_account_items: deterministicPreview.resolvedAccountItems || [],
            sql: deterministicPreview.sql
          },
          "语义计划已经足够，后端指标编译器可以稳定生成 SQL；本轮跳过模型自由写 SQL，减少耗时和口径漂移。",
          {
            id: "sql_generation_deterministic",
            purpose: "在可确定编译时跳过模型 SQL 生成。",
            finding: `可直接输出 ${compactList(sqlAliasSummary(deterministicPreview.sql), 8) || "查询列"}`,
            decision: "使用确定性编译结果进入安全校验。"
          }
        ));
      }
    }
  }
  if (!generation.data) {
    generationStartedAt = Date.now();
    emitProgress(
      "sql_generation",
      "sql_generation",
      "形成取数 SQL",
      generationStartedAt,
      "正在把问题、语义依据、表结构和问数配置转换成一条可执行 SQL。",
      {
        purpose: "把采用的指标、规则、表结构和用户配置转换成 SQL。",
        finding: "等待模型返回 SQL 生成结果。",
        decision: "生成后会进入只读和授权表校验。"
      }
    );
    try {
      generation = {
        ...(await callModelJson(buildNl2SqlMessages(enrichedPayload), { temperature: 0.05, maxTokens: 4096 })),
        source: "sql_generator"
      };
    } catch (error) {
      pushTrace(traceItem(
        "sql_generation",
        "形成取数 SQL",
        "failed",
        generationStartedAt,
        error.message || String(error),
        null,
        "模型生成 SQL 阶段失败，后续安全校验和数据库执行都不会继续。",
        {
          id: "sql_generation",
          purpose: "把问题、已选依据、表结构和配置转成一条可执行 SQL。",
          finding: error.message || String(error),
          decision: "停止执行，不进入 SQL 校验和数据库查询。"
        }
      ));
      return {
        model: config.model,
        data: finishPayload({
          answer: `qwen3-max 生成 SQL 失败：${error.message || String(error)}`,
          answer_type: "execution_error",
          decision: { intent: "unknown", selected_metric_key: null, selected_rule_keys: [], confidence: 0, reason: "模型生成阶段失败" },
          sql_plan: [],
          sql: "",
          mandatory_context: mandatoryContext,
          warnings: [error.message || String(error)],
          execution: { executed: false, columns: [], rows: [], row_count: 0, message: "模型生成阶段失败，未执行 SQL。" },
          sql_validation: { ok: false, error: "模型生成阶段失败" }
        }),
        raw: "",
        usage: null
      };
    }
  }
  let generated = normalizeGeneratedSqlData(generation.data, enrichedPayload);
  const ruleCoverageStartedAt = Date.now();
  let sqlRuleCoverage = ruleCoverageForStage(mandatoryContext, "sql_generation", generated);
  if (!sqlRuleCoverage.ok) {
    const ruleRepairStartedAt = Date.now();
    emitProgress(
      "sql_rule_contract_repair",
      "rule_contract",
      "补齐强制规则输出",
      ruleRepairStartedAt,
      `SQL 输出还缺少 ${sqlRuleCoverage.missing_rule_keys.length} 条强制规则处置，正在按规则契约重写。`,
      {
        purpose: "确保高优先级规则不只是被召回，而是真正落实到 SQL 或明确判定不适用。",
        finding: `缺少：${sqlRuleCoverage.missing_rule_keys.join("、")}`,
        decision: "带着上一版输出和缺失规则重新生成完整 SQL 结果。"
      }
    );
    try {
      const retryPayload = {
        ...enrichedPayload,
        rule_contract_feedback: {
          stage: "sql_generation",
          missing_rule_keys: sqlRuleCoverage.missing_rule_keys,
          previous_output: generated
        }
      };
      const repairedGeneration = await callModelJson(
        buildNl2SqlMessages(retryPayload),
        { temperature: 0.03, maxTokens: 6000 }
      );
      generated = normalizeGeneratedSqlData(repairedGeneration.data, enrichedPayload);
      generation = {
        ...repairedGeneration,
        source: "sql_rule_contract_repair",
        usage: {
          initial: generation.usage,
          repair: repairedGeneration.usage
        }
      };
      sqlRuleCoverage = ruleCoverageForStage(mandatoryContext, "sql_generation", generated);
      pushTrace(traceItem(
        "rule_contract",
        "补齐强制规则输出",
        sqlRuleCoverage.ok ? "success" : "failed",
        ruleRepairStartedAt,
        sqlRuleCoverage.ok
          ? `已处置：${sqlRuleCoverage.required_rule_keys.join("、") || "无"}`
          : `仍缺少：${sqlRuleCoverage.missing_rule_keys.join("、")}`,
        sqlRuleCoverage,
        sqlRuleCoverage.ok
          ? "SQL 输出已逐条覆盖目标表的强制规则。"
          : "重生成后仍有强制规则未落实，本轮不会执行不完整 SQL。",
        {
          id: "sql_rule_contract_repair",
          purpose: "校验 SQL 输出对强制业务规则的覆盖情况。",
          finding: sqlRuleCoverage.ok ? "强制规则均已处置" : `缺少 ${sqlRuleCoverage.missing_rule_keys.join("、")}`,
          decision: sqlRuleCoverage.ok ? "允许进入 SQL 校验。" : "阻止执行不完整 SQL。"
        }
      ));
    } catch (error) {
      sqlRuleCoverage = {
        ...sqlRuleCoverage,
        ok: false,
        repair_error: error.message || String(error)
      };
      pushTrace(traceItem(
        "rule_contract",
        "补齐强制规则输出",
        "failed",
        ruleRepairStartedAt,
        sqlRuleCoverage.repair_error,
        sqlRuleCoverage,
        "强制规则补齐失败，本轮不会执行不完整 SQL。",
        {
          id: "sql_rule_contract_repair",
          purpose: "校验 SQL 输出对强制业务规则的覆盖情况。",
          finding: sqlRuleCoverage.repair_error,
          decision: "阻止执行不完整 SQL。"
        }
      ));
    }
  } else if (sqlRuleCoverage.required_rule_keys.length) {
    pushTrace(traceItem(
      "rule_contract",
      "校验强制规则输出",
      "success",
      ruleCoverageStartedAt,
      `已处置：${sqlRuleCoverage.required_rule_keys.join("、")}`,
      sqlRuleCoverage,
      "SQL 输出已逐条覆盖目标表的强制规则。",
      {
        id: "sql_rule_contract_validation",
        purpose: "校验 SQL 输出对强制业务规则的覆盖情况。",
        finding: "强制规则均已处置",
        decision: "允许进入 SQL 校验。"
      }
    ));
  }
  generated.rule_execution = {
    manifest: mandatoryContext,
    sql_generation: sqlRuleCoverage
  };
  if (!sqlRuleCoverage.ok) {
    const message = `强制规则未完整落实：${sqlRuleCoverage.missing_rule_keys.join("、") || sqlRuleCoverage.repair_error || "未知规则"}`;
    return {
      model: generation.model,
      data: finishPayload({
        ...generated,
        answer: message,
        answer_type: "execution_error",
        sql: "",
        mandatory_context: mandatoryContext,
        warnings: [...new Set([...(generated.warnings || []), message])],
        execution: { executed: false, columns: [], rows: [], row_count: 0, message },
        sql_validation: { ok: false, skipped: true, error: message }
      }),
      raw: generation.raw,
      usage: generation.usage
    };
  }
  generated.result_sets = normalizeGeneratedResultSets(generated.result_sets);
  const hasMultipleGeneratedResultSets = generated.result_sets.length > 1;
  if (generated.result_sets.length === 1) {
    generated.sql = generated.result_sets[0].sql;
    generated.display_formats = [
      ...(generated.display_formats || []),
      ...(generated.result_sets[0].display_formats || [])
    ];
    generated.result_sets = [];
  }
  generated.decision.selected_rule_keys = [
    ...new Set([
      ...(mandatoryContext.rule_keys || []),
      ...(generated.decision.selected_rule_keys || [])
    ])
  ];
  const metricExpansionStartedAt = Date.now();
  const preserveAnalyticalSql = hasMultipleGeneratedResultSets || hasAnalyticalSqlShape(generated.sql);
  const analyticalIntent = queryRequestsAnalyticalSql(enrichedPayload, retrievalPlan);
  const deterministicMetricSql = preserveAnalyticalSql || knowledgeMetricsFromPlan(retrievalPlan).length
    ? null
    : buildDeterministicMetricSql(enrichedPayload, generated, mandatoryContext);
  const canUseDeterministicMetricSql = Boolean(
    deterministicMetricSql?.sql
    && (!analyticalIntent || hasAnalyticalSqlShape(deterministicMetricSql.sql))
  );
  if (canUseDeterministicMetricSql) {
    generated.sql = deterministicMetricSql.sql;
    generated.result_sets = [];
    generated.display_formats = deterministicMetricSql.displayFormats || [];
    generated.sql_plan = [
      ...(generated.sql_plan || []),
      {
        part: "SELECT",
        value: "按业务指标配置展开基础指标和派生公式",
        source: "deterministic_metric_expansion",
        note: "基础指标使用各自 measure.result_factor 和 scope_filter；派生指标套用公式，并把指标展示口径写入 display_formats。"
      }
    ];
    const resolvedItems = deterministicMetricSql.resolvedAccountItems || [];
    generated.warnings = [
      ...new Set([
        ...(generated.warnings || []).filter(warning => !warningContradictsResolvedItems(warning, resolvedItems)),
        ...(deterministicMetricSql.warnings || [])
      ].filter(Boolean))
    ];
    pushTrace(traceItem(
      "metric_expansion",
      "展开业务指标配置",
      "success",
      metricExpansionStartedAt,
      `输出指标：${semanticEntryLabels(enrichedPayload, "business_metric", deterministicMetricSql.selectedKeys, 8)}；基础项：${semanticEntryLabels(enrichedPayload, "business_metric", deterministicMetricSql.baseKeys, 8)}`,
      {
        selected_metric_keys: deterministicMetricSql.selectedKeys,
        base_metric_keys: deterministicMetricSql.baseKeys,
        source_table: deterministicMetricSql.sourceTable || "",
        display_formats: deterministicMetricSql.displayFormats || [],
        sql: deterministicMetricSql.sql
      },
      "后端按指标配置重新展开 SQL，已把每个基础指标自己的 result_factor 和派生指标展示口径写入结构化结果。",
      {
        id: "metric_expansion",
        purpose: "把业务指标配置转换成稳定 SQL，减少模型自由书写导致的符号错误。",
        finding: `本次展开 ${deterministicMetricSql.selectedKeys.length} 个输出指标、${deterministicMetricSql.baseKeys.length} 个基础项。`,
        decision: "采用后端展开 SQL 替代模型手写 SQL，继续进入只读校验和数据库查询。"
      }
    ));
  } else if (analyticalIntent && deterministicMetricSql?.sql && looksLikeExecutableSelectSql(generated.sql)) {
    pushTrace(traceItem(
      "metric_expansion",
      "保留模型分析意图",
      "skipped",
      metricExpansionStartedAt,
      `已命中指标：${semanticEntryLabels(enrichedPayload, "business_metric", generated.decision?.selected_metric_keys || [], 8) || "无"}`,
      sqlGenerationArtifact(generated),
      "问题包含按期间、分组、趋势、明细或对比等分析要求；后端单值指标编译结果不会覆盖模型 SQL。",
      {
        id: "metric_expansion_preserve_analysis",
        purpose: "避免通用指标编译器把分析型问题压缩成单一汇总值。",
        finding: "检测到分析型问题，但确定性编译结果没有保留 GROUP BY、WITH、窗口函数或多期间结构。",
        decision: "保留模型生成的 SQL，继续做公共过滤注入和安全校验。"
      }
    ));
  } else if (preserveAnalyticalSql && looksLikeExecutableSelectSql(generated.sql) && (generated.decision?.selected_metric_keys || []).length) {
    pushTrace(traceItem(
      "metric_expansion",
      "保留分析型 SQL 结构",
      "skipped",
      metricExpansionStartedAt,
      `已命中指标：${semanticEntryLabels(enrichedPayload, "business_metric", generated.decision.selected_metric_keys, 8)}`,
      sqlGenerationArtifact(generated),
      "模型已经生成了分组、同比或窗口计算结构；后端只保留指标口径和公共过滤，不再把它展开成单值指标。",
      {
        id: "metric_expansion",
        purpose: "避免确定性指标展开覆盖模型已经形成的分析结构。",
        finding: "检测到 GROUP BY、WITH、窗口函数或多期间分析结构。",
        decision: "保留模型 SQL 形态，继续做公共过滤注入和安全校验。"
      }
    ));
  }
  const outputContractStartedAt = Date.now();
  const outputContract = hasMultipleGeneratedResultSets
    ? {
        applied: false,
        expected: plannedOutputColumns(enrichedPayload),
        actual: generated.result_sets.flatMap(item => sqlAliasSummary(item.sql)),
        missing: [],
        reason: "多结果集分别保留各自字段契约，不按单表位置统一改名"
      }
    : enforcePlannedOutputAliases(generated, enrichedPayload);
  if (outputContract.applied || outputContract.missing.length) {
    pushTrace(traceItem(
      "output_contract",
      "校验结果列契约",
      outputContract.missing.length ? "warning" : "success",
      outputContractStartedAt,
      outputContract.reason,
      outputContract,
      outputContract.applied
        ? `SQL 结果列已与语义计划统一：${compactList(outputContract.actual, 8)}`
        : `语义计划要求 ${compactList(outputContract.expected, 8)}，SQL 当前输出 ${compactList(outputContract.actual, 8)}。`,
      {
        id: "output_contract",
        purpose: "确保语义计划、SQL 结果表和最终回答使用同一组输出名称。",
        finding: outputContract.reason,
        decision: outputContract.applied
          ? "采用语义计划中的最终列名继续校验。"
          : "保留 SQL 并在后续结果覆盖检查中继续核对，避免不安全的按位置改写。"
      }
    ));
  }
  const hasExecutableSql = hasMultipleGeneratedResultSets
    ? generated.result_sets.every(item => looksLikeExecutableSelectSql(item.sql))
    : looksLikeExecutableSelectSql(generated.sql);
  const generationSourceLabel = generation.source === "agent_loop"
    ? "循环直接生成"
    : generation.source === "deterministic_compiler"
      ? "确定性编译器"
      : `模型：${generation.model}`;
  if (generation.source !== "agent_loop" || !hasExecutableSql) {
    pushTrace(traceItem(
      "sql_generation",
      hasExecutableSql ? "形成取数 SQL" : "判断无法形成 SQL",
      hasExecutableSql ? "success" : "skipped",
      generationStartedAt,
      hasExecutableSql
        ? `${generationSourceLabel}；主指标：${generated.decision?.selected_metric_key || "未命中"}；规则：${(generated.decision?.selected_rule_keys || []).join("、") || "无"}`
        : `${generationSourceLabel}；未形成可执行 SELECT/WITH SQL`,
      sqlGenerationArtifact(generated),
      hasExecutableSql
        ? hasMultipleGeneratedResultSets
          ? `把已选依据转成 ${generated.result_sets.length} 个可独立执行的结果集：${compactList(generated.result_sets.map(item => item.title), 6)}。`
          : `把已选依据转成一条可执行 SQL；这次准备输出 ${compactList(sqlAliasSummary(generated.sql), 6) || "未识别输出列"}，并带上 ${compactList(generated.decision?.selected_rule_keys, 4) || "默认"} 口径。`
        : "当前语义和补查结果不足以安全生成 SQL；不再进入 SQL 校验和数据库执行。",
      {
        id: "sql_generation",
        purpose: "把采用的指标、规则、表结构和用户配置转换成 SQL。",
        finding: hasExecutableSql
          ? hasMultipleGeneratedResultSets
            ? `结果集：${compactList(generated.result_sets.map(item => item.title), 8)}`
            : `输出列：${compactList(sqlAliasSummary(generated.sql), 8) || "未识别"}；主指标：${generated.decision?.selected_metric_key || "未命中"}`
          : generated.answer || "未形成可执行 SQL。",
        decision: hasExecutableSql
          ? "生成结果进入后端校验，校验通过后才会查询数据库。"
          : "停止执行；只返回缺失依据，不展示伪 SQL。"
      }
    ));
  }

  if (!hasExecutableSql) {
    const knowledgeFallback = knowledgeMetricsFromPlan(retrievalPlan);
    const knowledgeAnswer = knowledgeFallback.length
      ? `已按通行定义识别这些指标：${knowledgeFallback.map(metric => `${metric.name}=${metric.formula}`).join("；")}。${generated.answer || "当前仍有基础项没有绑定到真实字段或科目，因此暂时不能给出数据库数值。"}`
      : "";
    return {
      model: generation.model,
      data: finishPayload({
        ...generated,
        resolved_sql_resultsets: resolvedSqlResultsets,
        answer: knowledgeAnswer || generated.answer || "当前语义依据不足，无法安全生成 SQL。请补充业务指标、规则或 SQL结果集映射。",
        answer_type: generated.answer_type === "sql_needed" ? "clarification_needed" : generated.answer_type || "no_evidence",
        sql: "",
        mandatory_context: mandatoryContext,
        warnings: generated.warnings || [],
        execution: { executed: false, columns: [], rows: [], row_count: 0, message: "未生成可执行 SQL，未执行。" },
        sql_validation: { ok: false, skipped: true, error: "未生成可执行 SELECT/WITH SQL" }
      }),
      raw: generation.raw,
      usage: generation.usage
    };
  }

  if (hasMultipleGeneratedResultSets) {
    const entityResolutionCache = new Map();
    const resultSets = await Promise.all(generated.result_sets.map((definition, index) => executeGeneratedResultSet({
      definition,
      index,
      payload: enrichedPayload,
      generated,
      mandatoryContext,
      entityResolutionCache,
      pushTrace,
      emitProgress
    })));
    const executedResultSets = resultSets.filter(item => item?.execution?.executed);
    const primaryResultSet = executedResultSets[0] || resultSets[0];
    const resultSetWarnings = resultSets.flatMap(item => item?.warnings || []);
    const failedTitles = resultSets.filter(item => item?.error).map(item => item.title);

    if (!executedResultSets.length) {
      const executionSkipped = resultSets.length > 0 && resultSets.every(item => !item.error && !item.execution?.executed);
      const answer = executionSkipped
        ? generated.answer || `已生成 ${resultSets.length} 个独立结果集 SQL，但当前未配置数据库连接，尚未执行。`
        : `已生成 ${resultSets.length} 个独立结果集，但本轮均未执行成功：${failedTitles.join("、") || "数据库查询失败"}。`;
      return {
        model: generation.model,
        data: finishPayload({
          ...generated,
          resolved_sql_resultsets: resolvedSqlResultsets,
          answer,
          answer_type: executionSkipped ? "sql_needed" : "execution_error",
          sql: primaryResultSet?.sql || generated.sql || "",
          mandatory_context: mandatoryContext,
          execution: primaryResultSet?.execution || { executed: false, columns: [], rows: [], row_count: 0, message: "结果集均未执行成功。" },
          display: primaryResultSet?.display || null,
          sql_validation: primaryResultSet?.sql_validation || { ok: false, error: "结果集均未执行成功" },
          result_sets: resultSets,
          warnings: [...new Set([...(generated.warnings || []), ...resultSetWarnings].filter(Boolean))]
        }),
        raw: generation.raw,
        usage: generation.usage
      };
    }

    const answerPayload = {
      ...enrichedPayload,
      generated_display_formats: primaryResultSet.display?.formats || generated.display_formats || [],
      result_presentation_directives: primaryResultSet.result_presentation_directives || {}
    };
    const answerStartedAt = Date.now();
    emitProgress(
      "answer_generation",
      "answer_generation",
      "综合多个结果集",
      answerStartedAt,
      `正在综合 ${executedResultSets.length} 个已执行结果集，不合并不同粒度的数据。`,
      {
        purpose: "把多个独立结果集整理成一份完整回答。",
        finding: `成功：${executedResultSets.map(item => item.title).join("、")}`,
        decision: "保留每个结果集的独立含义，只在文字回答中综合。"
      }
    );
    let finalAnswer;
    let finalData;
    try {
      finalAnswer = await callFinalAnswerWithRuleCoverage({
          payload: answerPayload,
          generated,
          validation: primaryResultSet.sql_validation,
          execution: primaryResultSet.execution,
          resultSets: executedResultSets
        }, { maxTokens: 2400 });
      finalData = finalAnswer.data || {};
      pushTrace(traceItem(
        "answer_generation",
        "综合多个结果集",
        "success",
        answerStartedAt,
        `综合 ${executedResultSets.length} 个结果集${failedTitles.length ? `；另有 ${failedTitles.length} 个失败` : ""}`,
        answerArtifact(finalData),
        "多个结果集已按各自标题和用途综合回答，原始表格仍分别展示。",
        {
          id: "answer_generation",
          purpose: "把多个独立结果集整理成一份完整回答。",
          finding: `成功结果集：${executedResultSets.map(item => item.title).join("、")}`,
          decision: "文字层综合，数据层保持独立。"
        }
      ));
    } catch (error) {
      const message = error.message || String(error);
      finalAnswer = { model: generation.model, raw: "", usage: null };
      finalData = {
        answer: `查询已完成：${executedResultSets.map(item => `${item.title} ${item.execution.row_count} 行`).join("；")}。${failedTitles.length ? `未完成：${failedTitles.join("、")}。` : ""}`,
        answer_type: "final_answer",
        warnings: [message]
      };
      pushTrace(traceItem(
        "answer_generation",
        "综合多个结果集",
        "failed",
        answerStartedAt,
        message,
        null,
        "结果集已经返回，但模型总结失败；保留所有表格并使用确定性降级说明。",
        {
          id: "answer_generation",
          purpose: "把多个独立结果集整理成一份完整回答。",
          finding: message,
          decision: "保留查询结果，使用行数和标题生成降级回答。"
        }
      ));
    }

    const resultSetSummaries = executedResultSets.map(item => ({
      key: item.key,
      title: item.title,
      ...buildExecutionResultSummary(item.execution, item.display?.formats || [])
    }));
    const resolvedLookupItems = resolvedItemsFromResultsets(enrichedPayload.retrieval_plan, resolvedSqlResultsets);
    return {
      model: finalAnswer.model || generation.model,
      data: finishPayload({
        ...generated,
        resolved_sql_resultsets: resolvedSqlResultsets,
        answer: finalData.answer || generated.answer || "查询已完成。",
        answer_type: finalData.answer_type || "final_answer",
        sql: primaryResultSet.sql,
        mandatory_context: mandatoryContext,
        execution: primaryResultSet.execution,
        display: primaryResultSet.display,
        sql_validation: primaryResultSet.sql_validation,
        result_summary: resultSetSummaries[0] || null,
        result_set_summaries: resultSetSummaries,
        result_presentation_directives: primaryResultSet.result_presentation_directives,
        result_sets: resultSets,
        rule_execution: {
          ...(generated.rule_execution || {}),
          renderer_rule: finalData.rule_execution || null
        },
        warnings: [...new Set([
          ...(generated.warnings || []),
          ...resultSetWarnings,
          ...(finalData.warnings || []),
          ...(failedTitles.length ? [`部分结果集未完成：${failedTitles.join("、")}`] : [])
        ].filter(Boolean))]
          .filter(warning => !warningContradictsResolvedItems(warning, resolvedLookupItems))
          .filter(warning => !warningContradictsResolvedLookupEvidence(warning, enrichedPayload, primaryResultSet.execution))
      }),
      raw: finalAnswer.raw,
      usage: {
        generation: generation.usage,
        final_answer: finalAnswer.usage
      }
    };
  }

  stageStartedAt = Date.now();
  const enforcement = enforceMandatoryContextOnGenerated(generated, mandatoryContext, enrichedPayload);
  const entityResolutionStartedAt = Date.now();
  const entityResolution = await resolveGeneratedTextEntities(generated.sql, enrichedPayload, new Map());
  generated.sql = entityResolution.sql;
  if (entityResolution.resolutions.length) {
    generated.sql_plan = [
      ...(generated.sql_plan || []),
      ...entityResolution.resolutions.map(item => ({
        part: "WHERE",
        value: item.applied_sql,
        source: "entity_resolution",
        note: `用户名称“${item.input_value}”已根据数据库候选解析为 ${item.matched_values.join("、")}`
      }))
    ];
    pushTrace(traceItem(
      "entity_resolution",
      "解析业务名称",
      "success",
      entityResolutionStartedAt,
      entityResolution.resolutions.map(item => `${item.field}: ${item.input_value} -> ${item.matched_values.join(" / ")}`).join("；"),
      entityResolution,
      "用户输入的业务简称已与数据库登记值匹配，避免把简称机械地当作完整枚举值。",
      {
        id: "entity_resolution",
        purpose: "处理用户简称与数据库完整登记名称不一致的问题。",
        finding: entityResolution.resolutions.map(item => `${item.input_value} -> ${item.matched_values.join(" / ")}`).join("；"),
        decision: "使用数据候选改写文本实体过滤，不改变编码和固定口径。"
      }
    ));
  }

  let validation;
  stageStartedAt = Date.now();
  emitProgress(
    "sql_validation",
    "sql_validation",
    "检查 SQL 是否可执行",
    stageStartedAt,
    "SQL 已生成，正在检查是否只读、是否只访问允许的数据表。",
    {
      purpose: "在真正执行前拦截非只读 SQL、越权表和明显不安全语句。",
      finding: "等待 SQL 校验结果。",
      decision: "校验通过后才会查询数据库。"
    }
  );
  try {
    validation = validateReadOnlySql(generated.sql, enrichedPayload);
    pushTrace(traceItem(
      "sql_validation",
      "检查 SQL 是否可执行",
      "success",
      stageStartedAt,
      `引用表：${validation.usedTables.join(", ") || "无"}`,
      validationArtifact(validation),
      `检查 SQL 是否只读、是否只访问允许的数据表；结果通过，实际会查询 ${compactList(validation.usedTables, 4) || "无"}。`,
      {
        id: "sql_validation",
        purpose: "在真正执行前拦截非只读 SQL、越权表和明显不安全语句。",
        finding: `引用表：${validation.usedTables.join("、") || "无"}`,
        decision: "校验通过，允许进入数据库查询。"
      }
    ));
  } catch (error) {
    pushTrace(traceItem(
      "sql_validation",
      "检查 SQL 是否可执行",
      "failed",
      stageStartedAt,
      error.message,
      null,
      "SQL 没有通过只读或授权表校验，因此不会执行数据库查询。",
      {
        id: "sql_validation",
        purpose: "防止错误 SQL 直接访问数据库。",
        finding: error.message,
        decision: "停止执行，不查询数据库。"
      }
    ));
    return {
      model: generation.model,
      data: finishPayload({
        ...generated,
        resolved_sql_resultsets: resolvedSqlResultsets,
        answer: `我已经完成语义理解，但生成的 SQL 没有通过安全校验：${error.message}`,
        answer_type: "clarification_needed",
        sql: generated.sql || "",
        mandatory_context: mandatoryContext,
        warnings: [...generated.warnings, error.message],
        execution: { executed: false, columns: [], rows: [], row_count: 0, message: "SQL 校验失败，未执行。" },
        sql_validation: { ok: false, error: error.message }
      }),
      raw: generation.raw,
      usage: generation.usage
    };
  }
  let execution;
  let repairAttempts = 0;
  const maxRepairAttempts = 1;
  while (true) {
    stageStartedAt = Date.now();
    const executionTraceId = repairAttempts ? `sql_execution_retry_${repairAttempts + 1}` : "sql_execution";
    emitProgress(
      executionTraceId,
      "sql_execution",
      repairAttempts ? `重新查询数据库（第 ${repairAttempts + 1} 次）` : "查询数据库",
      stageStartedAt,
      "SQL 已通过校验，正在到数据库查询真实结果。",
      {
        purpose: "用通过校验的 SQL 获取真实结果。",
        finding: "等待数据库返回结果。",
        decision: "返回后会整理结果；如果执行失败，会尝试自动修复。"
      }
    );
    try {
      execution = await executeSql(validation.sql);
      pushTrace(traceItem(
        "sql_execution",
        execution.executed ? "查询数据库" : "跳过数据库查询",
        execution.executed ? "success" : "skipped",
        stageStartedAt,
        execution.executed ? `返回 ${execution.row_count} 行；列：${(execution.columns || []).join("、") || "无"}` : execution.message,
        executionArtifact(execution),
        execution.executed
          ? `数据库已经返回结果：${execution.row_count} 行，字段是 ${compactList(execution.columns, 8) || "无"}。后面的回答只基于这些结果整理。`
          : "当前没有执行数据库查询，因此只能保留 SQL 草案，不能给出真实数值。",
        {
          id: executionTraceId,
          purpose: "用通过校验的 SQL 获取真实结果。",
          finding: execution.executed ? `返回 ${execution.row_count} 行；字段：${compactList(execution.columns, 8) || "无"}` : execution.message,
          decision: execution.executed ? "采用数据库结果作为最终回答依据。" : "不生成真实数值，只保留 SQL 草案。"
        }
      ));
      break;
    } catch (error) {
      const errorText = error.message || String(error);
      const failedSql = validation.sql;
      pushTrace(traceItem(
        "sql_execution",
        repairAttempts ? `重新查询数据库（第 ${repairAttempts + 1} 次）` : "查询数据库",
        "failed",
        stageStartedAt,
        errorText,
        { sql: failedSql, error: errorText, attempt: repairAttempts + 1 },
        repairAttempts < maxRepairAttempts
          ? "SQL 已通过安全校验，但数据库执行失败；下一步会把错误和原 SQL 交给模型自动修复。"
          : "SQL 自动修复后仍执行失败；停止重试，返回最后一次错误。",
        {
          id: executionTraceId,
          purpose: "执行已通过校验的 SQL。",
          finding: errorText,
          decision: repairAttempts < maxRepairAttempts
            ? "进入自动修复阶段，修复后重新校验并执行。"
            : "已达到最大修复次数，停止执行。"
        }
      ));

      if (repairAttempts >= maxRepairAttempts) {
        execution = {
          executed: false,
          columns: [],
          rows: [],
          row_count: 0,
          message: `SQL 执行失败：${errorText}`
        };
        return {
          model: generation.model,
          data: finishPayload({
            ...generated,
            resolved_sql_resultsets: resolvedSqlResultsets,
            answer: `SQL 已生成并通过只读校验，但自动修复后仍执行失败：${errorText}`,
            answer_type: "execution_error",
            sql: validation.sql,
            mandatory_context: mandatoryContext,
            execution,
            sql_validation: { ok: true, ...validation },
            warnings: [...generated.warnings, execution.message]
          }),
          raw: generation.raw,
          usage: generation.usage
        };
      }

      const repairStartedAt = Date.now();
      const repairTraceId = `sql_repair_${repairAttempts + 1}`;
      emitProgress(
        repairTraceId,
        "sql_repair",
        `自动修复 SQL（第 ${repairAttempts + 1} 次）`,
        repairStartedAt,
        "数据库返回了错误，正在把错误和原 SQL 交给模型重写。",
        {
          purpose: "把数据库真实错误反馈给模型，自动修正语法、字段或聚合结构。",
          finding: `原错误：${errorText}`,
          decision: "修复后会重新落实强制口径、重新校验并再次执行。"
        }
      );
      try {
        const repair = await callModelJson(
          buildSqlRepairMessages({
            payload: enrichedPayload,
            generated,
            validation,
            error: errorText,
            attempt: repairAttempts + 1
          }),
          { temperature: 0.03, maxTokens: 4096 }
        );
        const repaired = normalizeGeneratedSqlData({ ...generated, ...(repair.data || {}) }, enrichedPayload);
        const normalizedFailedSql = normalizeSql(failedSql);
        const normalizedRepairedSql = normalizeSql(repaired.sql);
        if (!normalizedRepairedSql) throw new Error("模型没有返回修复后的 SQL");
        if (normalizedRepairedSql === normalizedFailedSql) throw new Error("模型返回的修复 SQL 与失败 SQL 相同");
        repaired.decision = {
          ...(generated.decision || {}),
          ...(repaired.decision || {}),
          selected_rule_keys: [
            ...new Set([
              ...(mandatoryContext.rule_keys || []),
              ...(generated.decision?.selected_rule_keys || []),
              ...(repaired.decision?.selected_rule_keys || [])
            ])
          ]
        };
        repaired.warnings = [
          ...new Set([
            ...(generated.warnings || []),
            ...(repaired.warnings || [])
          ])
        ].filter(warning => !/^SQL 第 \d+ 次执行失败后已自动修复/.test(String(warning || "")));
        generated = repaired;
        const repairEnforcement = enforceMandatoryContextOnGenerated(generated, mandatoryContext, enrichedPayload);
        validation = validateReadOnlySql(generated.sql, enrichedPayload);
        repairAttempts += 1;
        pushTrace(traceItem(
          "sql_repair",
          `自动修复 SQL（第 ${repairAttempts} 次）`,
          "success",
          repairStartedAt,
          `模型：${repair.model}；重新引用表：${validation.usedTables.join(", ") || "无"}`,
          sqlRepairArtifact({
            failedSql,
            repairedSql: validation.sql,
            error: errorText,
            enforcement: repairEnforcement,
            validation,
            attempt: repairAttempts
          }),
          "根据数据库错误重写 SQL，并重新落实强制口径与只读校验；修复后的 SQL 将再次执行。",
          {
            id: repairTraceId,
            purpose: "把数据库返回的真实错误反馈给模型，自动修正语法、UNION 列数、字段或聚合结构。",
            finding: `原错误：${errorText}`,
            decision: "修复 SQL 已通过只读和授权表校验，继续重新执行。"
          }
        ));
      } catch (repairError) {
        const repairErrorText = repairError.message || String(repairError);
        pushTrace(traceItem(
          "sql_repair",
          `自动修复 SQL（第 ${repairAttempts + 1} 次）`,
          "failed",
          repairStartedAt,
          repairErrorText,
          { failed_sql: failedSql, original_error: errorText, repair_error: repairErrorText },
          "数据库执行失败后尝试自动修复，但修复 SQL 没有通过生成或校验；停止执行。",
          {
            id: repairTraceId,
            purpose: "自动修复失败 SQL。",
            finding: repairErrorText,
            decision: "停止执行，返回原始执行错误和修复失败原因。"
          }
        ));
        execution = {
          executed: false,
          columns: [],
          rows: [],
          row_count: 0,
          message: `SQL 执行失败：${errorText}；自动修复失败：${repairErrorText}`
        };
        return {
          model: generation.model,
          data: finishPayload({
            ...generated,
            resolved_sql_resultsets: resolvedSqlResultsets,
            answer: `SQL 已生成并通过只读校验，但执行失败，且自动修复失败：${repairErrorText}`,
            answer_type: "execution_error",
            sql: failedSql,
            mandatory_context: mandatoryContext,
            execution,
            sql_validation: { ok: true, ...validation },
            warnings: [...generated.warnings, execution.message]
          }),
          raw: generation.raw,
          usage: generation.usage
        };
      }
    }
  }
  if (!execution.executed) {
    return {
      model: generation.model,
      data: finishPayload({
        ...generated,
        resolved_sql_resultsets: resolvedSqlResultsets,
        answer: generated.answer || "SQL 已生成，但当前未配置数据库连接，无法执行得到最终数值。",
        answer_type: "sql_needed",
        sql: validation.sql,
        mandatory_context: mandatoryContext,
        execution,
        sql_validation: { ok: true, ...validation },
        warnings: [...generated.warnings, execution.message].filter(Boolean)
      }),
      raw: generation.raw,
      usage: generation.usage
    };
  }

  stageStartedAt = Date.now();
  emitProgress(
    "result_presentation",
    "result_presentation",
    "理解展示规则",
    stageStartedAt,
    "查询结果已经返回，正在把结果展示要求理解成结构化渲染指令。",
    {
      purpose: "把自然语言展示要求编译成表格、格式和最终回答可共同使用的结构化 directive。",
      finding: `结果列：${compactList(execution.columns || [], 8) || "无"}`,
      decision: "展示规则只影响渲染和回答表达，不改变 SQL 或取数口径。"
    }
  );
  enrichedPayload.generated_display_formats = generated.display_formats || [];
  const presentationDirectives = await resolveResultPresentationDirectives(enrichedPayload, execution.columns || [], execution.rows || []);
  enrichedPayload.result_presentation_directives = presentationDirectives;
  generated.warnings = [
    ...new Set([
      ...(generated.warnings || []),
      ...(presentationDirectives.warnings || [])
    ].filter(Boolean))
  ];
  pushTrace(traceItem(
    "result_presentation",
    "理解展示规则",
    presentationDirectives.warnings?.length ? "skipped" : "success",
    stageStartedAt,
    presentationDirectiveNames(presentationDirectives).join("、") || "没有需要执行的展示指令",
    presentationDirectives,
    "展示要求已经被编译成结构化 directive；表格渲染和最终回答会复用这一份结果。",
    {
      id: "result_presentation",
      purpose: "统一理解自然语言结果展示规则，避免回答、表格和前端各自猜。",
      finding: presentationDirectiveNames(presentationDirectives).join("、") || "未产生展示指令",
      decision: "只把 directive 应用于展示层，不改变 SQL 或查询结果。"
    }
  ));

  stageStartedAt = Date.now();
  let finalAnswer;
  let finalData = {};
  emitProgress(
    "answer_generation",
    "answer_generation",
    "组织最终回答",
    stageStartedAt,
    "查询结果已经返回，正在整理成用户能直接看的回答。",
    {
      purpose: "把数据库结果、SQL 和口径整理成业务可读回答。",
      finding: `返回 ${execution.row_count || 0} 行，字段：${compactList(execution.columns || [], 8) || "无"}`,
      decision: "只整理表达，不再修改 SQL 或取数口径。"
    }
  );
  const deterministicFinalData = mandatoryContext.required_stage_rule_keys?.renderer_rule?.length
    ? null
    : deterministicAnswerFromExecution(execution, generated, mandatoryContext, enrichedPayload);
  if (deterministicFinalData) {
    finalAnswer = { model: "deterministic-result", raw: "", usage: null };
    finalData = deterministicFinalData;
    pushTrace(traceItem(
      "answer_generation",
      "组织最终回答",
      "success",
      stageStartedAt,
      "单行结构化结果，后端直接整理回答",
      answerArtifact(finalData),
      "查询结果已经足够明确，不再额外调用模型总结，避免简单问题走重流程。",
      {
        id: "answer_generation",
        purpose: "把数据库结果转成用户可读回答。",
        finding: `返回 1 行，字段：${compactList(execution.columns || [], 8) || "无"}`,
        decision: "使用确定性模板整理回答，不再调用模型。"
      }
    ));
  } else {
  try {
    finalAnswer = await callFinalAnswerWithRuleCoverage(
      { payload: enrichedPayload, generated, validation, execution },
      { maxTokens: 2048 }
    );
    finalData = finalAnswer.data || {};
    pushTrace(traceItem(
      "answer_generation",
      "组织最终回答",
      "success",
      stageStartedAt,
      `模型：${finalAnswer.model}；回答类型：${finalData.answer_type || "final_answer"}`,
      answerArtifact(finalData),
      "把查询结果整理成业务可读的结论；这一步只做表达整理，不再修改 SQL 或取数口径。",
      {
        id: "answer_generation",
        purpose: "把数据库结果、SQL 和口径整理成业务可读回答。",
        finding: `回答类型：${finalData.answer_type || "final_answer"}`,
        decision: "只整理表达，不再修改 SQL、过滤条件或取数口径。"
      }
    ));
  } catch (error) {
    pushTrace(traceItem(
      "answer_generation",
      "组织最终回答",
      "failed",
      stageStartedAt,
      error.message || String(error),
      null,
      "查询已经完成，但模型整理自然语言回答失败；可以先查看查询结果和 SQL。",
      {
        id: "answer_generation",
        purpose: "把查询结果转成自然语言回答。",
        finding: error.message || String(error),
        decision: "保留 SQL 和结果表，使用降级回答。"
      }
    ));
    const firstRowText = execution.rows[0] ? JSON.stringify(execution.rows[0]) : "无结果";
    finalAnswer = { model: generation.model, raw: "", usage: null };
    finalData = {
      answer: `查询已执行完成，但结果总结失败。首行结果：${firstRowText}`,
      answer_type: execution.rows.length ? "final_answer" : "empty_result",
      warnings: [error.message || String(error)]
    };
  }
  }
  const enforcedFinal = enforceAnswerResultSummary(finalData, execution, generated, enrichedPayload);
  finalData = ensureFinalAnswerPeriodContext(enforcedFinal.finalData, execution);
  const display = buildExecutionDisplay(enrichedPayload, generated, execution);
  const resolvedLookupItems = resolvedItemsFromResultsets(enrichedPayload.retrieval_plan, resolvedSqlResultsets);
  return {
    model: finalAnswer.model || generation.model,
    data: finishPayload({
      ...generated,
      resolved_sql_resultsets: resolvedSqlResultsets,
      answer: finalData.answer || generated.answer || "查询已完成。",
      answer_type: finalData.answer_type || "final_answer",
      sql: validation.sql,
      mandatory_context: mandatoryContext,
      execution,
      result_summary: enforcedFinal.summary,
      result_presentation_directives: presentationDirectives,
      rule_execution: {
        ...(generated.rule_execution || {}),
        renderer_rule: finalData.rule_execution || null
      },
      display,
      sql_validation: { ok: true, ...validation },
      warnings: [...new Set([...(generated.warnings || []), ...(finalData.warnings || [])].filter(Boolean))]
        .filter(warning => !warningContradictsResolvedItems(warning, resolvedLookupItems))
        .filter(warning => !warningContradictsResolvedLookupEvidence(warning, enrichedPayload, execution))
    }),
    raw: finalAnswer.raw,
    usage: {
      generation: generation.usage,
      final_answer: finalAnswer.usage
    }
  };
}

function serveStatic(req, res, headOnly = false) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);
  const filePath = pathname === "/" || pathname === "/metric-workbench/"
    ? join(rootDir, "index.html")
    : join(projectRoot, pathname.replace(/^\/+/, ""));
  const normalized = normalize(filePath);
  if (!normalized.startsWith(projectRoot)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  if (!existsSync(normalized)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const ext = extname(normalized);
  res.writeHead(200, {
    "Content-Type": mimeTypes[ext] || "application/octet-stream",
    "Cache-Control": "no-store"
  });
  res.end(headOnly ? undefined : readFileSync(normalized));
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "GET" && requestUrl.pathname === "/api/semantic-workbench-data") {
    try {
      const result = await loadSemanticWorkbenchData();
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message || String(error) });
    }
    return;
  }
  if (req.method === "POST" && requestUrl.pathname === "/api/semantic-entry-save") {
    try {
      const body = await readBody(req);
      const entry = await saveSemanticEntry(JSON.parse(body || "{}"));
      sendJson(res, 200, { ok: true, entry });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message || String(error) });
    }
    return;
  }
  if (req.method === "POST" && requestUrl.pathname === "/api/semantic-entry-delete") {
    try {
      const body = await readBody(req);
      const result = await deleteSemanticEntry(JSON.parse(body || "{}"));
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message || String(error) });
    }
    return;
  }
  if (req.method === "POST" && req.url === "/api/nl2sql-stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    res.write(": connected\n\n");
    const heartbeat = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) {
        res.write(`: heartbeat ${Date.now()}\n\n`);
      }
    }, 15_000);
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || "{}");
      const result = await callNl2Sql(payload, {
        report: message => {
          if (message.type === "trace") {
            sendSse(res, "trace", { item: message.item, elapsed_ms: message.elapsed_ms });
          }
        }
      });
      sendSse(res, "done", { ok: true, ...result });
    } catch (error) {
      sendSse(res, "error", { ok: false, error: error.message || String(error) });
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
    return;
  }
  if (req.method === "POST" && req.url === "/api/nl2sql") {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || "{}");
      const result = await callNl2Sql(payload);
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message || String(error) });
    }
    return;
  }
  if (req.method === "POST" && req.url === "/api/detective-agent") {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || "{}");
      const result = await callDetectiveModel(payload);
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message || String(error) });
    }
    return;
  }
  if (req.method === "GET" || req.method === "HEAD") {
    serveStatic(req, res, req.method === "HEAD");
    return;
  }
  res.writeHead(405);
  res.end("Method not allowed");
});

server.listen(config.port, () => {
  console.log(`Metric workbench running at http://127.0.0.1:${config.port}/metric-workbench/`);
  console.log(config.apiKey ? `Model proxy enabled: ${config.model}` : "Model proxy disabled: missing MOI_TAAS_API_KEY");
});
