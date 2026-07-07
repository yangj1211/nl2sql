import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const baseUrl = process.env.METRIC_WORKBENCH_BASE_URL || "http://127.0.0.1:8768";
const casesPath = process.env.METRIC_WORKBENCH_REGRESSION_CASES || join(__dirname, "regression-cases.json");
const DEFAULT_REJECT_ANSWER_CONTAINS = ["未定义", "无法提供", "无法确定", "证据不足"];

function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[`'"“”‘’\s_.,，。:：;；/\\|()（）\-]+/g, "")
    .trim();
}

function parseNumberLike(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const match = raw.match(/^-?\d[\d,]*(?:\.\d+)?%?$/);
  if (!match) return null;
  const numeric = Number(raw.replace(/,/g, "").replace(/%$/g, ""));
  if (!Number.isFinite(numeric)) return null;
  const decimalPart = raw.replace(/%$/g, "").split(".")[1] || "";
  const tolerance = decimalPart
    ? Math.max(0.5 * Math.pow(10, -decimalPart.length), 1e-9)
    : 0.5;
  return { numeric, tolerance, isPercent: raw.endsWith("%") };
}

function includesApproxNumber(haystack, needle) {
  const expected = parseNumberLike(needle);
  if (!expected) return false;
  const source = String(haystack ?? "");
  const numberTokens = source.match(/-?\d[\d,]*(?:\.\d+)?%?/g) || [];
  return numberTokens.some(token => {
    const actual = parseNumberLike(token);
    if (!actual) return false;
    if (expected.isPercent !== actual.isPercent) return false;
    return Math.abs(actual.numeric - expected.numeric) <= expected.tolerance;
  });
}

function includesLoose(haystack, needle) {
  const source = String(haystack ?? "");
  const target = String(needle ?? "");
  return source.includes(target)
    || normalizeText(source).includes(normalizeText(target))
    || includesApproxNumber(source, target);
}

function splitAliases(value) {
  if (Array.isArray(value)) return value.map(item => String(item || "").trim()).filter(Boolean);
  return String(value || "")
    .split(/[、,，\n]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

function normalizeDbTables(tables) {
  if (!Array.isArray(tables)) return [];
  return tables.map(item => {
    if (typeof item === "string") return item;
    return item?.table_name || item?.name || "";
  }).filter(Boolean);
}

function compactEntry(entry) {
  const rawSpec = entry.spec || {};
  const spec = rawSpec.spec && entry.kind !== "business_metric" ? rawSpec.spec : rawSpec;
  const entryMeta = rawSpec.entry || {};
  const relatedTables = normalizeDbTables(entry.tables);
  const metricSpec = spec.metric || {};
  const firstTable = relatedTables[0] || metricSpec.source_table || spec.source_table || "";
  const aliases = spec.aliases ?? entryMeta.aliases ?? [];
  const base = {
    key: entry.key_name || entryMeta.key || spec.key || "",
    type: entry.kind,
    name: spec.name || entryMeta.name || entry.key_name || "",
    aliases: splitAliases(aliases),
    source_table: firstTable,
    summary: String(
      spec.summary
      || spec.description
      || spec.table_note
      || spec.content
      || spec.logic_text
      || spec.question
      || spec.answer
      || ""
    ).slice(0, entry.kind === "logic_text" ? 1800 : 900)
  };
  if (entry.kind === "business_metric") {
    const measure = metricSpec.measure || {};
    base.metric_kind = spec.metric_kind || entryMeta.metric_kind || "base";
    base.measure = {
      field: measure.field || "",
      aggregation: measure.aggregation || "",
      result_factor: Number(measure.result_factor ?? 1)
    };
    base.scope_filter = Array.isArray(spec.scope_filter?.expression_lines)
      ? spec.scope_filter.expression_lines
      : [];
    if (metricSpec.presentation || spec.presentation) {
      base.presentation = metricSpec.presentation || spec.presentation;
    }
    if (base.metric_kind === "derived") {
      base.dependency_keys = Array.isArray(metricSpec.dependencies)
        ? metricSpec.dependencies.map(dep => typeof dep === "string" ? dep : dep?.metric_key).filter(Boolean)
        : [];
      base.dependencies = Array.isArray(metricSpec.dependency_specs)
        ? metricSpec.dependency_specs
        : Array.isArray(metricSpec.dependencies)
          ? metricSpec.dependencies
          : [];
      base.expression = metricSpec.expression || "";
    }
  }
  if (entry.kind === "logic_text") {
    base.content = String(spec.content || spec.logic_text || "").slice(0, 2600);
  }
  if (entry.kind === "result_presentation") {
    base.content = String(spec.content || spec.prompt || spec.requirement || "").slice(0, 1800);
    base.applies_to = Array.isArray(spec.applies_to)
      ? spec.applies_to
      : Array.isArray(spec.presentation_stages)
        ? spec.presentation_stages
        : [];
  }
  if (entry.kind === "table_column_note") {
    base.table_note = spec.table_note || "";
    base.columns = Array.isArray(spec.columns)
      ? spec.columns
          .filter(column => column.enabled !== false)
          .map(column => ({
            name: column.name || "",
            description: column.description || "",
            note: column.note || ""
          }))
      : [];
  }
  if (entry.kind === "sql_resultset") {
    base.sql = String(spec.sql || "").slice(0, 1800);
    base.description = spec.description || "";
  }
  if (entry.kind === "standard_qa") {
    base.question = spec.question || entry.key_name || "";
    base.answer = spec.answer || spec.sql || "";
  }
  return base;
}

function buildSemanticCatalog(entries, modelId, tables) {
  const selectedTables = new Set(tables || []);
  const scoped = entries.filter(entry => {
    if (Number(entry.model_id) !== Number(modelId)) return false;
    const related = normalizeDbTables(entry.tables);
    if (!selectedTables.size || !related.length) return true;
    return related.some(table => selectedTables.has(table));
  });
  const byKind = kind => scoped.filter(entry => entry.kind === kind).map(compactEntry);
  return {
    business_metric: byKind("business_metric"),
    logic_text: byKind("logic_text"),
    result_presentation: byKind("result_presentation"),
    table_column_note: byKind("table_column_note"),
    sql_resultset: byKind("sql_resultset"),
    standard_qa: byKind("standard_qa")
  };
}

function normalizeModelTables(model) {
  if (Array.isArray(model?.table_names)) return model.table_names.filter(Boolean);
  const tableGroups = Array.isArray(model?.tables) ? model.tables : [];
  return [...new Set(tableGroups.flatMap(group => Array.isArray(group?.table_names) ? group.table_names : []).filter(Boolean))];
}

function buildPayload(workbenchData, testCase) {
  const model = (workbenchData.models || []).find(item => Number(item.id) === Number(testCase.model_id));
  if (!model) throw new Error(`找不到 model_id=${testCase.model_id}`);
  const allTables = normalizeModelTables(model);
  const tables = Array.isArray(testCase.tables) && testCase.tables.length ? testCase.tables : allTables;
  const dataPath = testCase.qa_config?.data_path || "legal";
  const transactionScope = testCase.qa_config?.transaction_scope || "all";
  return {
    question: testCase.question,
    qa_config: {
      table_scope: {
        mode: tables.length === allTables.length ? "all" : "selected",
        tables,
        all_tables: allTables,
        label: tables.length === allTables.length ? `全部表（${allTables.length}）` : `${tables.length} 张表`
      },
      data_path: {
        value: dataPath,
        label: dataPath === "management" ? "管口数据" : "法口数据",
        description: ""
      },
      transaction_scope: {
        value: transactionScope,
        label: transactionScope === "exclude_internal" ? "不含内部关联交易数据" : "全部交易数据",
        description: ""
      }
    },
    data_source: tables.join(", "),
    chat_history: [],
    conversation_context: null,
    semantic_catalog: buildSemanticCatalog(workbenchData.entries || [], model.id, tables),
    required_output_schema: {
      answer: "中文回答",
      answer_type: "final_answer | sql_needed | clarification_needed | rule_explanation | no_evidence",
      decision: {
        intent: "metric_query | dimension_summary | detail_query | rule_explanation | sql_resultset_lookup | unknown",
        selected_metric_keys: ["string"],
        selected_rule_keys: ["string"],
        reason: "string"
      },
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
      sql: "single read-only SELECT SQL",
      warnings: ["string"]
    }
  };
}

async function fetchJson(path, options) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} ${response.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

function allColumnNames(result) {
  const data = result.data || {};
  return [
    ...(data.execution?.columns || []),
    ...(data.display?.columns || [])
  ].filter(Boolean);
}

function resultRows(result) {
  return result.data?.execution?.rows || result.data?.display?.rows || [];
}

function findColumn(columns, name) {
  const target = normalizeText(name);
  return columns.find(column => normalizeText(column) === target)
    || columns.find(column => normalizeText(column).includes(target) || target.includes(normalizeText(column)));
}

function numericValue(value) {
  if (value == null || value === "") return NaN;
  const cleaned = String(value).replace(/,/g, "").replace(/%$/g, "");
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : NaN;
}

function assertCase(testCase, result) {
  const failures = [];
  const data = result.data || {};
  const columns = allColumnNames(result);
  const rows = resultRows(result);
  const sql = String(data.sql || "");
  const answerAndWarnings = [
    data.answer,
    ...(Array.isArray(data.warnings) ? data.warnings : [])
  ].filter(Boolean).join("\n");

  (testCase.expect_columns || []).forEach(column => {
    if (!findColumn(columns, column)) failures.push(`缺少结果列：${column}`);
  });

  (testCase.expect_any_column_groups || []).forEach(group => {
    if (!group.some(column => findColumn(columns, column))) {
      failures.push(`缺少结果列之一：${group.join(" / ")}`);
    }
  });

  if (testCase.expect_min_rows != null && rows.length < Number(testCase.expect_min_rows)) {
    failures.push(`结果行数 ${rows.length} 小于期望 ${testCase.expect_min_rows}`);
  }

  Object.entries(testCase.expect_approx || {}).forEach(([column, expectation]) => {
    const actualColumn = findColumn(columns, column);
    if (!actualColumn) {
      failures.push(`无法检查数值，缺少列：${column}`);
      return;
    }
    const firstRow = rows[0] || {};
    const actual = numericValue(firstRow[actualColumn]);
    const expected = Number(expectation.value);
    const tolerance = Number(expectation.tolerance ?? 0);
    if (!Number.isFinite(actual)) {
      failures.push(`列 ${actualColumn} 不是可比较数值：${firstRow[actualColumn]}`);
      return;
    }
    if (Math.abs(actual - expected) > tolerance) {
      failures.push(`列 ${actualColumn}=${actual}，期望 ${expected}±${tolerance}`);
    }
  });

  (testCase.expect_sql_contains || []).forEach(fragment => {
    if (!sql.includes(fragment)) failures.push(`SQL 缺少片段：${fragment}`);
  });

  (testCase.reject_sql_contains || []).forEach(fragment => {
    if (sql.includes(fragment)) failures.push(`SQL 不应包含片段：${fragment}`);
  });

  (testCase.expect_answer_contains || []).forEach(fragment => {
    if (!includesLoose(answerAndWarnings, fragment)) failures.push(`回答/告警缺少关键结论：${fragment}`);
  });

  const rejectedFragments = [
    ...(testCase.disable_default_reject_answer_contains ? [] : DEFAULT_REJECT_ANSWER_CONTAINS),
    ...(testCase.reject_answer_contains || [])
  ];
  [...new Set(rejectedFragments)].forEach(fragment => {
    if (includesLoose(answerAndWarnings, fragment)) failures.push(`回答/告警不应包含：${fragment}`);
  });

  return failures;
}

function summarizeTimings(result) {
  const trace = result.data?.trace || [];
  return trace
    .map(item => `${item.label || item.stage}:${((item.duration_ms || 0) / 1000).toFixed(2)}s`)
    .join(" | ");
}

async function run() {
  const args = process.argv.slice(2);
  const selectedCaseId = args.includes("--case") ? args[args.indexOf("--case") + 1] : "";
  const listOnly = args.includes("--list");
  const showSql = args.includes("--show-sql");
  const cases = JSON.parse(readFileSync(casesPath, "utf8"));
  if (listOnly) {
    cases.forEach(item => console.log(`${item.id}\t${item.question}`));
    return;
  }
  const selectedCases = selectedCaseId ? cases.filter(item => item.id === selectedCaseId) : cases;
  if (!selectedCases.length) throw new Error(`没有匹配的 case：${selectedCaseId}`);

  const workbenchData = await fetchJson("/api/semantic-workbench-data");
  let passed = 0;
  let failed = 0;
  for (const testCase of selectedCases) {
    const start = Date.now();
    const payload = buildPayload(workbenchData, testCase);
    const catalogCounts = Object.fromEntries(Object.entries(payload.semantic_catalog).map(([key, value]) => [key, value.length]));
    let result;
    try {
      result = await fetchJson("/api/nl2sql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const failures = assertCase(testCase, result);
      const duration = ((Date.now() - start) / 1000).toFixed(1);
      if (failures.length) {
        failed += 1;
        console.log(`FAIL ${testCase.id} (${duration}s)`);
        console.log(`  问题：${testCase.question}`);
        console.log(`  目录：${JSON.stringify(catalogCounts)}`);
        failures.forEach(item => console.log(`  - ${item}`));
        console.log(`  列：${allColumnNames(result).join(", ") || "无"}`);
        console.log(`  回答：${String(result.data?.answer || "").slice(0, 300)}`);
        console.log(`  SQL：${String(result.data?.sql || "").slice(0, 1200).replace(/\n/g, " ")}`);
        const trace = result.data?.trace || [];
        const metricTrace = trace.find(item => item.stage === "metric_expansion");
        if (metricTrace) {
          console.log(`  指标展开：${metricTrace.detail || metricTrace.summary || ""}`);
          if (metricTrace.artifact) {
            console.log(`  指标展开产物：${JSON.stringify(metricTrace.artifact).slice(0, 1200)}`);
          }
        }
        if (result.data?.retrieval_plan) {
          console.log(`  语义计划：${JSON.stringify(result.data.retrieval_plan).slice(0, 2000)}`);
        }
        console.log(`  耗时：${summarizeTimings(result)}`);
      } else {
        passed += 1;
        console.log(`PASS ${testCase.id} (${duration}s)`);
        if (showSql) {
          console.log(`  耗时：${summarizeTimings(result)}`);
          console.log(`  SQL：${String(result.data?.sql || "").slice(0, 3000).replace(/\n/g, " ")}`);
        }
      }
    } catch (error) {
      failed += 1;
      console.log(`ERROR ${testCase.id}`);
      console.log(`  问题：${testCase.question}`);
      console.log(`  ${error.message || String(error)}`);
    }
  }
  console.log(`\nRegression: ${passed} passed, ${failed} failed, ${selectedCases.length} total.`);
  if (failed) process.exitCode = 1;
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
