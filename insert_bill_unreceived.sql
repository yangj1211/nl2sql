-- ============================================
-- 目标表：jst_flat.bill_unreceived（资金流水-汇票（未签收））
-- 源表：dwd_dcp.DWD_BT_ab_bill_receivebiz (汇票签收业务表, a)
--       dwd_dcp.dwd_bt_sys_corp            (单位表, c)
-- 去重：相同 orig_no（票据号）按 bussdt 取最新一条
-- ============================================

TRUNCATE TABLE jst_flat.bill_unreceived;

INSERT INTO jst_flat.bill_unreceived (
    msgtype, orig_no, bill_type, start_date, end_date, bill_money,
    payee, payer, acceptor, cdtratgs, bussdt, req_nm, status,
    payer_bank_name, acceptor_bank_name,
    sbbll_rng_strt_sn, sbbll_rng_end_sn, rec_acct_type_name,
    rec_nm, corp_name
)
SELECT
    msgtype,
    orig_no,
    bill_type,
    start_date,
    end_date,
    bill_money,
    payee,
    payer,
    acceptor,
    cdtratgs,
    bussdt,
    req_nm,
    status,
    payer_bank_name,
    acceptor_bank_name,
    sbbll_rng_strt_sn,
    sbbll_rng_end_sn,
    rec_acct_type_name,
    rec_nm,
    corp_name
FROM (
    SELECT
        -- msgtype: 代码 → 中文
        CASE a.msgtype
            WHEN '017' THEN '提示保证'
            WHEN '002' THEN '提示承兑'
            WHEN '003' THEN '提示收票'
            WHEN '010' THEN '背书申请'
            WHEN '012' THEN '回购式贴现赎回'
            WHEN '018' THEN '质押申请'
            WHEN '019' THEN '质押解除'
            WHEN '020' THEN '提示付款'
            WHEN '021' THEN '逾期付款'
            WHEN '022' THEN '追索通知'
            WHEN '023' THEN '追索同意清偿'
            ELSE a.msgtype
        END AS msgtype,
        a.orig_no,
        -- bill_type: 代码 → 中文
        CASE a.bill_type
            WHEN '10' THEN '银票'
            WHEN '11' THEN '商票'
            WHEN '12' THEN '第三方票据'
            WHEN '13' THEN '债权凭证'
            ELSE a.bill_type
        END AS bill_type,
        a.start_date,
        a.end_date,
        a.bill_money,
        a.payee,
        a.payer,
        a.acceptor,
        a.cdtratgs,
        a.bussdt,
        a.req_nm,
        -- status: 代码 → 中文
        CASE a.status
            WHEN '18' THEN '待签收'
            WHEN '19' THEN '签收成功'
            WHEN '-2' THEN '打回'
            WHEN '-3' THEN '撤回'
            ELSE a.status
        END AS status,
        a.payer_bank_name,
        a.acceptor_bank_name,
        a.sbbll_rng_strt_sn,
        a.sbbll_rng_end_sn,
        a.rec_acct_type_name,
        a.rec_nm,
        c.name AS corp_name,
        ROW_NUMBER() OVER (PARTITION BY a.orig_no ORDER BY a.bussdt DESC) AS rn
    FROM dwd_dcp.DWD_BT_ab_bill_receivebiz a
    LEFT JOIN dwd_dcp.dwd_bt_sys_corp c ON a.rec_corp_id = c.id
) t
WHERE rn = 1;
