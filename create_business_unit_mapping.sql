-- ============================================================
-- 利润中心与部门映射表
-- 主键：business_unit_id（唯一）
-- 主数据：jst.core_dept（dept_id / dept_name 来自这里）
-- ============================================================

DROP TABLE IF EXISTS jst_flat.business_unit_mapping;

CREATE TABLE jst_flat.business_unit_mapping (
    business_unit_id    VARCHAR(255)    NOT NULL COMMENT '利润中心编码',
    business_unit_desc  VARCHAR(255)    NULL     COMMENT '利润中心描述',
    dept_id             VARCHAR(255)    NULL     COMMENT '部门编码',
    dept_name           VARCHAR(255)    NULL     COMMENT '部门名称'
) COMMENT='利润中心与部门映射表';
