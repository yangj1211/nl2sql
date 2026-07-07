-- ============================================================
-- 代表处与部门映射表（staging）
-- 数据来源：jst_flat.sales_office_mapping
-- ============================================================

DROP TABLE IF EXISTS staging_db.sales_office_mapping;

CREATE TABLE staging_db.sales_office_mapping AS
SELECT
    sales_office_code,
    sales_office_desc,
    dept_id,
    dept_name
FROM jst_flat.sales_office_mapping;

ALTER TABLE staging_db.sales_office_mapping COMMENT='代表处与部门映射表';
