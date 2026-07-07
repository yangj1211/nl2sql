-- ============================================
-- 目标表：jst_flat.fund_flow（资金流水-转账）
-- 源表：dwd_dcp.dwd_bt_bis_acc_dtl（银企直连交易明细）
-- ============================================
INSERT INTO jst_flat.fund_flow (
    bank_acc, acc_name, bank_name,
    opp_acc_no, opp_acc_name, opp_acc_bank,
    cd_sign, amt, uses, trans_time, voucher_no,
    code, cbukrs, cbuktx
)
SELECT
    a.bank_acc,                -- 本方账号
    a.acc_name,                -- 本方账户名
    a.bank_name,               -- 本方账户开户行
    a.opp_acc_no,              -- 对方账号
    a.opp_acc_name,            -- 对方账户名
    a.opp_acc_bank,            -- 对方账户开户行
    '收入' AS cd_sign,          -- 借贷标志：仅保留cd_sign='0'并转译为"收入"
    a.amt,                     -- 交易金额
    a.uses,                    -- 用途
    a.trans_time,              -- 交易时间
    a.voucher_no,              -- 企业流水号
    c.code,                    -- 公司代码：通过 bank_acc 关联 dwd_bt_bank_acc 取 corp_id，再关联 dwd_bt_sys_corp 取 code
    d.cbukrs,                  -- 公司代码（清洗后）：通过 dwd_bt_sys_corp.code 关联 DWD_BW_ZTBPC002_COM.sbukrs 取 cbukrs
    d.cbuktx                   -- 公司描述（清洗后）：通过 dwd_bt_sys_corp.code 关联 DWD_BW_ZTBPC002_COM.sbukrs 取 cbuktx
FROM dwd_dcp.dwd_bt_bis_acc_dtl a
-- 关联银行账户表，通过本方账号取单位ID
LEFT JOIN dwd_dcp.dwd_bt_bank_acc b ON a.bank_acc = b.bank_acc
-- 关联单位表，通过单位ID取公司代码
LEFT JOIN dwd_dcp.dwd_bt_sys_corp c ON b.corp_id = c.id
-- 关联公司代码映射表，通过公司代码取清洗后的合并单元及描述
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_COM d ON c.code = d.sbukrs
-- 过滤条件：
-- 1. 对方账户名超过4个字 → 公对公转账（排除个人打款，个人姓名通常2~4个字）
-- 2. 借贷标志为'0' → 仅保留收入类交易
WHERE CHAR_LENGTH(a.opp_acc_name) > 4
  AND a.cd_sign = '0';
