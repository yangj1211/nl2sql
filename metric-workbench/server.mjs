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
  const tables = selected.length ? selected : parseDataSourceTables(payload?.data_source);
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
  const tables = (preferredTables.length ? preferredTables : catalogTables(payload)).slice(0, 4);
  const profiles = [];
  for (const table of tables) {
    try {
      profiles.push(await loadTableProfile(table));
    } catch (error) {
      profiles.push({
        table: table.split(".").pop(),
        qualified_table: table,
        columns: [],
        sample_rows: [],
        sample_row_count: 0,
        error: error.message || String(error)
      });
    }
  }
  return profiles;
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
    /^cpmb_kgd4b76$/i,
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
  if (!Array.isArray(plan.disabled_mandatory_filter_ids)) plan.disabled_mandatory_filter_ids = [];
  if (!Array.isArray(plan.sql_resultset_lookups)) plan.sql_resultset_lookups = [];
  if (!Array.isArray(plan.sql_plan)) plan.sql_plan = [];
  if (!Array.isArray(plan.display_formats)) plan.display_formats = [];
  if (!plan.semantic_plan || typeof plan.semantic_plan !== "object") plan.semantic_plan = {};
  plan.coverage_checklist = normalizeCoverageChecklist(plan.coverage_checklist || plan.semantic_plan.coverage_checklist || []);
  plan.disabled_mandatory_filter_ids = [
    ...new Set(plan.disabled_mandatory_filter_ids.map(item => String(item || "").trim()).filter(Boolean))
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
  const resolvedItems = resolvedAccountItemsFromPayload({
    ...payload,
    retrieval_plan: plan,
    resolved_sql_resultsets: resolvedSqlResultsets
  });
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

function scoreSemanticEntryForQuestion(entry, question) {
  const query = String(question || "");
  const chunks = [
    entry?.key,
    entry?.name,
    ...(Array.isArray(entry?.aliases) ? entry.aliases : []),
    semanticEntryContextText(entry)
  ].filter(Boolean);
  return chunks.reduce((best, chunk) => {
    const score = Math.max(
      scoreCandidateValue(query, chunk),
      scoreCandidateValue(chunk, query)
    );
    return Math.max(best, score);
  }, 0);
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
  const mandatoryRuleKeys = bpcMandatoryRuleKeys(payload);
  return {
    business_metric: selectRelevantSemanticEntries(payload, "business_metric", 18),
    logic_text: selectRelevantSemanticEntries(payload, "logic_text", 8, mandatoryRuleKeys),
    result_presentation: selectRelevantSemanticEntries(payload, "result_presentation", 6),
    sql_resultset: selectRelevantSemanticEntries(payload, "sql_resultset", 6),
    table_column_note: selectRelevantSemanticEntries(payload, "table_column_note", 4),
    standard_qa: selectRelevantSemanticEntries(payload, "standard_qa", 4)
  };
}

function stripQuestionTermNoise(value) {
  return String(value || "")
    .replace(/20\d{2}\s*年\s*(?:0?[1-9]|1[0-2])?\s*月?/g, " ")
    .replace(/20\d{2}\.(?:0?[1-9]|1[0-2])/g, " ")
    .replace(/\b20\d{2}\b/g, " ")
    .replace(/(请|帮我|查询|提供|看看|一下|多少|是多少|数据|集团口径|集团|口径|法口|管口|分别|以及|还有|相关|情况|统计|汇总|的)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function questionSemanticTerms(question) {
  const text = stripQuestionTermNoise(question);
  return [...new Set(text
    .split(/[\/、,，;；\n]+/)
    .map(item => stripQuestionTermNoise(item))
    .map(item => item.replace(/^[和与及]+|[和与及]+$/g, "").trim())
    .filter(item => normalizeCandidateText(item).length >= 2)
  )];
}

function metricMentionNames(metric) {
  return [metric?.name, metric?.key, ...(Array.isArray(metric?.aliases) ? metric.aliases : [])]
    .map(item => String(item || "").trim())
    .filter(item => normalizeCandidateText(item).length >= 2);
}

function metricExplicitlyMentioned(metric, question) {
  return metricMatchesCoverageItem(metric, question);
}

function pruneContainedMetricMentions(metrics) {
  return metrics.filter(metric => {
    const names = metricMentionNames(metric).map(normalizeCandidateText);
    return !metrics.some(other => {
      if (other === metric) return false;
      const otherNames = metricMentionNames(other).map(normalizeCandidateText);
      return names.some(name => (
        name.length >= 2
        && otherNames.some(otherName => otherName.length > name.length && otherName.includes(name))
      ));
    });
  });
}

function selectedMetricsFromQuestion(payload) {
  const metrics = semanticEntries(payload, "business_metric");
  return pruneContainedMetricMentions(metrics.filter(metric => metricExplicitlyMentioned(metric, payload.question || "")));
}

function questionRequestsMetricBreakdown(payload) {
  return /哪一项|哪项|哪个|增长较多|增长最多|增长最大|分项|拆分|构成|分别|各项|明细|分类|同比变化|变动/.test(String(payload?.question || ""));
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
    if (key === "bpc_sales_admin_rd_expense") {
      ["bpc_management_expense", "bpc_sales_expense", "bpc_rd_expense"].forEach(add);
    }
  });
  return result;
}

function removeMetricMentionsFromTerm(term, selectedMetrics) {
  let text = String(term || "");
  selectedMetrics.forEach(metric => {
    metricMentionNames(metric)
      .sort((a, b) => b.length - a.length)
      .forEach(name => {
        if (!name) return;
        text = text.split(name).join(" ");
      });
  });
  return stripQuestionTermNoise(text)
    .replace(/^[和与及]+|[和与及]+$/g, "")
    .trim();
}

function unresolvedQuestionTerms(payload, selectedMetrics) {
  return questionSemanticTerms(payload.question || "")
    .map(term => removeMetricMentionsFromTerm(term, selectedMetrics))
    .map(term => stripQuestionTermNoise(term))
    .filter(term => normalizeCandidateText(term).length >= 2)
    .filter(term => !selectedMetrics.some(metric => metricMatchesCoverageItem(metric, term)));
}

function preferredSqlResultsetForLookup(payload, terms) {
  const resultsets = semanticEntries(payload, "sql_resultset");
  if (!resultsets.length) return null;
  const termText = (terms || []).join(" ");
  const ranked = resultsets.map((entry, index) => {
    const text = semanticEntryContextText(entry);
    const accountBias = /(科目|account|racct|saknr|合并科目|编码|映射)/i.test(text) ? 0.2 : 0;
    return {
      entry,
      index,
      score: scoreSemanticEntryForQuestion(entry, termText) + accountBias
    };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  return ranked[0]?.entry || null;
}

async function tryEvidenceFirstPlan(payload, pushTrace) {
  if (!isBpcPayload(payload)) return null;
  const startedAt = Date.now();
  const metricEntries = semanticEntries(payload, "business_metric");
  const metricMap = new Map(metricEntries.map(metric => [metric.key, metric]));
  const initiallySelectedMetrics = selectedMetricsFromQuestion(payload);
  const initiallySelectedMetricKeys = initiallySelectedMetrics.map(metric => metric.key).filter(Boolean);
  const selectedMetricKeys = expandSelectedMetricKeysByBreakdown(payload, metricMap, initiallySelectedMetricKeys);
  const selectedMetrics = selectedMetricKeys.map(key => metricMap.get(key)).filter(Boolean);
  const unresolvedTerms = unresolvedQuestionTerms(payload, selectedMetrics);
  if (!selectedMetricKeys.length && !unresolvedTerms.length) return null;
  if (!selectedMetricKeys.length && !unresolvedTerms.length) return null;

  const resultsetEntry = unresolvedTerms.length ? preferredSqlResultsetForLookup(payload, unresolvedTerms) : null;
  if (unresolvedTerms.length && !resultsetEntry) return null;

  const plan = normalizeRetrievalPlanData({
    intent: "metric_query",
    selected_metric_keys: selectedMetricKeys,
    selected_rule_keys: bpcMandatoryRuleKeys(payload),
    disabled_mandatory_filter_ids: [],
    needs_sql_resultset: Boolean(unresolvedTerms.length),
    sql_resultset_lookups: unresolvedTerms.length
      ? [{
          key: resultsetEntry.key || resultsetEntry.name,
          terms: unresolvedTerms,
          reason: "用户问题中包含未配置为业务指标的对象，先用 SQL结果集解析编码。"
        }]
      : [],
    coverage_checklist: [
      ...selectedMetrics.map(metric => ({
        item: metric.name || metric.key,
        item_type: "metric",
        status: "covered",
        evidence_type: "business_metric",
        evidence_key: metric.key,
        needs_lookup: false,
        note: "问题文本命中业务指标名称或别名。"
      })),
      ...unresolvedTerms.map(term => ({
        item: term,
        item_type: "object",
        status: "needs_lookup",
        evidence_type: "none",
        evidence_key: resultsetEntry?.key || resultsetEntry?.name || "",
        needs_lookup: true,
        note: "未命中业务指标，先通过 SQL结果集解析编码。"
      }))
    ],
    semantic_plan: {
      mode: unresolvedTerms.length ? "needs_lookup" : "verified_metric_query",
      metrics: selectedMetricKeys,
      tables: selectedPayloadTables(payload),
      time: bpcPeriodInfo(payload).period || "",
      dimensions: [],
      calculations: ["aggregation"],
      filters: bpcMandatoryRuleKeys(payload),
      needs_lookup: unresolvedTerms,
      output: [...selectedMetrics.map(metric => metric.name || metric.key), ...unresolvedTerms]
    },
    summary: "语义目录和目录结果集已能覆盖本轮问题。",
    warnings: []
  });

  let resolvedSqlResultsets = [];
  if (unresolvedTerms.length) {
    resolvedSqlResultsets = await resolveSqlResultsets(payload, plan);
    const resolution = lookupResolutionFromResultsets(payload, plan, resolvedSqlResultsets);
    if (!resolution.ok) return null;
    plan.needs_sql_resultset = false;
    plan.coverage_checklist = plan.coverage_checklist.map(item => {
      if (!unresolvedTerms.includes(item.item)) return item;
      return {
        ...item,
        status: "covered",
        evidence_type: "sql_resultset",
        needs_lookup: false,
        note: "已通过 SQL结果集解析到可用编码。"
      };
    });
  }

  pushTrace(traceItem(
    "semantic_plan",
    "证据覆盖检查",
    "success",
    startedAt,
    `指标：${semanticEntryLabels(payload, "business_metric", selectedMetricKeys, 8) || "无"}；目录对象：${compactList(unresolvedTerms, 6) || "无"}`,
    {
      selected_metric_keys: selectedMetricKeys,
      unresolved_terms: unresolvedTerms,
      resolved_sql_resultsets: resolvedSqlResultsets.map(item => ({
        key: item.key,
        row_count: item.row_count,
        rows: (item.rows || []).slice(0, 5)
      })),
      retrieval_plan: plan
    },
    "当前问题已经被业务指标和目录结果集覆盖，可以直接进入 SQL 编译，不再让模型重复判断。",
    {
      id: "evidence_first_plan",
      purpose: "在证据已经完整时提前收束，减少模型循环耗时。",
      finding: unresolvedTerms.length
        ? `已补齐目录对象：${compactList(unresolvedTerms, 6)}`
        : `已命中指标：${semanticEntryLabels(payload, "business_metric", selectedMetricKeys, 8)}`,
      decision: "跳过第一轮模型判断，交给确定性 SQL 编译器。"
    }
  ));

  return {
    mode: "sql",
    retrievalPlan: plan,
    resolvedSqlResultsets,
    generated: null
  };
}

function buildAgentLoopMessages(payload, state) {
  const catalogContext = agentSemanticCatalogContext(payload);
  const schema = {
    action: "plan_ready | lookup_sql_resultset | answer_direct | ask_clarification",
    intent: "metric_query | trend_analysis | period_overview | table_profile | table_analysis | dimension_summary | detail_query | rule_explanation | sql_resultset_lookup | unknown",
    selected_metric_keys: ["string"],
    selected_rule_keys: ["string"],
    disabled_mandatory_filter_ids: ["string"],
    sql_resultset_lookups: [{ key: "string", terms: ["string"], reason: "string" }],
    coverage_checklist: [{
      item: "用户问题里的指标、对象、时间、维度、过滤条件或输出要求",
      item_type: "metric | object | time | dimension | filter | output | rule | table | format",
      status: "covered | needs_lookup | unsupported | ambiguous",
      evidence_type: "business_metric | logic_text | result_presentation | sql_resultset | table_column_note | standard_qa | table_context | user_question | none",
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
      output: ["expected result columns"]
    },
    sql_plan: [{ part: "SELECT | FROM | WHERE | GROUP BY | RULE | CHECK", value: "string", source: "string", note: "string" }],
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
        "必须输出 coverage_checklist：逐项拆出用户问题中的所有指标/对象/时间/维度/过滤条件/输出要求/展示要求。每一项都要写 status 和 evidence。",
        "意图不要都归成 metric_query：多期间、同比、增长、趋势归 trend_analysis；行数、样例、字段分布、表结构归 table_profile；按字段分组汇总归 dimension_summary；查明细清单归 detail_query。",
        "多对象问题必须逐项覆盖，不能因为部分对象命中 business_metric 就忽略其他对象。",
        "只有 coverage_checklist 中所有可执行对象都是 covered，才允许 plan_ready 或 answer_direct。",
        "如果某个对象没有 business_metric，但它像科目、枚举、类型、状态、名称或编码映射项，status 必须是 needs_lookup，并在 sql_resultset_lookups 中选择相关 SQL结果集。",
        "不要用常识猜科目编码、费用类型编码或枚举编码；如果目录里可能存在，就先查 SQL结果集。unsupported 只能用于目录补查后仍无证据的对象。",
        "SQL结果集不是普通样例，它是目录/映射知识；需要解析编码、枚举或备注时必须查。",
        "如果某个输出列需要展示成百分数、指定单位或指定精度，可以写入 display_formats；不要为了展示要求改变取数口径。",
        "display_formats.display_scale 表示展示前缩放系数，不要求 SQL 为展示而改写。例如公式结果是 0.089 且业务要显示 8.9%，则 display_scale=100、format=percent、suffix='%'。",
        "semantic_catalog.result_presentation 只描述结果渲染/回答展示要求，不参与取数口径、指标选择或 WHERE/SELECT 生成；真正生效由后端渲染层处理。",
        "如果 result_presentation 提到百分数、单位、精度、业务总结或图表，只需要在 coverage_checklist 标记展示要求；不要把它当成业务过滤或计算规则。",
        "semantic_plan 中只能引用 table_context、semantic_catalog 或 resolved_sql_resultsets 中真实存在的表、字段、指标和规则。",
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
            summary: item.summary,
            content: safePreview(item.content || item.summary || "", 520)
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
        table_context: payload.table_context || [],
        state
      })
    }
  ];
}

function normalizeAgentLoopDecision(data) {
  const decision = data && typeof data === "object" ? { ...data } : {};
  if (decision.action === "generate_sql") decision.action = "plan_ready";
  const allowedActions = new Set(["plan_ready", "lookup_sql_resultset", "answer_direct", "ask_clarification"]);
  if (!allowedActions.has(decision.action)) decision.action = "plan_ready";
  if (!Array.isArray(decision.selected_metric_keys)) decision.selected_metric_keys = [];
  if (!Array.isArray(decision.selected_rule_keys)) decision.selected_rule_keys = [];
  if (!Array.isArray(decision.disabled_mandatory_filter_ids)) decision.disabled_mandatory_filter_ids = [];
  if (!Array.isArray(decision.sql_resultset_lookups)) decision.sql_resultset_lookups = [];
  if (!Array.isArray(decision.sql_plan)) decision.sql_plan = [];
  if (!Array.isArray(decision.display_formats)) decision.display_formats = [];
  if (!decision.semantic_plan || typeof decision.semantic_plan !== "object") decision.semantic_plan = {};
  decision.coverage_checklist = normalizeCoverageChecklist(decision.coverage_checklist || decision.semantic_plan.coverage_checklist || []);
  decision.disabled_mandatory_filter_ids = [
    ...new Set(decision.disabled_mandatory_filter_ids.map(item => String(item || "").trim()).filter(Boolean))
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
  nextPlan.semantic_plan = decision.semantic_plan && typeof decision.semantic_plan === "object"
    ? decision.semantic_plan
    : nextPlan.semantic_plan || {};
  nextPlan.summary = decision.summary || nextPlan.summary || "";
  return nextPlan;
}

function agentLoopDecisionArtifact(decision, plan) {
  return {
    action: decision.action,
    intent: decision.intent,
    selected_metric_keys: decision.selected_metric_keys || [],
    selected_rule_keys: decision.selected_rule_keys || [],
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
    loop_summaries: []
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
    try {
      const loopResult = await callModelJson(buildAgentLoopMessages(payload, state), { temperature: 0.08, maxTokens: 2048 });
      decision = normalizeAgentLoopDecision(loopResult.data);
    } catch (error) {
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
      if (!newLookups.length) continue;
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

async function callModelJson(messages, { temperature = 0.1, maxTokens = 4096 } = {}) {
  if (!config.apiKey) throw new Error("未配置 MOI_TAAS_API_KEY");
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
        "必须使用 semantic_catalog、table_context 或 resolved_sql_resultsets 中出现的真实字段名，不要把 b28_s_kgd353d 改写成 period，不要把 b28_s_kgd4kbn 改写成 currency，不要把 b28_s_kgdp984 改写成 version。",
        "如果 semantic_catalog.business_metric 中已有指标定义，返回 SQL 必须优先使用该指标的 scope_filter/measure/result_factor，不要自己改成中文 LIKE。",
        "payload.retrieval_plan 是前一步模型给出的检索计划；payload.resolved_sql_resultsets 是后端按该计划读取 SQL结果集并宽松召回得到的真实目录候选行，不是最终业务数据。",
        "生成 SQL 前必须核对 payload.retrieval_plan.coverage_checklist；用户要求的每个对象都必须由 business_metric、logic_text、table_column_note、standard_qa、table_context 或 resolved_sql_resultsets 覆盖。",
        "如果 coverage_checklist 里仍有 needs_lookup、unsupported 或 ambiguous 的对象，不能只返回已覆盖对象的局部结果；必须在 warnings 说明缺口，或基于 resolved_sql_resultsets 中的证据补齐。",
        "如果 resolved_sql_resultsets 的 row_count=0，表示目录未召回可靠候选；不要说“前30条没有”，不要把目录未命中描述成业务数据不存在。",
        "只有当用户提到的项目不在 business_metric 里，但在 resolved_sql_resultsets 中出现时，才把它当作普通目录项处理。",
        "resolved_sql_resultsets 每项会给出 code_columns/name_columns/searchable_columns；需要编码时优先读取 code_columns 对应字段，不要假设一定叫“科目编码”；需要名称时优先读取 name_columns 对应字段，不要假设一定叫“科目名称”。",
        "普通科目处理方式：使用返回行中的编码字段生成 account_path LIKE '%/编码/%'；如果返回行有备注且备注为需要置反，则对该项用 -SUM 或 CASE 中负向计算，备注为不需要置反则正常 SUM。",
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

function normalizeModelData(data, payload) {
  const normalized = { ...data };
  const modelSql = normalized.sql || "";
  const usableSql = looksLikeExecutableSelectSql(modelSql)
    ? normalizeSql(modelSql)
    : "";
  if (!normalized.answer) {
    normalized.answer = usableSql
      ? "我已经根据当前语义生成了查询 SQL。由于当前未接入真实数据执行结果，需要执行该 SQL 后才能得到最终数值。"
      : "当前证据不足，无法给出可靠回答。";
  }
  if (!normalized.answer_type) {
    normalized.answer_type = usableSql ? "sql_needed" : "no_evidence";
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
  normalized.sql = usableSql;
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
    display_formats: [{ column: "SQL result column name", metric_key: "string or null", format: "number | percent", display_scale: 1, suffix: "string", precision: 2, reason: "string" }],
    sql: "single read-only SELECT SQL",
    warnings: ["string"]
  };
  return [
    {
      role: "system",
      content: [
        "你是一个生产级 NL2SQL 生成器，负责把中文问数问题转换为安全、可执行、可解释的 SQL。",
        "你的输出会被后端校验并真实执行，所以必须严格、保守、可追溯。",
        "优先使用 payload.semantic_catalog 中的指标和规则；语义不足时，可以使用 payload.table_context 中真实出现的表结构和样例数据探索字段。",
        "不要把 NL2SQL 限定成业务指标查询。用户可以询问当前表的业务指标、结构、样例、分布、聚合、明细和口径解释等合理问题。",
        "如果 retrieval_plan.intent=table_profile、table_analysis、dimension_summary 或 detail_query，且没有命中 business_metric，也可以只基于 table_context 中的真实表字段生成 SQL；不要因为没有业务指标就返回澄清。",
        "如果问题是表级探索或结构解释，应根据真实表结构选择直接回答或生成合适的只读 SQL，不要套固定指标流程。",
        "只允许使用 payload.semantic_catalog、payload.table_context 或 resolved_sql_resultsets 中真实出现的表、字段、指标和规则；不要编造字段、表、科目编码或指标口径。",
        "payload.qa_config 是用户在页面上选择的问数配置，必须视为显式过滤/口径要求：table_scope 表示本轮允许使用的数据表范围，data_path 表示管口/法口，transaction_scope 表示是否排除内部关联交易。",
        "payload.retrieval_plan 是上一阶段已经校验过的 semantic plan。你必须优先落实其中的 intent、selected_metric_keys、semantic_plan.time、dimensions、calculations、filters 和 output。",
        "payload.mandatory_context 是后端识别出的硬约束。mandatory_context.sql_filters 必须进入 SQL；mandatory_context.rule_keys 必须视为已采用规则。",
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
        "如果是月度 APL/CF 类累计科目，按规则用当月累计值减上月累计值；1月直接取当月累计值。",
        "如果是派生指标，先展开依赖指标，能写 SQL 才写；证据不足则返回 clarification_needed 或 no_evidence。",
        "SQL 只能是单条只读 SELECT；不要写 INSERT/UPDATE/DELETE/CREATE/DROP/SET/USE 等语句。",
        "全限定表名必须写成 `schema`.`table` 或直接写当前库内表名；不要写成 `schema.table`、\"schema.table\" 或 `schema.table` 这种整体加引号的形式。",
        "不要输出中文字段名作为过滤条件；过滤条件必须使用真实字段名。",
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
        data_source: payload.data_source || "bpc_consolidated_report",
        semantic_catalog: payload.semantic_catalog || {},
        table_context: payload.table_context || [],
        retrieval_plan: payload.retrieval_plan || {},
        mandatory_context: payload.mandatory_context || {},
        resolved_sql_resultsets: payload.resolved_sql_resultsets || []
      })
    }
  ];
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
        "如果错误是 SELECT statements have different number of columns，说明 UNION/UNION ALL 的各 SELECT 列数不一致；优先改成单个 SELECT 中的多个标量子查询或多个聚合列，或者保证 UNION 每段列数、列序和类型一致。",
        "如果错误是 table \"schema.table\" does not exist，优先检查是否把全限定表名整体加了引号；正确写法是 `schema`.`table`，或在当前数据库下直接写 `table`。",
        "多个来源表没有天然同一粒度时，不要硬 UNION 明细；优先用一个 SELECT 返回多个独立指标列。",
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

function displayFormatsFromResultPresentation(payload, columns = []) {
  const rules = resultPresentationRules(payload);
  if (!rules.length || !columns.length) return [];
  const formats = [];
  for (const rule of rules) {
    const text = presentationRuleText(rule);
    if (!text) continue;
    const requiresPercent = /百分数|百分比|百分号|按\s*%|显示\s*%|%|percent/i.test(text);
    const requiresGrouping = /千分位|三位|3\s*位|逗号|千位|thousand|comma/i.test(text);
    const requiresTwoDecimals = /两位小数|2\s*位小数|保留\s*2\s*位|precision\s*[:=]\s*2|\.00/.test(text);
    if (!requiresPercent && !requiresGrouping) continue;
    for (const column of columns) {
      const name = String(column || "");
      if (requiresPercent && /(率|比例|占比|比率|margin|ratio|rate|roe|roa)/i.test(name)) {
        formats.push({
          column: name,
          metric_key: null,
          format: "percent",
          display_scale: 100,
          scale: 100,
          suffix: "%",
          precision: 2,
          source: `result_presentation:${rule.key || rule.name || ""}`
        });
        continue;
      }
      if (requiresGrouping && /(金额|合计|余额|收入|成本|费用|利润|税额|价|值|数量|重量|总额|净额|amount|amt|money|balance|revenue|cost|profit|price|value|qty|quantity|wsl|tsl|dmbtr|wrbtr|menge)/i.test(name)) {
        formats.push({
          column: name,
          metric_key: null,
          format: "number",
          display_scale: 1,
          scale: 1,
          suffix: "",
          precision: requiresTwoDecimals ? 2 : null,
          thousand_separator: true,
          source: `result_presentation:${rule.key || rule.name || ""}`
        });
      }
    }
  }
  return formats;
}

function resultPresentationRequiresInsight(payload) {
  return resultPresentationRules(payload).some(rule => {
    const text = presentationRuleText(rule);
    return /总结|分析|见解|判断|说明|洞察|整体来看|从结果看|不要.*机械|不要.*只.*答|insight|analysis/i.test(text);
  });
}

function resultPresentationRequiresFormula(payload) {
  return resultPresentationRules(payload).some(rule => {
    const text = presentationRuleText(rule);
    return /计算公式|指标公式|公式|计算口径|怎么算|如何计算/i.test(text);
  });
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
  if (!resultPresentationRequiresFormula(payload)) return [];
  const metrics = metricCatalogMap(payload);
  return selectedMetricKeysForAnswer(payload, generated)
    .map(key => {
      const metric = metrics.get(key);
      if (!metric || metricKind(metric) !== "derived") return "";
      const formula = humanMetricFormula(metric, metrics);
      if (!formula) return "";
      return `${metricDisplayName(metric, key)}=${formula}`;
    })
    .filter(Boolean);
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

function buildFinalAnswerMessages({ payload, generated, validation, execution }) {
  const displayFormats = rendererDisplayFormats(payload, generated, execution?.columns || []);
  const displayRows = formatExecutionRowsForDisplay(execution, displayFormats).slice(0, 80);
  const resultSummary = buildExecutionResultSummary(execution, displayFormats);
  const periodContext = resultPeriodContext(execution);
  const formulaNotes = selectedDerivedMetricFormulaNotes(payload, generated);
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
    warnings: ["string"]
  };
  return [
    {
      role: "system",
      content: [
        "你是问数结果解释助手。现在 SQL 已经执行，你要根据执行结果回答用户。",
        "只能根据 result.rows 中的数据回答，不要补造数据。",
        "如果 display_formats 指定了某列的展示口径，例如 percent、suffix、precision，回答必须使用该展示口径，不要改回数据库原始小数。",
        "result_presentation 是最终回答/展示要求，必须遵守；例如要求百分数、单位、总结、图表或原始项展示时，回答要按这些要求组织。",
        "如果 result_presentation 要求展示计算公式，并且 selected_metric_formulas 非空，回答中必须简短写出这些公式。",
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
        qa_config: payload.qa_config || null,
        mandatory_context: payload.mandatory_context || {},
        sql: validation.sql,
        decision: generated.decision,
        sql_plan: generated.sql_plan,
        result: {
          executed: execution.executed,
          row_count: execution.row_count,
          columns: execution.columns,
          rows: displayRows
        },
        display_formats: displayFormats,
        result_presentation: presentationRequirements,
        selected_metric_formulas: formulaNotes,
        result_period_context: periodContext,
        result_summary: resultSummary
      })
    }
  ];
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
  if (!Array.isArray(normalized.warnings)) normalized.warnings = [];
  return normalized;
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
    sql_resultset_lookup: "补查目录",
    retrieval_planning: "规划检索",
    semantic_plan: "校验语义计划",
    metric_expansion: "展开指标口径",
    sql_generation: "生成 SQL",
    mandatory_sql_enforcement: "落实固定口径",
    sql_validation: "校验 SQL",
    sql_execution: "执行查询",
    sql_repair: "自动修复 SQL",
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
  const fallbackCodeColumns = ["总账科目编码", "科目编码", "account_code", "code", "racct", "saknr", "hkont", "cpmb_kgd4b76"];
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

function sqlAliasSummary(sql) {
  const value = String(sql || "");
  const backtickAliases = [...value.matchAll(/\bAS\s+`([^`]+)`/gi)].map(match => match[1].trim());
  const plainAliases = [...value.matchAll(/\bAS\s+([\u4e00-\u9fa5][\u4e00-\u9fa5A-Za-z0-9_（）() -]*?)(?=\s+(?:FROM|WHERE|GROUP|ORDER|HAVING|LIMIT|UNION)\b|,|$)/gi)]
    .map(match => match[1].trim());
  return [...new Set([...backtickAliases, ...plainAliases])]
    .filter(Boolean);
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

function isBpcPayload(payload) {
  return catalogTables(payload).includes("bpc_consolidated_report");
}

function semanticEntries(payload, type) {
  const entries = semanticCatalog(payload)[type];
  return Array.isArray(entries) ? entries : [];
}

function semanticEntrySearchText(entry) {
  const spec = entry?.spec && typeof entry.spec === "object" ? entry.spec : {};
  return [
    entry?.key,
    entry?.key_name,
    entry?.name,
    entry?.summary,
    entry?.content,
    entry?.description,
    spec.content,
    spec.summary,
    spec.description,
    spec.rule,
    spec.requirement
  ].filter(Boolean).join("\n");
}

function findRuleKeys(payload, patterns) {
  const rules = semanticEntries(payload, "logic_text");
  const keys = [];
  patterns.forEach(pattern => {
    const rule = rules.find(entry => pattern.test(semanticEntrySearchText(entry)));
    if (rule?.key) keys.push(rule.key);
  });
  return [...new Set(keys)];
}

function bpcMandatoryRuleKeys(payload) {
  if (!isBpcPayload(payload)) return [];
  return findRuleKeys(payload, [
    /BPC基础过滤与输出/,
    /通过科目计算.*输出科目值|输出科目值.*指标值|原始科目|仅仅是指标值/
  ]);
}

function bpcRuleRequestsMetricComponentOutput(payload, generated, mandatoryContext) {
  if (!isBpcPayload(payload)) return false;
  const ruleKeys = new Set([
    ...(mandatoryContext?.rule_keys || []),
    ...(generated?.decision?.selected_rule_keys || [])
  ].filter(Boolean).map(String));
  if (!ruleKeys.size) return false;
  return semanticEntries(payload, "logic_text")
    .filter(entry => ruleKeys.has(String(entry?.key || entry?.name || "")))
    .some(entry => /通过科目计算.*输出科目值|输出科目值.*指标值|原始科目|仅仅是指标值/.test(semanticEntryContextText(entry)));
}

function expandSelectedMetricKeysByComponentOutputRule(payload, generated, mandatoryContext, metrics, selectedKeys) {
  const result = [...new Set((selectedKeys || []).filter(Boolean))];
  if (!bpcRuleRequestsMetricComponentOutput(payload, generated, mandatoryContext)) return result;
  const addDependencies = (key, stack = []) => {
    if (!key || stack.includes(key)) return;
    const metric = metrics.get(key);
    if (!metric) return;
    metricDependencySpecs(metric).forEach(dep => {
      if (!dep?.metricKey || !metrics.has(dep.metricKey)) return;
      if (!result.includes(dep.metricKey)) result.push(dep.metricKey);
      addDependencies(dep.metricKey, [...stack, key]);
    });
  };
  result.forEach(key => {
    const metric = metrics.get(key);
    if (metricKind(metric) === "derived" || metricDependencySpecs(metric).length) {
      addDependencies(key);
    }
  });
  return result;
}

function bpcMandatoryFilters(payload, plan = null) {
  if (!isBpcPayload(payload)) return { filters: [], warnings: [] };
  const dataPath = payload.qa_config?.data_path?.value || "legal";
  const transactionScope = payload.qa_config?.transaction_scope?.value || "all";
  const filters = [
    {
      id: "bpc_version_f99",
      field: "b28_s_kgdp984",
      value: "F99",
      sql: "b28_s_kgdp984 = 'F99'",
      source: "BPC基础过滤与输出",
      reason: "固定取期末余额口径"
    },
    {
      id: "bpc_currency_cny",
      field: "b28_s_kgd4kbn",
      value: "CNY",
      sql: "b28_s_kgd4kbn = 'CNY'",
      source: "BPC基础过滤与输出",
      reason: "固定人民币口径"
    }
  ];
  const warnings = [];
  filters.push({
    id: "bpc_audit_exclusion",
    field: "b28_s_kgdc8w9",
    sql: "NOT (\n  b28_s_kgdc8w9 LIKE 'E%'\n  OR b28_s_kgdc8w9 LIKE 'F%'\n)",
    source: "BPC基础过滤与输出",
    reason: "普通查询默认排除 E/F 审计口径"
  });
  if (dataPath === "legal") {
    filters.push(
      {
        id: "bpc_legal_actual",
        field: "b28_s_kgdtvnx",
        value: "ACT_LG",
        sql: "b28_s_kgdtvnx = 'ACT_LG'",
        source: "问数配置：法口数据",
        reason: "法定公司代码口径"
      },
      {
        id: "bpc_legal_entity",
        field: "b28_s_kgd4rtr_kgdxoi5",
        value: "EO_1000",
        sql: "b28_s_kgd4rtr_kgdxoi5 = 'EO_1000'",
        source: "问数配置：法口数据",
        reason: "默认法口组织范围"
      }
    );
  } else if (dataPath === "management") {
    filters.push({
      id: "bpc_management_actual",
      field: "b28_s_kgdtvnx",
      value: "ACT_PC",
      sql: "b28_s_kgdtvnx = 'ACT_PC'",
      source: "问数配置：管口数据",
      reason: "管理利润中心口径"
    });
  }
  if (transactionScope === "exclude_internal") {
    warnings.push("已选择“不含内部关联交易数据”，但当前 BPC 语义中没有明确可强制落地的内部关联交易字段规则，本次不会编造过滤条件。");
  }
  const disabled = new Set((plan?.disabled_mandatory_filter_ids || []).filter(Boolean));
  if (!disabled.size) return { filters, warnings };
  const disabledReasons = [];
  const enabledFilters = filters.filter(filter => {
    if (!disabled.has(filter.id)) return true;
    disabledReasons.push(`${filter.reason || filter.id}（${filter.id}）`);
    return false;
  });
  if (disabledReasons.length) {
    warnings.push(`本轮由模型判定不使用默认过滤：${disabledReasons.join("、")}`);
  }
  return { filters: enabledFilters, warnings };
}

function buildMandatoryContext(payload, plan) {
  const ruleKeys = bpcMandatoryRuleKeys(payload);
  const { filters, warnings } = bpcMandatoryFilters(payload, plan);
  return {
    enabled: Boolean(ruleKeys.length || filters.length || warnings.length),
    rule_keys: ruleKeys,
    rule_labels: semanticEntryLabels(payload, "logic_text", ruleKeys, 8),
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

function mandatoryContextArtifact(context) {
  return {
    rule_keys: context?.rule_keys || [],
    rule_labels: context?.rule_labels || "",
    sql_filters: context?.sql_filters || [],
    warnings: context?.warnings || []
  };
}

function enforceMandatoryContextOnGenerated(generated, context) {
  const filters = context?.sql_filters || [];
  if (!filters.length || !generated?.sql) {
    return { sql: generated?.sql || "", applied: [], replaced: [], skipped: [], warnings: context?.warnings || [] };
  }
  const enforcement = appendWhereConditions(generated.sql, filters, { targetTables: ["bpc_consolidated_report"] });
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
      return Boolean(metricSourceTable(metric) && metricMeasure(metric).field && metricScopeExpression(metric));
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
    field: measure.field || "b28_s_sdata",
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

function previousBpcPeriod(period) {
  const match = String(period || "").match(/^(20\d{2})\.(0[1-9]|1[0-2])$/);
  if (!match) return "";
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month === 1) return `${year - 1}.12`;
  return `${year}.${String(month - 1).padStart(2, "0")}`;
}

function bpcMonthIntentFromQuestion(question) {
  const text = String(question || "");
  const asksCumulativeMonth = /累计\s*(?:至|到)?\s*(0?[1-9]|1[0-2])\s*月|(?:截至|截止|至)\s*(0?[1-9]|1[0-2])\s*月|1\s*[-至到~～]\s*(0?[1-9]|1[0-2])\s*月/.test(text);
  const asksOccurrenceMonth = !asksCumulativeMonth && /(本月发生额|当月发生额|月度发生额|单月发生额|本月|当月|单月|月发生额)/.test(text);
  return { asksCumulativeMonth, asksOccurrenceMonth };
}

function bpcPeriodResult(period, rawHasMonth, question) {
  const intent = bpcMonthIntentFromQuestion(question);
  return {
    period,
    previous: previousBpcPeriod(period),
    asksMonth: Boolean(rawHasMonth && intent.asksOccurrenceMonth),
    asksCalendarMonth: Boolean(rawHasMonth),
    asksCumulativeMonth: Boolean(rawHasMonth && intent.asksCumulativeMonth),
    asksOccurrenceMonth: Boolean(rawHasMonth && intent.asksOccurrenceMonth),
    month: period.split(".")[1] || ""
  };
}

function bpcPeriodInfo(payload, generatedSql = "") {
  const signals = payload?.signals || {};
  if (signals.period) {
    const period = String(signals.period);
    const result = bpcPeriodResult(period, Boolean(signals.asksMonth), payload?.question || "");
    return {
      ...result,
      asksMonth: Boolean(signals.asksMonth && result.asksOccurrenceMonth)
    };
  }
  const question = String(payload?.question || "");
  let match = question.match(/(20\d{2})\s*年\s*(?:累计(?:至|到)?|截至|截止|至|1\s*[-至到~～]\s*)\s*(0?[1-9]|1[0-2])\s*月/);
  if (match) {
    const month = String(match[2]).padStart(2, "0");
    return bpcPeriodResult(`${match[1]}.${month}`, true, question);
  }
  match = question.match(/(20\d{2})\s*年\s*(?:(0?[1-9]|1[0-2])\s*月)?/);
  if (match) {
    const month = match[2] ? String(match[2]).padStart(2, "0") : "12";
    const period = `${match[1]}.${month}`;
    return bpcPeriodResult(period, Boolean(match[2]), question);
  }
  match = question.match(/\b(20\d{2})[.-](0?[1-9]|1[0-2])\b/);
  if (match) {
    const month = String(match[2]).padStart(2, "0");
    const period = `${match[1]}.${month}`;
    return bpcPeriodResult(period, true, question);
  }
  match = String(generatedSql || "").match(/\b(20\d{2})\.(0[1-9]|1[0-2])\b/);
  if (match) {
    const period = `${match[1]}.${match[2]}`;
    return bpcPeriodResult(period, false, question);
  }
  return {
    period: "",
    previous: "",
    asksMonth: false,
    asksCalendarMonth: false,
    asksCumulativeMonth: false,
    asksOccurrenceMonth: false,
    month: ""
  };
}

function bpcMetricLooksCumulative(metric) {
  return /account_path\s+LIKE\s+'%\/(?:APL|CF)/i.test(metricScopeExpression(metric));
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

function bpcPeriodParts(period) {
  const match = String(period || "").match(/^(20\d{2})\.(0[1-9]|1[0-2])$/);
  if (!match) return null;
  return { year: Number(match[1]), month: match[2] };
}

function previousYearSameBpcPeriod(period) {
  const parts = bpcPeriodParts(period);
  if (!parts) return "";
  return `${parts.year - 1}.${parts.month}`;
}

function previousYearEndBpcPeriod(period) {
  const parts = bpcPeriodParts(period);
  if (!parts) return "";
  return `${parts.year - 1}.12`;
}

function bpcRolePeriods(period, role, metric) {
  const current = period.period;
  const roleName = String(role || "current_period");
  if (!current) return [];
  if (roleName === "average_begin_end") {
    return [previousYearEndBpcPeriod(current), current].filter(Boolean);
  }
  const target = roleName === "previous_period"
    ? previousBpcPeriod(current)
    : roleName === "previous_year_same_period"
      ? previousYearSameBpcPeriod(current)
      : roleName === "previous_year_end"
        ? previousYearEndBpcPeriod(current)
        : current;
  if (!target) return [];
  if (period.asksMonth && bpcMetricLooksCumulative(metric) && roleName !== "average_begin_end") {
    const previous = previousBpcPeriod(target);
    return [target, previous].filter(Boolean);
  }
  return [target];
}

function bpcAggregateForPeriod(metric, targetPeriod) {
  const scope = metricScopeExpression(metric);
  if (!scope) return null;
  const { field, aggregation } = metricMeasure(metric);
  if (aggregation !== "SUM") return null;
  return `${aggregation}(CASE WHEN b28_s_kgd353d = '${targetPeriod}' AND (${scope}) THEN ${field} ELSE 0 END)`;
}

function bpcBaseRequirementExpression(metric, period, role) {
  const { resultFactor } = metricMeasure(metric);
  const applyFactor = expression => resultFactor === 1 ? expression : `${resultFactor} * (${expression})`;
  const periods = bpcRolePeriods(period, role, metric);
  if (!periods.length) return null;
  if (String(role || "") === "average_begin_end") {
    const expressions = periods.map(item => bpcAggregateForPeriod(metric, item));
    if (expressions.some(item => !item)) return null;
    return `(${expressions.map(applyFactor).join(" + ")}) / 2`;
  }
  const currentExpr = bpcAggregateForPeriod(metric, periods[0]);
  if (!currentExpr) return null;
  if (periods.length > 1) {
    const previousExpr = bpcAggregateForPeriod(metric, periods[1]);
    if (!previousExpr) return null;
    return applyFactor(`(${currentExpr} - ${previousExpr})`);
  }
  return applyFactor(currentExpr);
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

function bpcPeriodsFromSql(sql) {
  const periods = new Set();
  const re = /'((?:20\d{2})\.(?:0[1-9]|1[0-2]))'/g;
  let match;
  while ((match = re.exec(String(sql || "")))) periods.add(match[1]);
  return [...periods].sort();
}

function metricLabelForQuestion(metric, question) {
  const text = String(question || "");
  const aliases = [metric?.name, ...(metric?.aliases || [])].filter(Boolean);
  const matched = aliases.find(alias => alias && text.includes(alias));
  return matched || metric?.name || metric?.key || "指标";
}

function wantsYearOverYear(payload, generated) {
  return /同比|增长率|增长额|上年同期/i.test([
    payload?.question,
    generated?.answer,
    generated?.decision?.reason,
    ...(generated?.sql_plan || []).map(item => `${item.value || ""} ${item.note || ""}`)
  ].filter(Boolean).join("\n"));
}

function bpcRequestedPeriods(payload, generatedSql = "") {
  const question = String(payload?.question || "");
  const periods = new Set();
  const addPeriod = (year, month = "12") => {
    if (!/^20\d{2}$/.test(String(year || ""))) return;
    const normalizedMonth = String(month || "12").padStart(2, "0");
    if (!/^(0[1-9]|1[0-2])$/.test(normalizedMonth)) return;
    periods.add(`${year}.${normalizedMonth}`);
  };

  const collectFromText = value => {
    const text = String(value || "");
    if (!text) return;
    let match;
    const rangeRe = /(20\d{2})\s*年?\s*(?:至|到|~|～|-|—)\s*(20\d{2})\s*年?/g;
    while ((match = rangeRe.exec(text))) {
      const start = Number(match[1]);
      const end = Number(match[2]);
      const step = start <= end ? 1 : -1;
      for (let year = start; step > 0 ? year <= end : year >= end; year += step) {
        addPeriod(String(year), "12");
      }
    }

    const cumulativeYearMonthRe = /(20\d{2})\s*年\s*(?:累计(?:至|到)?|截至|截止|至|1\s*[-至到~～]\s*)\s*(0?[1-9]|1[0-2])\s*月/g;
    while ((match = cumulativeYearMonthRe.exec(text))) addPeriod(match[1], match[2]);

    const yearMonthRe = /(20\d{2})\s*年\s*(0?[1-9]|1[0-2])\s*月/g;
    while ((match = yearMonthRe.exec(text))) addPeriod(match[1], match[2]);

    const dottedPeriodRe = /(^|[^\d])((?:20)\d{2})[.-](0?[1-9]|1[0-2])(?!\d)/g;
    while ((match = dottedPeriodRe.exec(text))) addPeriod(match[2], match[3]);

    const yearOnlyRe = /(20\d{2})\s*年/g;
    while ((match = yearOnlyRe.exec(text))) {
      const after = text.slice(match.index + match[0].length, match.index + match[0].length + 18);
      if (/^\s*(?:累计(?:至|到)?|截至|截止|至|1\s*[-至到~～]\s*)?\s*(0?[1-9]|1[0-2])\s*月/.test(after)) continue;
      addPeriod(match[1], "12");
    }

    const standaloneYears = [...text.matchAll(/(^|[^\d])((?:20)\d{2})(?!\d)/g)]
      .filter(item => {
        const yearStart = item.index + String(item[1] || "").length;
        const after = text.slice(yearStart + 4, yearStart + 22);
        return !/^年?\s*(?:累计(?:至|到)?|截至|截止|至|1\s*[-至到~～]\s*)?\s*(0?[1-9]|1[0-2])\s*月/.test(after);
      })
      .map(item => item[2]);
    if (standaloneYears.length > 1 || /年|期间|趋势|同比|增长|对比|各年|每年/.test(text)) {
      standaloneYears.forEach(year => addPeriod(year, "12"));
    }
  };

  const collectFromValue = value => {
    if (value == null) return;
    if (typeof value === "string" || typeof value === "number") {
      collectFromText(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(collectFromValue);
      return;
    }
    if (typeof value === "object") {
      [
        value.period,
        value.periods,
        value.year,
        value.years,
        value.month,
        value.months,
        value.start,
        value.end,
        value.from,
        value.to,
        value.range,
        value.value,
        value.text,
        value.raw
      ].forEach(collectFromValue);
      if (value.start_year && value.end_year) {
        const start = Number(value.start_year);
        const end = Number(value.end_year);
        const step = start <= end ? 1 : -1;
        for (let year = start; step > 0 ? year <= end : year >= end; year += step) {
          addPeriod(String(year), value.month || value.end_month || "12");
        }
      }
    }
  };

  collectFromValue(payload?.retrieval_plan?.semantic_plan?.time);
  collectFromValue(payload?.retrieval_plan?.semantic_plan?.periods);
  collectFromValue(payload?.retrieval_plan?.time);
  collectFromText(question);

  bpcPeriodsFromSql(generatedSql).forEach(period => periods.add(period));

  if (/同比|上年同期/.test(question) && periods.size === 1) {
    const [period] = [...periods];
    const previous = previousYearSameBpcPeriod(period);
    if (previous) periods.add(previous);
  }

  if (!periods.size) {
    const single = bpcPeriodInfo(payload, generatedSql);
    if (single.period) periods.add(single.period);
  }

  return [...periods].sort();
}

function explicitRequestedPeriods(payload) {
  return bpcRequestedPeriods(payload, "");
}

function semanticPlanRequestsMultiPeriod(payload) {
  const plan = payload?.retrieval_plan || {};
  const semanticPlan = plan.semantic_plan || {};
  const calculations = Array.isArray(semanticPlan.calculations) ? semanticPlan.calculations : [];
  const output = Array.isArray(semanticPlan.output) ? semanticPlan.output : [];
  const text = [
    payload?.question,
    plan.intent,
    plan.summary,
    ...calculations,
    ...output
  ].filter(Boolean).join("\n");
  return explicitRequestedPeriods(payload).length > 1
    || plan.intent === "trend_analysis"
    || calculations.some(item => /yoy|同比|增长|趋势|变化|对比/i.test(String(item || "")))
    || /每年|各年|逐年|趋势|同比|增长|变化|对比/.test(text);
}

function wantsMultiPeriodAnalysis(payload, generated) {
  const text = [
    payload?.question,
    generated?.answer,
    generated?.decision?.reason,
    ...(generated?.sql_plan || []).map(item => `${item.value || ""} ${item.note || ""}`)
  ].filter(Boolean).join("\n");
  return semanticPlanRequestsMultiPeriod(payload)
    || /每年|各年|逐年|期间|趋势|同比|增长|变化|对比/.test(text);
}

function uniqueMetricAlias(name, usedAliases) {
  const base = String(name || "指标").trim() || "指标";
  let alias = base;
  let suffix = 2;
  while (usedAliases.has(alias)) {
    alias = `${base}${suffix}`;
    suffix += 1;
  }
  usedAliases.add(alias);
  return alias;
}

function buildDeterministicMultiPeriodMetricSql(payload, generated, mandatoryContext, metrics, selectedKeys, resolvedAccountItems) {
  if (!isBpcPayload(payload) || !wantsMultiPeriodAnalysis(payload, generated)) return null;
  const periods = bpcRequestedPeriods(payload, generated?.sql || "");
  if (periods.length < 2) return null;
  const selectedMetrics = selectedKeys.map(key => metrics.get(key)).filter(Boolean);
  if (selectedKeys.length && selectedMetrics.length !== selectedKeys.length) return null;
  if (selectedMetrics.some(metric => metricKind(metric) !== "derived" && metricSourceTable(metric) !== "bpc_consolidated_report")) return null;

  const warnings = [];
  const baseKeys = new Set();
  const usedAliases = new Set(["期间"]);
  const metricAliases = selectedKeys.map(key => {
    const metric = metrics.get(key);
    const alias = uniqueMetricAlias(metricLabelForQuestion(metric, payload?.question), usedAliases);
    return { key, metric, alias };
  });
  const resolvedAliases = resolvedAccountItems.map(item => ({
    item,
    alias: uniqueMetricAlias(item.item, usedAliases)
  }));
  if (!metricAliases.length && !resolvedAliases.length) return null;

  const displayFormats = [];
  metricAliases.forEach(({ key, metric, alias }) => {
    const presentation = metricPresentation(metric, alias, generated?.display_formats || []);
    const displayFormat = metricDisplayFormat(metric, alias, presentation);
    if (displayFormat) displayFormats.push({ ...displayFormat, metric_key: key });
  });

  const mandatoryFilters = (mandatoryContext?.sql_filters || [])
    .map(item => item.sql)
    .filter(Boolean);

  const valueAliases = [...metricAliases.map(item => item.alias), ...resolvedAliases.map(item => item.alias)];
  const questionText = String(payload?.question || "");
  const includeGrowth = /同比|增长|趋势|变化|对比/.test(questionText);
  const growthSuffix = /同比/.test(questionText) ? "同比增长率" : "增长率";
  const growthAliases = includeGrowth
    ? valueAliases.map(alias => `${alias}${growthSuffix}`)
    : [];
  growthAliases.forEach(alias => {
    displayFormats.push({
      column: alias,
      metric_key: null,
      format: "percent",
      precision: 2,
      suffix: "%",
      scale: 100,
      display_scale: 100,
      scale_applied: false,
      source: "multi_period_metric_expansion"
    });
  });

  const groupedMetricExpressions = metricAliases.map(({ key, metric, alias }) => {
    if (metricKind(metric) === "derived") return null;
    if (metricSourceTable(metric) !== "bpc_consolidated_report") return null;
    const condition = bpcSimpleMetricCondition(metric);
    const expression = bpcSimpleAggregateExpression(condition, metricMeasure(metric), alias);
    if (expression) baseKeys.add(key);
    return expression;
  });
  const groupedResolvedExpressions = resolvedAliases.map(({ item, alias }) => {
    const expression = bpcResolvedAccountGroupedExpression(item, alias);
    if (expression) baseKeys.add(item.item);
    return expression;
  });
  const canUseGroupedScan = groupedMetricExpressions.every(Boolean) && groupedResolvedExpressions.every(Boolean);
  if (canUseGroupedScan) {
    const whereLines = uniqueSqlConditions([
      `b28_s_kgd353d IN (${periods.map(sqlLiteral).join(", ")})`,
      ...mandatoryFilters
    ]);
    const innerSql = [
      "SELECT",
      [
        "  b28_s_kgd353d AS `期间`",
        ...groupedMetricExpressions,
        ...groupedResolvedExpressions
      ].join(",\n"),
      `FROM ${quotedTableName("bpc_consolidated_report")}`,
      "WHERE",
      whereLines.map(formatWhereConditionLine).join("\n"),
      "GROUP BY b28_s_kgd353d"
    ].join("\n");

    const outerSelectLines = [
      "  `期间`",
      ...valueAliases.map(alias => `  \`${alias}\``)
    ];
    if (includeGrowth) {
      valueAliases.forEach(alias => {
        outerSelectLines.push([
          "  CASE",
          `    WHEN LAG(\`${alias}\`) OVER (ORDER BY \`期间\`) IS NULL OR LAG(\`${alias}\`) OVER (ORDER BY \`期间\`) = 0 THEN NULL`,
          `    ELSE (\`${alias}\` - LAG(\`${alias}\`) OVER (ORDER BY \`期间\`)) / LAG(\`${alias}\`) OVER (ORDER BY \`期间\`)`,
          `  END AS \`${alias}${growthSuffix}\``
        ].join("\n"));
      });
    }

    const sql = includeGrowth
      ? [
          "WITH period_metrics AS (",
          innerSql.split("\n").map(line => `  ${line}`).join("\n"),
          ")",
          "SELECT",
          outerSelectLines.join(",\n"),
          "FROM period_metrics",
          "ORDER BY `期间`"
        ].join("\n")
      : [
          innerSql,
          "ORDER BY `期间`"
        ].join("\n");

    return {
      sql,
      selectedKeys,
      baseKeys: [...baseKeys],
      periods,
      displayFormats,
      includeGrowth,
      warnings
    };
  }

  const resolveMetricExpressionForPeriod = (key, periodInfo, periodValues, dep = {}, stack = []) => {
    const metric = metrics.get(key);
    if (!metric || stack.includes(key)) return null;
    if (metricKind(metric) !== "derived") {
      const role = dep.periodRole || dep.period_role || "current_period";
      bpcRolePeriods(periodInfo, role, metric).forEach(item => periodValues.add(item));
      baseKeys.add(key);
      return bpcBaseRequirementExpression(metric, periodInfo, role);
    }
    const deps = metricDependencySpecs(metric);
    if (!deps.length) return null;
    const replacements = new Map();
    for (const child of deps) {
      const childExpression = resolveMetricExpressionForPeriod(child.metricKey, periodInfo, periodValues, child, [...stack, key]);
      if (!childExpression) return null;
      replacements.set(child.variable || child.metricKey, `(${childExpression})`);
      replacements.set(child.metricKey, `(${childExpression})`);
    }
    const formula = metricExpression(metric);
    const expression = replaceMetricTokens(formula, replacements);
    if (!expression || unresolvedMetricFormulaTokens(formula, replacements).length) return null;
    baseKeys.add(key);
    return expression;
  };

  const periodQueries = periods.map(periodValue => {
    const periodInfo = {
      period: periodValue,
      previous: previousBpcPeriod(periodValue),
      asksMonth: false,
      month: periodValue.split(".")[1] || "12"
    };
    const periodValues = new Set([periodValue]);
    const selectLines = [`  ${sqlLiteral(periodValue)} AS \`期间\``];
    for (const { key, alias } of metricAliases) {
      const expression = resolveMetricExpressionForPeriod(key, periodInfo, periodValues, { variable: key, periodRole: "current_period" });
      if (!expression) return null;
      selectLines.push(`  ${expression} AS \`${alias}\``);
    }
    for (const { item, alias } of resolvedAliases) {
      const expression = bpcResolvedAccountExpression(item, periodInfo);
      if (!expression) return null;
      periodValues.add(periodValue);
      baseKeys.add(item.item);
      selectLines.push(`  ${expression} AS \`${alias}\``);
    }
    const whereLines = uniqueSqlConditions([
      `b28_s_kgd353d IN (${[...periodValues].filter(Boolean).sort().map(sqlLiteral).join(", ")})`,
      ...mandatoryFilters
    ]);
    return [
      "SELECT",
      selectLines.join(",\n"),
      `FROM ${quotedTableName("bpc_consolidated_report")}`,
      "WHERE",
      whereLines.map(formatWhereConditionLine).join("\n")
    ].join("\n");
  });

  if (periodQueries.some(item => !item)) return null;
  const outerSelectLines = [
    "  `期间`",
    ...valueAliases.map(alias => `  \`${alias}\``)
  ];
  if (includeGrowth) {
    valueAliases
      .forEach(alias => {
        outerSelectLines.push([
          "  CASE",
          `    WHEN LAG(\`${alias}\`) OVER (ORDER BY \`期间\`) IS NULL OR LAG(\`${alias}\`) OVER (ORDER BY \`期间\`) = 0 THEN NULL`,
          `    ELSE (\`${alias}\` - LAG(\`${alias}\`) OVER (ORDER BY \`期间\`)) / LAG(\`${alias}\`) OVER (ORDER BY \`期间\`)`,
          `  END AS \`${alias}${growthSuffix}\``
        ].join("\n"));
      });
  }

  const sql = [
    "WITH period_metrics AS (",
    periodQueries.map(query => query.split("\n").map(line => `  ${line}`).join("\n")).join("\n  UNION ALL\n"),
    ")",
    "SELECT",
    outerSelectLines.join(",\n"),
    "FROM period_metrics",
    "ORDER BY `期间`"
  ].join("\n");

  return {
    sql,
    selectedKeys,
    baseKeys: [...baseKeys],
    periods,
    displayFormats,
    includeGrowth,
    warnings
  };
}

function multiPeriodReadiness(payload, generated, metrics, selectedKeys, resolvedAccountItems) {
  const periods = bpcRequestedPeriods(payload, generated?.sql || "");
  const selectedMetrics = selectedKeys.map(key => metrics.get(key)).filter(Boolean);
  const reasons = [];
  if (!isBpcPayload(payload)) reasons.push("not_bpc_payload");
  if (!wantsMultiPeriodAnalysis(payload, generated)) reasons.push("not_multi_period_question");
  if (periods.length < 2) reasons.push(`period_count_${periods.length}`);
  if (selectedKeys.length && selectedMetrics.length !== selectedKeys.length) reasons.push("missing_selected_metric");
  const unsupportedMetric = selectedMetrics.find(metric => metricKind(metric) !== "derived" && metricSourceTable(metric) !== "bpc_consolidated_report");
  if (unsupportedMetric) reasons.push(`unsupported_source_table:${unsupportedMetric.key || unsupportedMetric.name || ""}:${metricSourceTable(unsupportedMetric) || "empty"}`);
  if (!selectedKeys.length && !resolvedAccountItems.length) reasons.push("no_metric_or_resolved_account");
  return {
    wants_multi_period: wantsMultiPeriodAnalysis(payload, generated),
    periods,
    selected_keys: selectedKeys,
    selected_metric_kinds: selectedKeys.map(key => {
      const metric = metrics.get(key);
      return {
        key,
        kind: metric ? metricKind(metric) : "missing",
        source_table: metric ? metricSourceTable(metric) : "",
        dependency_count: metric ? metricDependencySpecs(metric).length : 0,
        expression: metric ? metricExpression(metric) : ""
      };
    }),
    resolved_account_count: resolvedAccountItems.length,
    reasons
  };
}

function buildDeterministicAnalyticalMetricSql(payload, generated, mandatoryContext) {
  if (!hasAnalyticalSqlShape(generated?.sql)) return null;
  const selectedKeys = [...new Set([
    generated?.decision?.selected_metric_key,
    ...(generated?.decision?.selected_metric_keys || [])
  ].filter(Boolean))];
  if (selectedKeys.length !== 1) return null;
  const metrics = metricCatalogMap(payload);
  const metric = metrics.get(selectedKeys[0]);
  if (!metric || metricKind(metric) === "derived") return null;
  if (metricSourceTable(metric) !== "bpc_consolidated_report") return null;
  const periods = bpcPeriodsFromSql(generated.sql);
  if (periods.length < 2) return null;
  const { field, aggregation, resultFactor } = metricMeasure(metric);
  if (aggregation !== "SUM" || !field) return null;
  const scope = metricScopeExpression(metric);
  if (!scope) return null;
  const valueColumn = metricLabelForQuestion(metric, payload?.question);
  const includeYoy = wantsYearOverYear(payload, generated);
  const mandatoryFilters = (mandatoryContext?.sql_filters || [])
    .filter(item => !(item?.field && hasFieldReference(scope, item.field)))
    .map(item => item.sql)
    .filter(Boolean);
  const whereConditions = uniqueSqlConditions([
    `b28_s_kgd353d IN (${periods.map(sqlLiteral).join(", ")})`,
    scope,
    ...mandatoryFilters
  ]);
  const factorPrefix = resultFactor === 1 ? "" : `${resultFactor} * `;
  const withSql = [
    "WITH metric_by_year AS (",
    "  SELECT",
    "    SUBSTRING(b28_s_kgd353d, 1, 4) AS `年份`,",
    `    ${factorPrefix}${aggregation}(${field}) AS \`${valueColumn}\``,
    `  FROM ${quotedTableName("bpc_consolidated_report")}`,
    "  WHERE",
    whereConditions.map((line, index) => `    ${index ? "AND " : ""}${line}`).join("\n"),
    "  GROUP BY SUBSTRING(b28_s_kgd353d, 1, 4)",
    ")"
  ].join("\n");
  const selectLines = [
    "SELECT",
    "  `年份`,",
    `  \`${valueColumn}\``
  ];
  const displayFormats = [];
  if (includeYoy) {
    selectLines.push(
      "  ,CASE",
      `    WHEN LAG(\`${valueColumn}\`) OVER (ORDER BY \`年份\`) IS NULL OR LAG(\`${valueColumn}\`) OVER (ORDER BY \`年份\`) = 0 THEN NULL`,
      `    ELSE (\`${valueColumn}\` - LAG(\`${valueColumn}\`) OVER (ORDER BY \`年份\`)) / LAG(\`${valueColumn}\`) OVER (ORDER BY \`年份\`)`,
      "  END AS `同比增长率`"
    );
    displayFormats.push({
      column: "同比增长率",
      metric_key: null,
      format: "percent",
      precision: 2,
      suffix: "%",
      scale: 100,
      display_scale: 100,
      scale_applied: false,
      source: "analytical_metric_expansion"
    });
  }
  const sql = [
    withSql,
    selectLines.join("\n"),
    "FROM metric_by_year",
    "ORDER BY `年份`"
  ].join("\n");
  return {
    sql,
    selectedKeys,
    baseKeys: selectedKeys,
    periods,
    displayFormats,
    valueColumn,
    includeYoy
  };
}

function resolvedAccountItemsFromPayload(payload) {
  if (!isBpcPayload(payload)) return [];
  const checklist = normalizeCoverageChecklist(payload?.retrieval_plan?.coverage_checklist || []);
  const resolved = Array.isArray(payload?.resolved_sql_resultsets) ? payload.resolved_sql_resultsets : [];
  const items = [];
  for (const coverage of checklist) {
    if (!coverage.item) continue;
    const itemType = String(coverage.item_type || "").trim();
    if (coverage.evidence_type === "business_metric") continue;
    if (!["sql_resultset", "none", ""].includes(coverage.evidence_type)) continue;
    if (!["metric", "object", "rule", ""].includes(itemType)) continue;
    const resultsets = resolved.filter(resultset => {
      if (coverage.evidence_key) return resultset.key === coverage.evidence_key;
      return true;
    });
    for (const resultset of resultsets) {
      const codeColumns = resultset.code_columns?.length
        ? resultset.code_columns
        : ["科目编码", "account_code", "code", "racct", "saknr", "hkont", "cpmb_kgd4b76"];
      const nameColumns = resultset.name_columns?.length
        ? resultset.name_columns
        : ["科目名称", "account_name", "name", "txtlg", "txt20", "txt30", "description"];
      const rows = Array.isArray(resultset.rows) ? resultset.rows : [];
      const scoredRows = rows.map(row => {
        const name = rowValueByColumns(row, nameColumns);
        const code = rowValueByColumns(row, codeColumns);
        const exactName = normalizeCandidateText(name) === normalizeCandidateText(coverage.item);
        const matchScore = Number(row?._match_score || scoreCandidateValue(coverage.item, name));
        return { row, name, code, score: exactName ? 2 : matchScore };
      }).filter(item => item.code && item.name);
      scoredRows.sort((a, b) => b.score - a.score);
      const best = scoredRows[0];
      if (!best) continue;
      const minimumScore = coverage.evidence_type === "sql_resultset" ? 0.42 : 0.78;
      if (best.score < minimumScore) continue;
      const remark = String(best.row?.备注 || best.row?.remark || best.row?.note || "").trim();
      const needsReverse = /需要置反/.test(remark) && !/(不需要置反|无需置反|不置反)/.test(remark);
      items.push({
        item: coverage.item,
        code: String(best.code).trim(),
        name: String(best.name).trim(),
        result_factor: needsReverse ? -1 : 1,
        remark,
        resultset_key: resultset.key,
        match_score: best.score
      });
      break;
    }
  }
  const unique = new Map();
  for (const item of items) {
    const key = `${item.item}::${item.code}`;
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()];
}

function bpcResolvedAccountExpression(item, period) {
  const code = String(item?.code || "").trim();
  if (!code || !period?.period) return null;
  const factor = Number(item.result_factor || 1);
  const condition = `account_path LIKE ${sqlLiteral(`%/${code}/%`)}`;
  const current = `SUM(CASE WHEN b28_s_kgd353d = ${sqlLiteral(period.period)} AND ${condition} THEN b28_s_sdata ELSE 0 END)`;
  const prefix = factor === 1 ? "" : `${factor} * `;
  if (period.asksMonth && period.previous && /^(APL|CF)/i.test(code)) {
    const previous = `SUM(CASE WHEN b28_s_kgd353d = ${sqlLiteral(period.previous)} AND ${condition} THEN b28_s_sdata ELSE 0 END)`;
    return `${prefix}(${current} - ${previous})`;
  }
  return `${prefix}${current}`;
}

function bpcResolvedAccountGroupedExpression(item, alias) {
  const code = String(item?.code || "").trim();
  if (!code) return null;
  const factor = Number(item.result_factor || 1);
  const condition = `account_path LIKE ${sqlLiteral(`%/${code}/%`)}`;
  const aggregate = `SUM(CASE WHEN ${condition} THEN b28_s_sdata ELSE 0 END)`;
  const expression = factor === 1
    ? aggregate
    : factor === -1
      ? `- ${aggregate}`
      : `${factor} * (${aggregate})`;
  return `  ${expression} AS \`${alias}\``;
}

function bpcResolvedAccountCondition(item) {
  const code = String(item?.code || "").trim();
  if (!code) return null;
  return `account_path LIKE ${sqlLiteral(`%/${code}/%`)}`;
}

function bpcSimpleMetricCondition(metric) {
  const scope = metricScopeExpression(metric);
  if (!scope) return null;
  const accountMatches = [...scope.matchAll(/`?account_path`?\s+LIKE\s+'[^']+'/gi)]
    .map(match => match[0].replace(/`/g, ""));
  if (accountMatches.length !== 1) return null;

  const allowedFields = new Set([
    "account_path",
    "b28_s_kgd353d",
    "b28_s_kgdp984",
    "b28_s_kgd4kbn",
    "b28_s_kgdc8w9",
    "b28_s_kgdtvnx",
    "b28_s_kgd4rtr_kgdxoi5",
    "b28_s_kgdbveh"
  ]);
  const referencedFields = [...scope.matchAll(/`?(account_path|b28_s_[A-Za-z0-9_]+)`?\s*(?:=|<>|!=|LIKE|NOT\s+LIKE|IN|NOT\s+IN)\b/gi)]
    .map(match => match[1]);
  if (referencedFields.some(field => !allowedFields.has(field))) return null;

  const specialConditions = [...scope.matchAll(/`?b28_s_kgdbveh`?\s*(?:=|IN|LIKE|NOT\s+LIKE)\s*(?:'[^']*'|\([^)]+\))/gi)]
    .map(match => match[0].replace(/`/g, ""));
  const parts = uniqueSqlConditions([accountMatches[0], ...specialConditions]);
  if (!parts.length) return null;
  return parts.length === 1 ? parts[0] : `(${parts.join(" AND ")})`;
}

function bpcSimpleAggregateExpression(condition, measure, alias) {
  if (!condition || !measure?.field || measure.aggregation !== "SUM") return null;
  const aggregate = `SUM(CASE WHEN ${condition} THEN ${measure.field} ELSE 0 END)`;
  const factor = Number(measure.resultFactor || 1);
  const expression = factor === 1
    ? aggregate
    : factor === -1
      ? `- ${aggregate}`
      : `${factor} * (${aggregate})`;
  return `  ${expression} AS \`${alias}\``;
}

function formatWhereConditionLine(condition, index) {
  const prefix = index ? "AND " : "";
  return String(condition || "")
    .split(/\r?\n/)
    .map((line, lineIndex) => `  ${lineIndex ? "    " : prefix}${line}`)
    .join("\n");
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
  if (!items.length) return selectedKeys;
  const filtered = selectedKeys.filter(key => {
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
    return /(未在|未定义|未找到|缺少|缺失|无法|不能|推断|可能|猜测|ABS02)/.test(text);
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

function buildSimpleBpcMetricSql({ payload, generated, mandatoryContext, metrics, selectedKeys, selectedMetrics, resolvedAccountItems, period }) {
  if (!isBpcPayload(payload) || !period?.period) return null;
  if (period.asksMonth) return null;

  const selectLines = [];
  const displayFormats = [];
  const baseKeys = [];

  for (const key of selectedKeys) {
    const metric = metrics.get(key);
    if (!metric) return null;
    if (metricKind(metric) === "derived") return null;
    if (metricSourceTable(metric) !== "bpc_consolidated_report") return null;
    const condition = bpcSimpleMetricCondition(metric);
    if (!condition) return null;
    const name = metric.name || key;
    const measure = metricMeasure(metric);
    const selectLine = bpcSimpleAggregateExpression(condition, measure, name);
    if (!selectLine) return null;
    const presentation = metricPresentation(metric, name, generated?.display_formats || []);
    const displayFormat = metricDisplayFormat(metric, name, presentation);
    if (displayFormat) displayFormats.push(displayFormat);
    selectLines.push(selectLine);
    baseKeys.push(key);
  }

  for (const item of resolvedAccountItems) {
    const condition = bpcResolvedAccountCondition(item);
    const measure = {
      field: "b28_s_sdata",
      aggregation: "SUM",
      resultFactor: Number(item.result_factor || 1)
    };
    const selectLine = bpcSimpleAggregateExpression(condition, measure, item.item);
    if (!selectLine) continue;
    selectLines.push(selectLine);
    baseKeys.push(item.item);
  }

  if (!selectLines.length) return null;
  if (selectedMetrics.some(metric => metricSourceTable(metric) !== "bpc_consolidated_report")) return null;

  const mandatoryFilters = (mandatoryContext?.sql_filters || [])
    .map(item => item.sql)
    .filter(Boolean);
  const whereLines = uniqueSqlConditions([
    `b28_s_kgd353d = ${sqlLiteral(period.period)}`,
    ...mandatoryFilters
  ]);
  if (!whereLines.length) return null;

  const sql = [
    "SELECT",
    selectLines.join(",\n"),
    `FROM ${quotedTableName("bpc_consolidated_report")}`,
    "WHERE",
    whereLines.map(formatWhereConditionLine).join("\n")
  ].join("\n");

  return {
    sql,
    selectedKeys,
    baseKeys: [...new Set(baseKeys)],
    resolvedAccountItems,
    period,
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
  const resolvedAccountItems = resolvedAccountItemsFromPayload(payload);
  const metrics = metricCatalogMap(payload);
  let selectedKeys = filterSelectedMetricKeysByCoverage(payload, metrics, candidateSelectedKeys);
  selectedKeys = expandSelectedMetricKeysByBreakdown(payload, metrics, selectedKeys);
  selectedKeys = expandSelectedMetricKeysByComponentOutputRule(payload, generated, mandatoryContext, metrics, selectedKeys);
  if (!selectedKeys.length && !resolvedAccountItems.length) return null;
  const selectedMetrics = selectedKeys.map(key => metrics.get(key)).filter(Boolean);
  if (selectedKeys.length && !selectedMetrics.length && !resolvedAccountItems.length) return null;
  const multiReadiness = multiPeriodReadiness(payload, generated, metrics, selectedKeys, resolvedAccountItems);

  const multiPeriodSql = buildDeterministicMultiPeriodMetricSql(
    payload,
    generated,
    mandatoryContext,
    metrics,
    selectedKeys,
    resolvedAccountItems
  );
  if (multiPeriodSql) return multiPeriodSql;
  if (multiReadiness.wants_multi_period && multiReadiness.periods.length > 1) {
    return null;
  }

  const period = bpcPeriodInfo(payload, generated?.sql || "");
  if (!period.period) return null;

  const simpleBpcSql = buildSimpleBpcMetricSql({
    payload,
    generated,
    mandatoryContext,
    metrics,
    selectedKeys,
    selectedMetrics,
    resolvedAccountItems,
    period
  });
  if (simpleBpcSql) return { ...simpleBpcSql, multiPeriodReadiness: multiReadiness };

  const baseRequirements = new Map();
  const periodValues = new Set([period.period]);
  const warnings = [];
  const addBaseRequirement = (key, metric, dep = {}) => {
    const role = dep.periodRole || dep.period_role || "current_period";
    const variable = dep.variable || key;
    const alias = safeMetricAlias(`${key}__${role}__${variable}`);
    const requirementKey = `${key}::${role}::${variable}`;
    if (!baseRequirements.has(requirementKey)) {
      const expression = bpcBaseRequirementExpression(metric, period, role);
      if (!expression) return null;
      bpcRolePeriods(period, role, metric).forEach(item => periodValues.add(item));
      if (period.asksMonth && String(role) === "current_period" && bpcMetricLooksCumulative(metric)) {
        warnings.push(`${metric.name || key} 为累计科目，已按 ${period.period} - ${period.previous} 计算本月发生额。`);
      }
      baseRequirements.set(requirementKey, { key, metric, role, variable, alias, expression });
    }
    return `\`${alias}\``;
  };

  const resolveMetricExpression = (key, dep = {}, stack = []) => {
    const metric = metrics.get(key);
    if (!metric || stack.includes(key)) return null;
    if (metricKind(metric) !== "derived") {
      return addBaseRequirement(key, metric, dep);
    }
    const deps = metricDependencySpecs(metric);
    if (!deps.length) return false;
    const replacements = new Map();
    for (const child of deps) {
      const childExpression = resolveMetricExpression(child.metricKey, child, [...stack, key]);
      if (!childExpression) return null;
      replacements.set(child.variable || child.metricKey, `(${childExpression})`);
      replacements.set(child.metricKey, `(${childExpression})`);
    }
    const formula = metricExpression(metric);
    const expression = replaceMetricTokens(formula, replacements);
    if (!expression || unresolvedMetricFormulaTokens(formula, replacements).length) return null;
    return expression;
  };

  const outerSelects = [];
  const displayFormats = [];
  for (const key of selectedKeys) {
    const metric = metrics.get(key);
    if (!metric) continue;
    const name = metric.name || key;
    const presentation = metricPresentation(metric, name, generated?.display_formats || []);
    const displayFormat = metricDisplayFormat(metric, name, presentation);
    if (displayFormat) displayFormats.push(displayFormat);
    const expression = resolveMetricExpression(key, { variable: key, periodRole: "current_period" });
    if (!expression) return null;
    outerSelects.push(`  ${applyMetricPresentationToSql(expression, presentation)} AS \`${name}\``);
  }
  for (const item of resolvedAccountItems) {
    const expression = bpcResolvedAccountExpression(item, period);
    if (!expression) continue;
    if (period.asksMonth && period.previous && /^(APL|CF)/i.test(item.code)) {
      periodValues.add(period.previous);
      warnings.push(`${item.item} 为 ${item.code}，已按 ${period.period} - ${period.previous} 计算本月发生额。`);
    }
    const alias = safeMetricAlias(`resolved_sql_resultset__${item.code}__${item.item}`);
    baseRequirements.set(`resolved::${item.code}::${item.item}`, {
      key: item.item,
      metric: null,
      role: "current_period",
      variable: item.item,
      alias,
      expression,
      source: item.resultset_key
    });
    outerSelects.push(`  \`${alias}\` AS \`${item.item}\``);
  }
  if (!outerSelects.length) return null;
  const sourceTables = new Set([...baseRequirements.values()].map(item => item.metric ? metricSourceTable(item.metric) : "bpc_consolidated_report").filter(Boolean));
  if (sourceTables.size !== 1 || !sourceTables.has("bpc_consolidated_report")) return null;
  const innerSelects = [...baseRequirements.values()].map(item => `    ${item.expression} AS \`${item.alias}\``);

  const allScopeText = [...baseRequirements.values()]
    .filter(item => item.metric)
    .map(item => metricScopeExpression(item.metric))
    .join("\n");
  const mandatoryFilters = (mandatoryContext?.sql_filters || [])
    .filter(item => resolvedAccountItems.length || !(item?.field && hasFieldReference(allScopeText, item.field)))
    .map(item => item.sql)
    .filter(Boolean);
  const whereLines = [
    `b28_s_kgd353d IN (${[...periodValues].filter(Boolean).map(sqlLiteral).join(", ")})`,
    ...mandatoryFilters
  ];
  const sql = [
    "SELECT",
    outerSelects.join(",\n"),
    "FROM (",
    "  SELECT",
    innerSelects.join(",\n"),
    `  FROM ${quotedTableName("bpc_consolidated_report")}`,
    "  WHERE",
    whereLines.map((line, index) => `    ${index ? "AND " : ""}${line}`).join("\n"),
    ") base"
  ].join("\n");

  return {
    sql,
    selectedKeys,
    baseKeys: [...new Set([...baseRequirements.values()].map(item => item.key))],
    resolvedAccountItems,
    period,
    multiPeriodReadiness: multiReadiness,
    displayFormats,
    warnings
  };
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
  const hasResolvedItems = resolvedAccountItemsFromPayload(payload).length > 0;
  if (!selectedMetricKeys.length && !hasResolvedItems) return null;
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
    try {
      loopResult = await tryEvidenceFirstPlan(payload, pushTrace);
    } catch {
      loopResult = null;
    }
    if (!loopResult) {
      loopResult = await runSemanticAgentLoop(payload, pushTrace, emitProgress);
    }
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

  const enrichedPayload = {
    ...payload,
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
  if (!generation.data) {
    const deterministicSeed = deterministicSeedFromRetrievalPlan(enrichedPayload, retrievalPlan);
    if (deterministicSeed) {
      const normalizedSeed = normalizeGeneratedSqlData(deterministicSeed, enrichedPayload);
      const deterministicPreview = hasAnalyticalSqlShape(normalizedSeed.sql)
        ? buildDeterministicAnalyticalMetricSql(enrichedPayload, normalizedSeed, mandatoryContext)
        : buildDeterministicMetricSql(enrichedPayload, normalizedSeed, mandatoryContext);
      if (deterministicPreview?.sql) {
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
          stageStartedAt,
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
    emitProgress(
      "sql_generation",
      "sql_generation",
      "形成取数 SQL",
      stageStartedAt,
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
        stageStartedAt,
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
  generated.decision.selected_rule_keys = [
    ...new Set([
      ...(mandatoryContext.rule_keys || []),
      ...(generated.decision.selected_rule_keys || [])
    ])
  ];
  const metricExpansionStartedAt = Date.now();
  const preserveAnalyticalSql = hasAnalyticalSqlShape(generated.sql);
  const deterministicAnalyticalSql = preserveAnalyticalSql
    ? buildDeterministicAnalyticalMetricSql(enrichedPayload, generated, mandatoryContext)
    : null;
  const deterministicMetricSql = preserveAnalyticalSql
    ? null
    : buildDeterministicMetricSql(enrichedPayload, generated, mandatoryContext);
  if (deterministicAnalyticalSql?.sql) {
    generated.sql = deterministicAnalyticalSql.sql;
    generated.display_formats = [
      ...(generated.display_formats || []),
      ...(deterministicAnalyticalSql.displayFormats || [])
    ];
    generated.sql_plan = [
      ...(generated.sql_plan || []),
      {
        part: "SELECT",
        value: "按模型识别出的时间序列结构展开业务指标",
        source: "deterministic_analytical_metric_expansion",
        note: "保留按年/同比等分析结构，但用业务指标配置中的 scope_filter、measure.field 和 result_factor 生成稳定 SQL。"
      }
    ];
    pushTrace(traceItem(
      "metric_expansion",
      "按分析结构展开指标口径",
      "success",
      metricExpansionStartedAt,
      `输出指标：${semanticEntryLabels(enrichedPayload, "business_metric", deterministicAnalyticalSql.selectedKeys, 8)}；期间：${deterministicAnalyticalSql.periods.join("、")}`,
      {
        selected_metric_keys: deterministicAnalyticalSql.selectedKeys,
        base_metric_keys: deterministicAnalyticalSql.baseKeys,
        periods: deterministicAnalyticalSql.periods,
        include_yoy: deterministicAnalyticalSql.includeYoy,
        display_formats: deterministicAnalyticalSql.displayFormats || [],
        sql: deterministicAnalyticalSql.sql
      },
      "模型负责识别按年和同比结构，后端用指标配置补齐符号、科目过滤和公共口径，避免分析维度被压成单值。",
      {
        id: "metric_expansion",
        purpose: "把业务指标配置和模型识别出的分析结构合并成稳定 SQL。",
        finding: `期间 ${deterministicAnalyticalSql.periods.join("、")}；同比=${deterministicAnalyticalSql.includeYoy ? "是" : "否"}`,
        decision: "采用分析型指标展开 SQL，继续进入只读校验和数据库查询。"
      }
    ));
  } else if (deterministicMetricSql?.sql) {
    generated.sql = deterministicMetricSql.sql;
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
        period: deterministicMetricSql.period,
        multi_period_readiness: deterministicMetricSql.multiPeriodReadiness || null,
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
  const hasExecutableSql = looksLikeExecutableSelectSql(generated.sql);
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
      stageStartedAt,
      hasExecutableSql
        ? `${generationSourceLabel}；主指标：${generated.decision?.selected_metric_key || "未命中"}；规则：${(generated.decision?.selected_rule_keys || []).join("、") || "无"}`
        : `${generationSourceLabel}；未形成可执行 SELECT/WITH SQL`,
      sqlGenerationArtifact(generated),
      hasExecutableSql
        ? `把已选依据转成一条可执行 SQL；这次准备输出 ${compactList(sqlAliasSummary(generated.sql), 6) || "未识别输出列"}，并带上 ${compactList(generated.decision?.selected_rule_keys, 4) || "默认"} 口径。`
        : "当前语义和补查结果不足以安全生成 SQL；不再进入 SQL 校验和数据库执行。",
      {
        id: "sql_generation",
        purpose: "把采用的指标、规则、表结构和用户配置转换成 SQL。",
        finding: hasExecutableSql
          ? `输出列：${compactList(sqlAliasSummary(generated.sql), 8) || "未识别"}；主指标：${generated.decision?.selected_metric_key || "未命中"}`
          : generated.answer || "未形成可执行 SQL。",
        decision: hasExecutableSql
          ? "生成结果进入后端校验，校验通过后才会查询数据库。"
          : "停止执行；只返回缺失依据，不展示伪 SQL。"
      }
    ));
  }

  if (!hasExecutableSql) {
    return {
      model: generation.model,
      data: finishPayload({
        ...generated,
        resolved_sql_resultsets: resolvedSqlResultsets,
        answer: generated.answer || "当前语义依据不足，无法安全生成 SQL。请补充业务指标、规则或 SQL结果集映射。",
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

  stageStartedAt = Date.now();
  const enforcement = enforceMandatoryContextOnGenerated(generated, mandatoryContext);

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
        const repairEnforcement = enforceMandatoryContextOnGenerated(generated, mandatoryContext);
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
  const deterministicFinalData = deterministicAnswerFromExecution(execution, generated, mandatoryContext, enrichedPayload);
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
    finalAnswer = await callModelJson(
      buildFinalAnswerMessages({ payload: enrichedPayload, generated, validation, execution }),
      { temperature: 0.1, maxTokens: 2048 }
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
  const displayFormats = rendererDisplayFormats(enrichedPayload, generated, execution.columns || []);
  const resolvedAccountItems = resolvedAccountItemsFromPayload(enrichedPayload);
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
      display: {
        columns: execution.columns || [],
        rows: formatExecutionRowsForDisplay(execution, displayFormats).slice(0, 50),
        formats: displayFormats
      },
      sql_validation: { ok: true, ...validation },
      warnings: [...new Set([...(generated.warnings || []), ...(finalData.warnings || [])].filter(Boolean))]
        .filter(warning => !warningContradictsResolvedItems(warning, resolvedAccountItems))
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
      "Connection": "keep-alive"
    });
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    res.write(": connected\n\n");
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
