-- ============================================================
-- 应付账款（管口）- 建表
-- 目标表：jst_flat.accounts_payable
-- 底表：sap_data.zfiryffx_99991231YFZK (中国S4)
-- ============================================================

DROP TABLE IF EXISTS jst_flat.accounts_payable;

CREATE TABLE jst_flat.accounts_payable (
  BUKRS        VARCHAR(255)   COMMENT '公司代码',
  cbukrs       VARCHAR(255)   COMMENT '公司代码（清洗后）',
  cbuktx       VARCHAR(255)   COMMENT '公司描述（清洗后）',
  LIFNR        VARCHAR(255)   COMMENT '供应商',
  NAME1        VARCHAR(255)   COMMENT '供应商名称',
  HKONT        VARCHAR(255)   COMMENT '会计科目',
  TXT50        VARCHAR(255)   COMMENT '会计科目描述',
  KHINR        VARCHAR(255)   COMMENT '利润中心组',
  DESCRIPT     VARCHAR(255)   COMMENT '利润中心组描述',
  PRCTR        VARCHAR(255)   COMMENT '利润中心',
  cprctr       VARCHAR(255)   COMMENT '利润中心（清洗后）',
  cprctx       VARCHAR(255)   COMMENT '利润中心描述（清洗后）',
  KTEXT        VARCHAR(255)   COMMENT '利润中心描述',
  DMBTR_SUM    DECIMAL(38,2)  COMMENT '当时应付总额',
  DMBTR_Z1     DECIMAL(38,2)  COMMENT '应付额0-90天',
  DMBTR_Z2     DECIMAL(38,2)  COMMENT '应付额91-180天',
  DMBTR_Z3     DECIMAL(38,2)  COMMENT '应付额181-365天',
  DMBTR_Z4     DECIMAL(38,2)  COMMENT '应付额1-2年',
  DMBTR_Z7     DECIMAL(38,2)  COMMENT '应付额2-3年',
  DMBTR_Z8     DECIMAL(38,2)  COMMENT '应付额3-4年',
  DMBTR_Z9     DECIMAL(38,2)  COMMENT '应付额4-5年',
  DMBTR_Z10    DECIMAL(38,2)  COMMENT '应付额5年以上',
  DMBTR_SUM_YQ DECIMAL(38,2)  COMMENT '当时逾期总额',
  YQYS_RATE    DECIMAL(38,2)  COMMENT '逾期帐款占应收帐款比率',
  DMBTR_F1     DECIMAL(38,2)  COMMENT '逾期额0-90天',
  DMBTR_F2     DECIMAL(38,2)  COMMENT '逾期额90-180天',
  DMBTR_F3     DECIMAL(38,2)  COMMENT '逾期额180-365天',
  DMBTR_F4     DECIMAL(38,2)  COMMENT '逾期额1-2年',
  DMBTR_F7     DECIMAL(38,2)  COMMENT '逾期额2-3年',
  DMBTR_F8     DECIMAL(38,2)  COMMENT '逾期额3-4年',
  DMBTR_F9     DECIMAL(38,2)  COMMENT '逾期额4-5年',
  DMBTR_F10    DECIMAL(38,2)  COMMENT '逾期额5年以上'
) COMMENT='应付账款（管口）';
