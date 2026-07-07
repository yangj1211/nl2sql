-- 资产台账分摊比例表

CREATE TABLE IF NOT EXISTS jst_flat.asset_allocation_ratio (
    `期间开始`                    VARCHAR(255)    COMMENT '期间开始',
    `期间截止`                    VARCHAR(255)    COMMENT '期间截止',
    `公司代码`                    VARCHAR(255)    COMMENT '公司代码',
    `新资产号`                    VARCHAR(255)    COMMENT '新资产号',
    `资产名称`                    VARCHAR(255)    COMMENT '资产名称',
    `接受方（拆分成本中心）`      VARCHAR(255)    COMMENT '接受方（拆分成本中心）',
    `拆分成本中心名称`            VARCHAR(255)    COMMENT '拆分成本中心名称',
    `占比`                        DECIMAL(38,6)   COMMENT '占比'
) COMMENT '资产台账分摊比例表';
