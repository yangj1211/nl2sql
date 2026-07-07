-- 单据发票表数据插入
-- 主驱动表：ods_s4.t_s4_performance（按VBELN去重）
-- VAT发票字段通过 VBELN 关联 jst_flat_table.vat_sales_invoice（一对多展开）
INSERT INTO jst_flat.bill_invoice (
    VBELN,
    ZGTCD,
    ZGTID,
    ZOPDT,
    ZVATSL,
    ZOPAMT
)
SELECT
    p.VBELN,
    v.ZGTCD,
    v.ZGTID,
    v.ZOPDT,
    v.ZVATSL,
    v.ZOPAMT
FROM (
    SELECT DISTINCT VBELN
    FROM ods_s4.t_s4_performance
) p
LEFT JOIN jst_flat_table.vat_sales_invoice v ON v.VBELN = p.VBELN;
