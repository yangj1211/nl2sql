-- ============================================================
-- 将电费数据插入 electricity_bill_summary 汇总表
-- 主表: DWD_S4_ZTBW_JTNHDLTJB (电费明细，含基地字段 zjd)
-- 关联表: DWD_BW_ZTBPC002_COM (公司代码映射，用于获取清洗后的公司代码和描述)
-- ============================================================

INSERT INTO jst_flat.electricity_bill_summary (
  bukrs, cbukrs, cbuktx,
  gjahr, monat, name1,
  wrbtr, wrbtr1, werks, wrbtr2,
  werks1, werks2, werks3,
  wrbtr3, wrbtr4, wrbtr5,
  werks5, srsq,
  wrbtr6, wrbtr7, wrbtr8, wrbtr9,
  bezei20
)
SELECT
  t.bukrs,
  c.cbukrs,
  c.cbuktx,
  t.gjahr,
  t.monat,
  t.name1,
  t.wrbtr,
  t.wrbtr1,
  t.werks,
  t.wrbtr2,
  t.werks1,
  t.werks2,
  t.werks3,
  t.wrbtr3,
  t.wrbtr4,
  t.wrbtr5,
  t.werks5,
  t.srsq,
  t.wrbtr6,
  t.wrbtr7,
  t.wrbtr8,
  t.wrbtr9,
  t.zjd

-- 主表: 电费明细
FROM dwd_dcp.DWD_S4_ZTBW_JTNHDLTJB t

-- 关联: 公司代码映射表
-- 关联条件: 主表公司代码 = 映射表源公司代码
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_COM c
  ON t.bukrs = c.sbukrs;
