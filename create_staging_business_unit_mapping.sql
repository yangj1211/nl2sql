-- ============================================================
-- 利润中心与部门映射表（staging）
-- 数据来源：jst_flat.business_unit_mapping
-- ============================================================

DROP TABLE IF EXISTS staging_db.business_unit_mapping;

CREATE TABLE staging_db.business_unit_mapping AS
SELECT
    business_unit_id,
    business_unit_desc,
    dept_id,
    dept_name
FROM jst_flat.business_unit_mapping;

ALTER TABLE staging_db.business_unit_mapping COMMENT='利润中心与部门映射表';
