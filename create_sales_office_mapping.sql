-- ============================================================
-- 代表处与部门映射表
-- 主键：sales_office_code（唯一）
-- 主数据：jst.core_dept（dept_id / dept_name 来自这里）
-- ============================================================

DROP TABLE IF EXISTS jst_flat.sales_office_mapping;

CREATE TABLE jst_flat.sales_office_mapping (
    sales_office_code   VARCHAR(255)    NOT NULL COMMENT '代表处编码',
    sales_office_desc   VARCHAR(255)    NULL     COMMENT '代表处描述',
    dept_id             VARCHAR(255)    NULL     COMMENT '部门编码',
    dept_name           VARCHAR(255)    NULL     COMMENT '部门名称'
) COMMENT '代表处与部门映射表';
