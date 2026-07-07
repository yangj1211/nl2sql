-- ============================================================
-- 预付账款（管口）- 建表
-- 目标表：jst_flat.advance_payments
-- 底表：sap_data.ZFIRYUFFX_99991231 (中国S4)
-- ============================================================

DROP TABLE IF EXISTS jst_flat.advance_payments;

CREATE TABLE jst_flat.advance_payments (
  BUKRS        VARCHAR(255)   COMMENT '公司代码',
  cbukrs       VARCHAR(255)   COMMENT '公司代码（清洗后）',
  cbuktx       VARCHAR(255)   COMMENT '公司描述（清洗后）',
  LIFNR        VARCHAR(255)   COMMENT '供应商',
  KHINR        VARCHAR(255)   COMMENT '利润中心组',
  DESCRIPT     VARCHAR(255)   COMMENT '利润中心组描述',
  PRCTR        VARCHAR(255)   COMMENT '利润中心',
  cprctr       VARCHAR(255)   COMMENT '利润中心（清洗后）',
  cprctx       VARCHAR(255)   COMMENT '利润中心描述（清洗后）',
  KTEXT        VARCHAR(255)   COMMENT '利润中心描述',
  NAME1        VARCHAR(255)   COMMENT '供应商名称',
  HKONT        VARCHAR(255)   COMMENT '会计科目',
  TXT50        VARCHAR(255)   COMMENT '会计科目描述',
  DMBTR_SUM    DECIMAL(38,2)  COMMENT '当时预付总额',
  DMBTR_Z11    DECIMAL(38,2)  COMMENT '预付额0-90天',
  DMBTR_Z12    DECIMAL(38,2)  COMMENT '预付额90-180天',
  DMBTR_Z3     DECIMAL(38,2)  COMMENT '预付额181-365天',
  DMBTR_Z4     DECIMAL(38,2)  COMMENT '预付额1-2年',
  DMBTR_Z7     DECIMAL(38,2)  COMMENT '预付额2-3年',
  DMBTR_Z8     DECIMAL(38,2)  COMMENT '预付额3-4年',
  DMBTR_Z9     DECIMAL(38,2)  COMMENT '预付额4-5年',
  DMBTR_Z10    DECIMAL(38,2)  COMMENT '预付额5年以上'
) COMMENT='预付账款（管口）';
