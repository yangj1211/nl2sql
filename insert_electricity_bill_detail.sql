-- ============================================================
-- 将电费明细数据插入 electricity_bill_detail 明细表
-- 主表: DWD_S4_ZTBW_JTNHDLTJBMX (电费明细)
-- 关联表: DWD_BW_ZTBPC002_COM (公司代码映射，用于获取清洗后的公司代码和描述)
-- ============================================================

INSERT INTO jst_flat.electricity_bill_detail (
  bukrs, cbukrs, cbuktx,
  gjahr, monat, zbh, zydxz, zjd,
  capacity1, capacity2, capacity3
)
SELECT
  t.bukrs,
  c.cbukrs,
  c.cbuktx,
  t.gjahr,
  t.monat,
  t.zbh,
  t.zydxz,
  t.zjd,
  t.capacity1,
  t.capacity2,
  t.capacity3

-- 主表: 电费明细
FROM dwd_dcp.DWD_S4_ZTBW_JTNHDLTJBMX t

-- 关联: 公司代码映射表
-- 关联条件: 主表公司代码 = 映射表源公司代码
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_COM c
  ON t.bukrs = c.sbukrs;
