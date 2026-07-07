-- 单据回款表建表语句
-- 数据来源：jst_flat_table.payment_collection（zuonr, bldat, wsl, osl）
-- 欠款金额取数逻辑：jst_flat_table.vat_sales_invoice.ZSAPAMT汇总 - 回款金额wsl汇总，通过 VBELN = zuonr 关联
-- 合同欠款金额取数逻辑：ods_s4.t_s4_performance.HTZJE - 回款金额wsl汇总，通过 VBELN = zuonr 关联
CREATE TABLE IF NOT EXISTS jst_flat.bill_collection (
    VBELN                VARCHAR(255)   COMMENT '销售订单号',
    rbukrs               VARCHAR(255)   COMMENT '公司代码',
    belnr                VARCHAR(255)   COMMENT '会计凭证',
    bldat                VARCHAR(255)   COMMENT '凭证日期',
    wsl                  DECIMAL(23,2)  COMMENT '以交易货币计的金额',
    rwcur                VARCHAR(255)   COMMENT '交易货币',
    debt_amount          DECIMAL(23,2)  COMMENT '欠款金额',
    contract_debt_amount DECIMAL(23,2)  COMMENT '合同欠款金额'
) COMMENT='单据回款';
