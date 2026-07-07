CREATE TABLE IF NOT EXISTS jst_flat.fund_flow (
    bank_acc     VARCHAR(255)   COMMENT '本方账号',
    acc_name     VARCHAR(255)   COMMENT '本方账户名',
    bank_name    VARCHAR(255)   COMMENT '本方账户开户行',
    opp_acc_no   VARCHAR(255)   COMMENT '对方账号',
    opp_acc_name VARCHAR(255)   COMMENT '对方账户名',
    opp_acc_bank VARCHAR(255)   COMMENT '对方账户开户行',
    cd_sign      VARCHAR(255)   COMMENT '借贷标志',
    amt          DECIMAL(19,2)  COMMENT '交易金额',
    uses         VARCHAR(65535) COMMENT '用途',
    trans_time   DATETIME       COMMENT '交易时间',
    voucher_no   VARCHAR(255)   COMMENT '企业流水号',
    code         VARCHAR(255)   COMMENT '公司代码',
    cbukrs       VARCHAR(255)   COMMENT '公司代码（清洗后）',
    cbuktx       VARCHAR(255)   COMMENT '公司描述（清洗后）'
) COMMENT='资金流水-转账';
