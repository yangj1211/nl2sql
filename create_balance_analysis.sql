CREATE TABLE IF NOT EXISTS jst_flat.balance_analysis (
    bank_acc     VARCHAR(255)   COMMENT '银行账号',
    acc_name     VARCHAR(255)   COMMENT '账户名称',
    corp_id      VARCHAR(255)   COMMENT '单位ID',
    code         VARCHAR(255)   COMMENT '公司代码',
    cbukrs       VARCHAR(255)   COMMENT '公司代码（清洗后）',
    cbuktx       VARCHAR(255)   COMMENT '公司描述（清洗后）',
    bank_name    VARCHAR(255)   COMMENT '开户行名称',
    type_name    VARCHAR(255)   COMMENT '账户类别',
    nature_name  VARCHAR(255)   COMMENT '账户性质',
    cur_name     VARCHAR(255)   COMMENT '币别',
    get_date     DATETIME       COMMENT '获取时间',
    bal_date     DATETIME       COMMENT '余额日期',
    bal          DECIMAL(19,2)  COMMENT '余额',
    avail_bal    DECIMAL(19,2)  COMMENT '可用余额',
    frz_bal      DECIMAL(19,2)  COMMENT '冻结金额',
    status       DECIMAL(10,0)  COMMENT '状态'
) COMMENT='资金分析（余额）';
