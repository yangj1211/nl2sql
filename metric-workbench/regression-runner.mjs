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
    source_tables: relatedTables,
    tables: relatedTables,
    priority: Number(spec.priority ?? 0),
    injection_stages: Array.isArray(spec.injection_stages) ? spec.injection_stages : [],
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
        knowledge_metrics: [{
          name: "requested metric name",
          formula: "standard formula",
          dependencies: [{ name: "business concept", variable: "formula variable", evidence_type: "business_metric | sql_resultset | table_context | none", evidence_key: "string" }],
          confidence: 0.0,
          caveat: "string"
        }],
        tables: ["table name"],
        time: "string or object",
        dimensions: ["field or business dimension"],
        calculations: ["aggregation, yoy, ranking, distribution, detail, count"],
        filters: ["business condition or rule key"],
        needs_lookup: ["object that needs code/enum lookup"],
        output: ["expected result columns"]
      },
      sql: "one read-only SELECT/WITH SQL, or empty when result_sets is used",
      result_sets: [{ key: "string", title: "string", purpose: "string", sql: "one read-only SELECT/WITH SQL" }],
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
  const resultSets = Array.isArray(data.result_sets) ? data.result_sets : [];
  return [
    ...(data.execution?.columns || []),
    ...(data.display?.columns || []),
    ...resultSets.flatMap(item => [
      ...(item?.execution?.columns || []),
      ...(item?.display?.columns || [])
    ])
  ].filter(Boolean);
}

function resultRows(result) {
  const data = result.data || {};
  const resultSets = Array.isArray(data.result_sets) ? data.result_sets : [];
  if (resultSets.length) {
    return resultSets.flatMap(item => item?.execution?.rows || item?.display?.rows || []);
  }
  return data.execution?.rows || data.display?.rows || [];
}

function resultSql(result) {
  const data = result.data || {};
  return [...new Set([
    data.sql,
    ...(Array.isArray(data.result_sets) ? data.result_sets.map(item => item?.sql) : [])
  ].filter(Boolean).map(String))].join("\n\n");
}

function appliedRuleKeys(result) {
  const data = result.data || {};
  const stageCoverage = data.rule_execution && typeof data.rule_execution === "object"
    ? Object.values(data.rule_execution).filter(item => item && typeof item === "object")
    : [];
  return [...new Set([
    ...(Array.isArray(data.applied_rule_keys) ? data.applied_rule_keys : []),
    ...stageCoverage.flatMap(item => Array.isArray(item.applied_rule_keys) ? item.applied_rule_keys : []),
    ...(Array.isArray(data.result_sets)
      ? data.result_sets.flatMap(item => Array.isArray(item?.applied_rule_keys) ? item.applied_rule_keys : [])
      : [])
  ].map(String).filter(Boolean))];
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
  const sql = resultSql(result);
  const resultSets = Array.isArray(data.result_sets) ? data.result_sets : [];
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

  if (testCase.expect_result_set_count != null && resultSets.length !== Number(testCase.expect_result_set_count)) {
    failures.push(`结果集数量 ${resultSets.length} 不等于期望 ${testCase.expect_result_set_count}`);
  }

  (testCase.expect_result_set_titles || []).forEach(title => {
    if (!resultSets.some(item => includesLoose(item?.title || "", title))) {
      failures.push(`缺少结果集标题：${title}`);
    }
  });

  (testCase.expect_result_set_column_counts || []).forEach(expectation => {
    const matchingSet = resultSets.find(item => includesLoose(item?.title || "", expectation?.title || ""));
    if (!matchingSet) {
      failures.push(`无法检查结果集列数，缺少标题：${expectation?.title || ""}`);
      return;
    }
    const setColumns = matchingSet?.execution?.columns || matchingSet?.display?.columns || [];
    if (setColumns.length !== Number(expectation.count)) {
      failures.push(`结果集“${expectation.title}”列数 ${setColumns.length} 不等于期望 ${expectation.count}`);
    }
  });

  (testCase.expect_result_set_columns || []).forEach(expectation => {
    const matchingSet = resultSets.find(item => includesLoose(item?.title || "", expectation?.title || ""));
    if (!matchingSet) {
      failures.push(`无法检查结果集字段顺序，缺少标题：${expectation?.title || ""}`);
      return;
    }
    const setColumns = matchingSet?.execution?.columns || matchingSet?.display?.columns || [];
    const expectedColumns = Array.isArray(expectation?.columns) ? expectation.columns : [];
    if (
      setColumns.length !== expectedColumns.length
      || expectedColumns.some((column, index) => normalizeText(setColumns[index]) !== normalizeText(column))
    ) {
      failures.push(
        `结果集“${expectation.title}”字段顺序不符：实际 ${setColumns.join("、")}；期望 ${expectedColumns.join("、")}`
      );
    }
  });

  (testCase.expect_result_set_sql_contains || []).forEach(expectation => {
    const matchingSets = resultSets.filter(item => includesLoose(item?.title || "", expectation?.title || ""));
    if (!matchingSets.length) {
      failures.push(`无法检查结果集 SQL，缺少标题：${expectation?.title || ""}`);
      return;
    }
    (expectation?.fragments || []).forEach(fragment => {
      if (matchingSets.some(item => !includesLoose(item?.sql || "", fragment))) {
        failures.push(`结果集“${expectation.title}”SQL 缺少：${fragment}`);
      }
    });
  });

  (testCase.reject_result_set_sql_contains || []).forEach(expectation => {
    const matchingSets = resultSets.filter(item => includesLoose(item?.title || "", expectation?.title || ""));
    if (!matchingSets.length) {
      failures.push(`无法检查结果集 SQL，缺少标题：${expectation?.title || ""}`);
      return;
    }
    (expectation?.fragments || []).forEach(fragment => {
      if (matchingSets.some(item => includesLoose(item?.sql || "", fragment))) {
        failures.push(`结果集“${expectation.title}”SQL 不应包含：${fragment}`);
      }
    });
  });

  const appliedRules = appliedRuleKeys(result);
  (testCase.expect_applied_rule_keys || []).forEach(key => {
    if (!appliedRules.includes(String(key))) failures.push(`强制规则未标记为已执行：${key}`);
  });

  const trace = Array.isArray(data.trace) ? data.trace : [];
  (testCase.reject_failed_trace_stages || []).forEach(stage => {
    const failedItems = trace.filter(item => item?.stage === stage && item?.status === "failed");
    if (failedItems.length) {
      failures.push(
        `阶段 ${stage} 不应失败：${failedItems.map(item => item?.detail || item?.label || "未知错误").join("；")}`
      );
    }
  });

  Object.entries(testCase.expect_approx || {}).forEach(([column, expectation]) => {
    const actualColumn = findColumn(columns, column);
    if (!actualColumn) {
      failures.push(`无法检查数值，缺少列：${column}`);
      return;
    }
    const firstRow = rows.find(row => Object.prototype.hasOwnProperty.call(row || {}, actualColumn)) || {};
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
  const showRules = args.includes("--show-rules");
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
        console.log(`  SQL：${resultSql(result).slice(0, 6000).replace(/\n/g, " ")}`);
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
        if (showRules) {
          const ruleTraces = (result.data?.trace || [])
            .filter(item => ["output_contract", "rule_contract", "sql_decomposition"].includes(item.stage))
            .map(item => ({ label: item.label, status: item.status, detail: item.detail, artifact: item.artifact }));
          console.log(`  规则执行：${JSON.stringify(result.data?.rule_execution || null)}`);
          console.log(`  规则轨迹：${JSON.stringify(ruleTraces).slice(0, 12000)}`);
        }
        console.log(`  耗时：${summarizeTimings(result)}`);
      } else {
        passed += 1;
        console.log(`PASS ${testCase.id} (${duration}s)`);
        if (showSql) {
          console.log(`  耗时：${summarizeTimings(result)}`);
          console.log(`  SQL：${resultSql(result).slice(0, 10000).replace(/\n/g, " ")}`);
        }
        if (showRules) {
          const ruleTraces = (result.data?.trace || [])
            .filter(item => ["output_contract", "rule_contract", "sql_decomposition"].includes(item.stage))
            .map(item => ({ label: item.label, status: item.status, detail: item.detail, artifact: item.artifact }));
          console.log(`  规则执行：${JSON.stringify(result.data?.rule_execution || null)}`);
          console.log(`  规则轨迹：${JSON.stringify(ruleTraces)}`);
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
