-- ============================================================
-- 预收账款（管口）- 建表
-- 目标表：jst_flat.advance_receipts
-- 底表：sap_data.ZRFIPA_99991231 (中国S4)
-- ============================================================

DROP TABLE IF EXISTS jst_flat.advance_receipts;

CREATE TABLE jst_flat.advance_receipts (
  BUKRS        VARCHAR(255)   COMMENT '公司代码',
  cbukrs       VARCHAR(255)   COMMENT '公司代码（清洗后）',
  cbuktx       VARCHAR(255)   COMMENT '公司描述（清洗后）',
  DMBTR_SUM    DECIMAL(38,2)  COMMENT '预收总额',
  DMBTR_Z1     DECIMAL(38,2)  COMMENT '预收额0-90天',
  DMBTR_Z2     DECIMAL(38,2)  COMMENT '预收额91-180天',
  DMBTR_Z3     DECIMAL(38,2)  COMMENT '预收额181-365天',
  DMBTR_Z4     DECIMAL(38,2)  COMMENT '预收额1-2年',
  DMBTR_Z7     DECIMAL(38,2)  COMMENT '预收额2-3年',
  DMBTR_Z8     DECIMAL(38,2)  COMMENT '预收额3-4年',
  DMBTR_Z9     DECIMAL(38,2)  COMMENT '预收额4-5年',
  DMBTR_Z10    DECIMAL(38,2)  COMMENT '预收额5年以上',
  KUNNR        VARCHAR(255)   COMMENT '客户代码',
  NAME1        VARCHAR(255)   COMMENT '客户名称',
  VKBUR        VARCHAR(255)   COMMENT '销售代表处',
  VKBUR_BEZEI  VARCHAR(255)   COMMENT '销售代表处描述',
  dept_id      VARCHAR(255)   COMMENT '部门编码',
  dept_name    VARCHAR(255)   COMMENT '部门名称',
  VKGRP        VARCHAR(255)   COMMENT '销售员',
  BEZEI        VARCHAR(255)   COMMENT '销售员名称',
  PRCTR        VARCHAR(255)   COMMENT '利润中心',
  cprctr       VARCHAR(255)   COMMENT '利润中心（清洗后）',
  cprctx       VARCHAR(255)   COMMENT '利润中心描述（清洗后）',
  DESCRIPT     VARCHAR(255)   COMMENT '利润中心组描述',
  HKONT        VARCHAR(255)   COMMENT '会计科目',
  TXT50        VARCHAR(255)   COMMENT '会计科目描述',
  KHINR        VARCHAR(255)   COMMENT '利润中心组',
  BZIRK        VARCHAR(255)   COMMENT '销售区域',
  BZIRK_BZTXT  VARCHAR(255)   COMMENT '销售区域描述',
  KTEXT        VARCHAR(255)   COMMENT '利润中心描述'
) COMMENT='预收账款（管口）';
