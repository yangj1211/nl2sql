-- =============================================
-- vat销售发票表 数据插入
-- 目标表: jst_flat.vat_sales_invoice
-- 基表:   sap_data.zfi0079_99991231
-- =============================================
-- 关联逻辑:
--   LEFT JOIN dwd_dcp.DWD_S4_VBKD v
--     ON t.VBELN = v.vbeln AND v.posnr = '000000'
--   取 v.bstdk 作为合同签订日期(BSTDK)
--   posnr='000000' 表示取抬头级别数据
--   LEFT JOIN staging_db.sales_office_mapping m
--     ON t.BEZEK = m.sales_office_desc
--   取 m.dept_id / m.dept_name 作为部门编码/名称
-- =============================================
TRUNCATE TABLE jst_flat.vat_sales_invoice;

INSERT INTO jst_flat.vat_sales_invoice (
    CMPFLAG, VBELN, ZUONR, KVGR4, BEZEK, dept_id, dept_name, BEZEI, KUNNR, NAME1,
    KZWI1, BSTKD_E, BSTKD, BUDAT, FVBELN, FKART, FKDAT, ZSAPAMT,
    WAERK, CURWR, ZSAPSL, ZGTCD, ZGTID, ZSRNO, ZOPDT, ZOPAMT,
    ZOPCAT, ZOPUNIT, ZCBRN, ZADDR1, ZADDR2, ZADDR3, ZADDR4,
    TSSQYYSM, ZVATSL, SUBAMT1, SUBAMT2, ZSJCY, KUNRG, NAME2,
    ZTERM, TEXT1, VKORG, BUKRS, HKMEM, FIMEM, BEIZ, TEXT2, WERKS,
    BSTDK
)
SELECT
    t.CMPFLAG, t.VBELN, t.ZUONR, t.KVGR4, t.BEZEK, m.dept_id, m.dept_name, t.BEZEI, t.KUNNR, t.NAME1,
    t.KZWI1, t.BSTKD_E, t.BSTKD, t.BUDAT, t.FVBELN, t.FKART, t.FKDAT, t.ZSAPAMT,
    t.WAERK, t.CURWR, t.ZSAPSL, t.ZGTCD, t.ZGTID, t.ZSRNO, t.ZOPDT, t.ZOPAMT,
    t.ZOPCAT, t.ZOPUNIT, t.ZCBRN, t.ZADDR1, t.ZADDR2, t.ZADDR3, t.ZADDR4,
    t.TSSQYYSM, t.ZVATSL, t.SUBAMT1, t.SUBAMT2, t.ZSJCY, t.KUNRG, t.NAME2,
    t.ZTERM, t.TEXT1, t.VKORG, t.BUKRS, t.HKMEM, t.FIMEM, t.BEIZ, t.TEXT2, t.WERKS,
    v.bstdk AS BSTDK              -- 合同签订日期: DWD_S4_VBKD.bstdk, 条件 posnr='000000'(抬头级)
FROM sap_data.zfi0079_99991231 t
-- 关联销售凭证业务数据表，取合同签订日期(bstdk)，posnr='000000'为抬头级
LEFT JOIN dwd_dcp.DWD_S4_VBKD v
    ON t.VBELN = v.vbeln AND v.posnr = '000000'
LEFT JOIN staging_db.sales_office_mapping m
    ON t.BEZEK = m.sales_office_desc;
