-- 单据回款表数据插入
-- 主驱动表：ods_s4.t_s4_performance（按VBELN去重，取头层数据）
-- 一对多展开 jst_flat_table.payment_collection（通过 VBELN = zuonr），取 rbukrs, belnr, bldat, wsl, osl
-- 欠款金额 = SUM(ZSAPAMT) - SUM(wsl)
-- 合同欠款金额 = HTZJE - SUM(wsl)
INSERT INTO jst_flat.bill_collection (
    VBELN,
    rbukrs,
    belnr,
    bldat,
    wsl,
    rwcur,
    debt_amount,
    contract_debt_amount
)
SELECT
    p.VBELN,
    pc.rbukrs,
    pc.belnr,
    pc.bldat,
    -pc.wsl                                    AS wsl,
    pc.rwcur,
    v.total_zsapamt - hk.total_wsl           AS debt_amount,
    p.HTZJE - hk.total_wsl                   AS contract_debt_amount
FROM (
    SELECT VBELN, MAX(HTZJE) AS HTZJE
    FROM ods_s4.t_s4_performance
    GROUP BY VBELN
) p
LEFT JOIN jst_flat_table.payment_collection pc ON pc.zuonr = p.VBELN
LEFT JOIN (
    SELECT zuonr, SUM(-wsl) AS total_wsl
    FROM jst_flat_table.payment_collection
    GROUP BY zuonr
) hk ON hk.zuonr = p.VBELN
LEFT JOIN (
    SELECT VBELN, SUM(ZSAPAMT) AS total_zsapamt
    FROM jst_flat_table.vat_sales_invoice
    GROUP BY VBELN
) v ON v.VBELN = p.VBELN;
