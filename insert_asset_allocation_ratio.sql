-- 资产台账分摊比例表
-- 数据来源: dwd_load.asset_allocation_ratio

INSERT INTO jst_flat_table.asset_allocation_ratio
SELECT
    `期间开始`,
    `期间截止`,
    `公司代码`,
    `新资产号`,
    `资产名称`,
    `接受方（拆分成本中心）`,
    `拆分成本中心名称`,
    `占比`
FROM dwd_load.asset_allocation_ratio;
