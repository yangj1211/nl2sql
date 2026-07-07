CREATE TABLE IF NOT EXISTS jst_flat_table.staff_info (
    zxzyf   VARCHAR(255) COMMENT '薪资月份',
    zygdm   VARCHAR(255) COMMENT '员工代码',
    zygxm   VARCHAR(255) COMMENT '员工姓名',
    zssgs   VARCHAR(255) COMMENT '所属公司',
    zzwmc   VARCHAR(255) COMMENT '职务名称',
    zgwmc   VARCHAR(255) COMMENT '岗位名称',
    zygz    VARCHAR(255) COMMENT '员工组',
    zbmdm   VARCHAR(255) COMMENT '部门代码',
    zbmmc   VARCHAR(255) COMMENT '部门名称',
    employment_status VARCHAR(255) COMMENT '离职状态',
    kostl   VARCHAR(255) COMMENT '成本中心代码',
    prctr   VARCHAR(255) COMMENT '利润中心',
    cprctr  VARCHAR(255) COMMENT '利润中心（清洗后）',
    cprctx  VARCHAR(255) COMMENT '利润中心（清洗后）描述',
    labor_cost DECIMAL(23,2) COMMENT '人工成本-人力'
) COMMENT '员工信息表';
