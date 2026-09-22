# Dev 应收账款实时语义

- 数据源：Dev `moi.semantic_entries`
- 目标表：`accounts_receivable_realtime`
- 条目数：15
- 导出时间：2026-07-14T02:41:53.451Z

## 1. 交货单明细

- ID：100340002
- 模型：六大往来管口（100040001）
- 类型：logic_text
- 关联表：`["accounts_receivable_realtime"]`
- 优先级：10
- 注入阶段：`planner_policy`、`sql_generation`、`executor_rule`、`renderer_rule`
- 创建时间：2026-07-13 10:20:31
- 更新时间：2026-07-14 02:40:47

**规则内容**

除全量字段问询外，所有回答都必须输出交货单/分批次明细口径表。

交货单/分批次明细口径必须按以下顺序输出字段：

1. 销售代表处描述（BEZEI）
2. 销售代表描述（VKGRP_T）
3. 客户名称（NAME1）
4. 销售订单号（VBELN）
5. 工程项目名称（BSTKD_E）
6. 付款条件文本（Z_TERM_CODE）
7. 付款条件描述（Z_TERM_TEXT）
8. 质保期备注（Z_Z003_TEXT）
9. 合同总价（KZWI1）
10. 交货单号（Z_XBLNR）
11. 款项性质（KXXZ）
12. 欠款性质（Z_QKXZ）
13. 款项是否明确（ZKXSFMQ）
14. 发货金额（Z_DE_AMOUNT）
15. 到货日期（Z_AR_DATE）
16. 已开发票时间（Z_IN_DAT）
17. 已开发票金额（Z_IN_AMOUNT）
18. 已回款时间（Z_RE_DAT）
19. 已回款金额（Z_RE_AMOUNT）
20. 已回款比例（派生字段）
21. 未解付票据金额（ZCBBA）
22. 未解付票据到期时间（ZCBDT）
23. 预收款（Z_AD_AMOUNT）
24. 应收余额（YSYE）
25. 当时逾期总额（DSYQZE）
26. 欠款比例（分批次应收余额/对应分批次发货金额，Z_DB_RATE_1）
27. 欠款性质（按交货单，Z_QKXZ_C）
28. 实际到期日（ZSJFBDT）
29. 实际逾期总额（ZSJZE）
30. 实际逾期比例（ZZB）
31. 逾期天数（TS）
32. 付款所需手续（ZFKSXSX）

WHERE 条件根据用户给出的销售订单号、客户名称或其他明确条件动态生成。

已回款比例统一按 CASE WHEN Z_DE_AMOUNT IS NULL OR Z_DE_AMOUNT = 0 THEN NULL ELSE CONCAT(ROUND(Z_RE_AMOUNT / Z_DE_AMOUNT * 100, 2), '%') END 计算和展示。
## 2. 六大往来选表原则

- ID：100180001
- 模型：六大往来管口（100040001）
- 类型：logic_text
- 关联表：`["accounts_receivable_realtime", "receivable_monthly", "receivable_monthly_other", "receivable_other_realtime", "accounts_payable", "other_payable", "advance_receipts", "advance_payments"]`
- 优先级：10
- 注入阶段：`planner_policy`、`sql_generation`、`sql_regenerate`、`sql_decomposition`、`executor_rule`
- 创建时间：2026-06-17 03:55:13
- 更新时间：2026-06-17 03:59:44

**规则内容**

用户明确问单项往来时，只选择对应业务类型的关联表；用户问六大往来、往来整体、多项往来对比或汇总时，按问题需要选择多张关联表。
## 3. 周期年销售规则

- ID：100180010
- 模型：六大往来管口（100040001）
- 类型：logic_text
- 关联表：`["accounts_receivable_realtime", "receivable_monthly", "receivable_monthly_other", "receivable_other_realtime"]`
- 优先级：5
- 注入阶段：`planner_policy`、`sql_generation`、`sql_followup`、`sql_regenerate`、`sql_decomposition`、`executor_rule`
- 创建时间：2026-06-17 03:55:14
- 更新时间：2026-06-17 03:59:44

**规则内容**

用户询问周期年销售时，字段为 ZQNXS。周期年销售是主体属性或项目属性，不按金额口径汇总；每个目标主体或项目只需要输出一条代表值。
## 4. 客户主体规则

- ID：100180003
- 模型：六大往来管口（100040001）
- 类型：logic_text
- 关联表：`["accounts_receivable_realtime", "receivable_monthly", "receivable_monthly_other", "receivable_other_realtime", "advance_receipts"]`
- 优先级：9
- 注入阶段：`planner_policy`、`sql_generation`、`sql_regenerate`、`sql_decomposition`、`executor_rule`
- 创建时间：2026-06-17 03:55:13
- 更新时间：2026-06-17 03:59:44

**规则内容**

主体为客户，名称字段为 NAME1，客户编码字段为 KUNNR。用户问客户、往来方或主体时，默认按 NAME1 聚合；用户明确要求编码时，再输出 KUNNR。
## 5. 应收关联非关联科目

- ID：100180002
- 模型：六大往来管口（100040001）
- 类型：logic_text
- 关联表：`["accounts_receivable_realtime", "receivable_monthly"]`
- 优先级：10
- 注入阶段：`planner_policy`、`sql_generation`、`sql_regenerate`、`sql_decomposition`、`executor_rule`
- 创建时间：2026-06-17 03:55:13
- 更新时间：2026-06-17 03:59:44

**规则内容**

非关联方金额筛选 RACCT 为 112201 开头的数据；关联方金额筛选 RACCT 为 112202 开头的数据。
## 6. 应收及其它应收金额字段

- ID：100180004
- 模型：六大往来管口（100040001）
- 类型：logic_text
- 关联表：`["accounts_receivable_realtime", "receivable_monthly", "receivable_monthly_other", "receivable_other_realtime"]`
- 优先级：9
- 注入阶段：`planner_policy`、`sql_generation`、`sql_regenerate`、`sql_decomposition`、`executor_rule`
- 创建时间：2026-06-17 03:55:13
- 更新时间：2026-06-17 03:59:44

**规则内容**

余额金额使用 YSYE，逾期金额使用 DSYQZE。金额类汇总默认使用 SUM。
## 7. 应收实时款项比例与支付状态规则

- ID：100170003
- 模型：六大往来管口（100040001）
- 类型：logic_text
- 关联表：`["accounts_receivable_realtime"]`
- 优先级：10
- 注入阶段：`planner_policy`、`sql_generation`、`sql_regenerate`、`renderer_rule`、`executor_rule`
- 创建时间：2026-06-17 06:54:46
- 更新时间：2026-06-17 09:42:40

**规则内容**

款项性质比例、已回款比例、支付状态结论是应收实时的派生口径。款项性质比例：从付款条件描述 Z_TERM_TEXT 中提取。Z_TERM_TEXT 通常形如“预付款 10.000%;投料款/提货款 30.000%;到货款 55.000% 90天;质保金 5.000% 18个月”，先按分号拆分付款阶段，再用款项性质 KXXZ 匹配对应阶段名称；阶段名称含“/”时，任一名称命中都算匹配；命中后提取该阶段中百分号前的数字作为款项性质比例。已回款比例：已回款金额 Z_RE_AMOUNT / 发货金额 Z_DE_AMOUNT * 100，按百分数字符串输出；SQL 应写成 CASE WHEN Z_DE_AMOUNT IS NULL OR Z_DE_AMOUNT = 0 THEN NULL ELSE CONCAT(ROUND(Z_RE_AMOUNT / Z_DE_AMOUNT * 100, 2), '%') END AS 已回款比例。发货金额为空或为 0 时，已回款比例为空或不可计算。支付状态结论：按未拼接百分号前的数值判断，大于等于 100 为“已足额支付”；0 < 数值 < 100 为“部分支付”；数值 = 0 或已回款金额为 0 为“未支付”。
## 8. 应收实时默认必须输出字段

- ID：100320001
- 模型：六大往来管口（100040001）
- 类型：logic_text
- 关联表：`["accounts_receivable_realtime"]`
- 优先级：100
- 注入阶段：`planner_policy`、`sql_generation`、`executor_rule`、`sql_decomposition`、`sql_regenerate`、`sql_followup`、`renderer_rule`
- 创建时间：2026-07-10 10:18:31
- 更新时间：2026-07-14 02:40:47

**规则内容**

所有回答都必须先输出应收余额汇总 SUM(YSYE)，不得默认筛选 YSYE > 0。

除全量字段问询外，还必须依次输出两个结果表，严禁遗漏：

一、订单汇总口径表（表名需包含客户名称）

必须按以下顺序输出字段：

1. 销售代表处描述（BEZEI）
2. 销售代表描述（VKGRP_T）
3. 客户名称（NAME1）
4. 销售订单号（VBELN）
5. 工程项目名称（BSTKD_E）
6. 付款条件文本（Z_TERM_CODE）
7. 合同总价（KZWI1）
8. 款项性质（KXXZ）
9. 欠款性质（Z_QKXZ）
10. 款项是否明确（ZKXSFMQ）
11. 发货金额（Z_DE_AMOUNT）
12. 到货日期（Z_AR_DATE）
13. 已开发票金额（Z_IN_AMOUNT）
14. 已回款金额（Z_RE_AMOUNT）
15. 已回款比例（派生字段）
16. 未解付票据金额（ZCBBA）
17. 未解付票据到期时间（ZCBDT）
18. 预收款（Z_AD_AMOUNT）
19. 应收余额（YSYE）
20. 当时逾期总额（DSYQZE）
21. 欠款比例（分批次应收余额/合同已发货总额，Z_DB_RATE_2）
22. 实际逾期总额（ZSJZE）
23. 实际逾期比例（ZZB）
24. 逾期天数（TS）
25. 付款所需手续（ZFKSXSX）

二、交货单/分批次明细口径表（表名需包含销售订单号）

必须按以下顺序输出字段：

1. 销售代表处描述（BEZEI）
2. 销售代表描述（VKGRP_T）
3. 客户名称（NAME1）
4. 销售订单号（VBELN）
5. 工程项目名称（BSTKD_E）
6. 付款条件文本（Z_TERM_CODE）
7. 付款条件描述（Z_TERM_TEXT）
8. 质保期备注（Z_Z003_TEXT）
9. 合同总价（KZWI1）
10. 交货单号（Z_XBLNR）
11. 款项性质（KXXZ）
12. 欠款性质（Z_QKXZ）
13. 款项是否明确（ZKXSFMQ）
14. 发货金额（Z_DE_AMOUNT）
15. 到货日期（Z_AR_DATE）
16. 已开发票时间（Z_IN_DAT）
17. 已开发票金额（Z_IN_AMOUNT）
18. 已回款时间（Z_RE_DAT）
19. 已回款金额（Z_RE_AMOUNT）
20. 已回款比例（派生字段）
21. 未解付票据金额（ZCBBA）
22. 未解付票据到期时间（ZCBDT）
23. 预收款（Z_AD_AMOUNT）
24. 应收余额（YSYE）
25. 当时逾期总额（DSYQZE）
26. 欠款比例（分批次应收余额/对应分批次发货金额，Z_DB_RATE_1）
27. 欠款性质（按交货单，Z_QKXZ_C）
28. 实际到期日（ZSJFBDT）
29. 实际逾期总额（ZSJZE）
30. 实际逾期比例（ZZB）
31. 逾期天数（TS）
32. 付款所需手续（ZFKSXSX）

两个表的 WHERE 条件均根据用户给出的销售订单号、客户名称或其他明确条件动态生成。

已回款比例统一按 CASE WHEN Z_DE_AMOUNT IS NULL OR Z_DE_AMOUNT = 0 THEN NULL ELSE CONCAT(ROUND(Z_RE_AMOUNT / Z_DE_AMOUNT * 100, 2), '%') END 计算和展示。
## 9. 应收类行业与订单规则

- ID：100180008
- 模型：六大往来管口（100040001）
- 类型：logic_text
- 关联表：`["accounts_receivable_realtime", "receivable_monthly", "receivable_monthly_other", "receivable_other_realtime"]`
- 优先级：6
- 注入阶段：`planner_policy`、`sql_generation`、`sql_regenerate`、`sql_decomposition`
- 创建时间：2026-06-17 03:55:13
- 更新时间：2026-06-17 03:59:44

**规则内容**

订单或销售凭证字段为 VBELN；用户问订单明细时按 VBELN 聚合输出。客户行业字段为 IND_SECTOR；订单行业或项目所属行业字段为 KVGR1。项目对应行业、用户行业、最终用户行业优先使用 ZENDUSER；若当前表无 ZENDUSER，再按问题选择 IND_SECTOR 或 KVGR1。
## 10. 强制输出

- ID：100230002
- 模型：六大往来管口（100040001）
- 类型：logic_text
- 关联表：`["accounts_payable", "accounts_receivable_realtime", "advance_payments", "advance_receipts", "other_payable", "receivable_monthly_other"]`
- 优先级：100
- 注入阶段：`planner_policy`、`sql_generation`、`sql_followup`、`sql_regenerate`、`sql_decomposition`、`executor_rule`、`renderer_rule`
- 创建时间：2026-06-27 04:15:10
- 更新时间：2026-06-27 15:06:56

**规则内容**

所有问题都必须输出以下信息，强制执行：统计截止至【时间】，为【XX客户】尚未支付的欠款金额。若客户存在本月已支付尚未入账的款项，请等待入账，稍后再次查询。

务必注意：这个时间为问询日期的前一天，例如今天是2026年6月25，那么回答就要输出为2026年6月24，因为数据是更新到前一天的
## 11. 编码查询与补零规则

- ID：100180009
- 模型：六大往来管口（100040001）
- 类型：logic_text
- 关联表：`["accounts_receivable_realtime", "receivable_monthly", "receivable_monthly_other", "receivable_other_realtime", "accounts_payable", "other_payable", "advance_receipts", "advance_payments"]`
- 优先级：6
- 注入阶段：`planner_policy`、`sql_generation`、`sql_regenerate`
- 创建时间：2026-06-17 03:55:13
- 更新时间：2026-06-17 03:59:44

**规则内容**

用户询问某个客户编码、供应商编码、客户名称、供应商名称、订单号或利润中心编号时，查询结果需要去重。客户号或供应商号不足 10 位时，按 10 位前置补 0 后再匹配，例如 1001586 应按 0001001586 查找。
## 12. 聚合TopN与合计规则

- ID：100180006
- 模型：六大往来管口（100040001）
- 类型：logic_text
- 关联表：`["accounts_receivable_realtime", "receivable_monthly", "receivable_monthly_other", "receivable_other_realtime", "accounts_payable", "other_payable", "advance_receipts", "advance_payments"]`
- 优先级：8
- 注入阶段：`planner_policy`、`sql_generation`、`sql_regenerate`、`sql_decomposition`、`sql_followup`、`executor_rule`
- 创建时间：2026-06-17 03:55:13
- 更新时间：2026-06-17 03:59:44

**规则内容**

涉及金额、余额、逾期、TopN、排名、前X客户、前X供应商、最大、最多、汇总、总额时，必须先按用户关心的业务主体聚合，再排序或计算占比。金额类结果默认给合计数。除非用户明确要求明细、单据、凭证、行项目或流水，否则不要直接输出原始明细行。
## 13. 订单明细

- ID：100360002
- 模型：六大往来管口（100040001）
- 类型：logic_text
- 关联表：`["accounts_receivable_realtime"]`
- 优先级：10
- 注入阶段：`planner_policy`、`sql_generation`、`sql_regenerate`、`executor_rule`、`renderer_rule`
- 创建时间：2026-07-13 10:19:21
- 更新时间：2026-07-14 02:40:47

**规则内容**

除全量字段问询外，所有回答都必须输出订单汇总口径表。

订单汇总口径必须按以下顺序输出字段：

1. 销售代表处描述（BEZEI）
2. 销售代表描述（VKGRP_T）
3. 客户名称（NAME1）
4. 销售订单号（VBELN）
5. 工程项目名称（BSTKD_E）
6. 付款条件文本（Z_TERM_CODE）
7. 合同总价（KZWI1）
8. 款项性质（KXXZ）
9. 欠款性质（Z_QKXZ）
10. 款项是否明确（ZKXSFMQ）
11. 发货金额（Z_DE_AMOUNT）
12. 到货日期（Z_AR_DATE）
13. 已开发票金额（Z_IN_AMOUNT）
14. 已回款金额（Z_RE_AMOUNT）
15. 已回款比例（派生字段）
16. 未解付票据金额（ZCBBA）
17. 未解付票据到期时间（ZCBDT）
18. 预收款（Z_AD_AMOUNT）
19. 应收余额（YSYE）
20. 当时逾期总额（DSYQZE）
21. 欠款比例（分批次应收余额/合同已发货总额，Z_DB_RATE_2）
22. 实际逾期总额（ZSJZE）
23. 实际逾期比例（ZZB）
24. 逾期天数（TS）
25. 付款所需手续（ZFKSXSX）

WHERE 条件根据用户给出的销售订单号、客户名称或其他明确条件动态生成。

已回款比例统一按 CASE WHEN Z_DE_AMOUNT IS NULL OR Z_DE_AMOUNT = 0 THEN NULL ELSE CONCAT(ROUND(Z_RE_AMOUNT / Z_DE_AMOUNT * 100, 2), '%') END 计算和展示。
## 14. 通用维度字段

- ID：100180007
- 模型：六大往来管口（100040001）
- 类型：logic_text
- 关联表：`["accounts_receivable_realtime", "receivable_monthly", "receivable_monthly_other", "receivable_other_realtime", "accounts_payable", "other_payable", "advance_receipts", "advance_payments"]`
- 优先级：7
- 注入阶段：`planner_policy`、`sql_generation`、`sql_regenerate`、`sql_decomposition`
- 创建时间：2026-06-17 03:55:13
- 更新时间：2026-06-17 03:59:44

**规则内容**

公司使用 cbukrs、cbuktx；利润中心使用 PRCTR、KTEXT；清洗后利润中心字段 cprctr、cprctx 仅在用户明确要求清洗后口径时使用。用户问利润中心时优先输出 PRCTR 和 KTEXT。
## 15. 聚合输出粒度规则

- ID：100130001
- 模型：全局知识库（40037）
- 类型：logic_text
- 关联表：`["accounts_payable", "accounts_receivable_realtime", "advance_payments", "advance_receipts", "asset_allocation_ratio", "asset_ledger", "balance_analysis", "bill_received", "bill_unreceived", "bpc_consolidated_report", "building_info", "capacity", "commodity_price", "electricity_bill_detail", "electricity_bill_summary", "expense_detail_voucher", "fund_flow", "inventory_aging_pc", "inventory_pc", "land_info", "logistics", "main_business_unit", "main_companies", "material_backlog", "material_detail", "open_orders_result", "other_payable", "output_amount_lg", "output_value_lg", "output_value_pc", "payment_collection", "product_cost_analysis", "purchase_order", "purchase_receipt_bm", "purchase_receipt_cn", "quality_loss_report", "receivable_monthly", "revenue_cost", "sales_orders_result", "sales_vat_invoice", "staff_info", "tax_ledger", "utility_info", "vat_sales_invoice", "采购入库大表", "采购入库大表-海外", "采购入库大表-海外上传"]`
- 优先级：100
- 注入阶段：`planner_policy`、`sql_generation`、`sql_decomposition`、`sql_regenerate`、`sql_followup`、`executor_rule`
- 创建时间：2026-06-15 02:50:50
- 更新时间：2026-06-15 02:50:50

**规则内容**

当用户问题询问“有哪些、哪些、最高、最多、最大、排名、Top、汇总、总额、消耗最高”等结果时，必须先判断用户关心的业务主体，并按该主体聚合输出。

除非用户明确要求“明细、每条记录、凭证、行项目、流水、单据明细”，否则不要按原始明细记录逐条输出。

### 常见聚合主体

- 问“有哪些供应商”：按供应商聚合，每个供应商只输出一行。
- 问“哪些客户”：按客户聚合，每个客户只输出一行。
- 问“哪些物料”：按物料号、物料描述聚合，每个物料只输出一行。
- 问“消耗最高的物料”：按物料号聚合后，对消耗金额或消耗数量求和，再排序。
- 问“费用最高的部门”：按部门聚合后，对费用金额求和，再排序。
- 问“收入最高的产品”：按产品聚合后，对收入金额求和，再排序。

### SQL 生成要求

如果问题是聚合问题，SELECT 中不要直接输出明细字段，例如凭证号、行项目、单据号、批次号、日期明细等，除非用户明确要求。

聚合查询必须使用：
- `GROUP BY` 聚合主体字段
- `SUM` / `COUNT` / `MAX` / `MIN` 等聚合函数
- 如涉及“最高、最多、最大”，必须配合 `ORDER BY 聚合值 DESC`
