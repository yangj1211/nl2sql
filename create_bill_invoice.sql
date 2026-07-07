-- 单据发票表建表语句
-- 数据来源：ods_s4.t_s4_performance（VBELN, ZGTCD, ZGTID, ZOPDT, ZVATSL, ZOPAMT）
CREATE TABLE IF NOT EXISTS jst_flat.bill_invoice (
    VBELN    VARCHAR(255)   COMMENT '销售订单号',
    ZGTCD    VARCHAR(255)   COMMENT 'VAT发票代码',
    ZGTID    VARCHAR(255)   COMMENT 'VAT发票号',
    ZOPDT    VARCHAR(255)    COMMENT 'VAT发票时间',
    ZVATSL   VARCHAR(255)   COMMENT 'VAT发票税率',
    ZOPAMT   DECIMAL(38,2)  COMMENT 'VAT发票金额'
) COMMENT='单据发票';
