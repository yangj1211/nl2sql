-- ============================================
-- 目标表：jst_flat.bill_received（资金流水-汇票（已签收））
-- 源表：
--   dwd_dcp.dwd_bt_ab_accrecords        (票据流水表, a)
--   dwd_dcp.dwd_bt_ab_voucherinfo       (票据主表, v)
--   dwd_dcp.dwd_bt_ab_voucherinfo_vice  (票据从表, vi)
-- cn_accrecords: 取自 accrecords(a)，有值用 cn_accrecords，否则用 rec_nm
--   dwd_dcp.dwd_bt_sys_corp             (单位表, c)
--   dwd_dcp.DWD_BW_ZTBPC002_COM        (公司映射表, d)
--   dwd_dcp.DWD_BT_ab_brief_status     (业务类型表, bs)
--   dwd_dcp.dwd_bt_sys_dict / dict_group (字典表, 票据类型/流通介质)
-- 筛选条件：
--   vi.type = '1'                        (仅应收票据)
--   a.opt_status = '19'                  (仅业务完成)
--   a.brief_id IN ('9003','6001','9010') (指定业务类型)
-- ============================================
INSERT INTO jst_flat.bill_received (
    orig_no, bill_type, bill_flag, bill_money, start_date, end_date,
    acceptor, new_stm_issuofppr_ind, blgrdbagcrcl_prmt_ind,
    sbbll_rng_strt_sn, sbbll_rng_end_sn, repeat_rec_sign,
    acc_id, acc_vid, acc_vvid, status, opt_status, send_sign, brief_id, business_date,
    vice_id, vice_vid, corp_id, bank_acc, bank_name, cn_accrecords, type,
    code, cbukrs, cbuktx,
    bank_level, jinpan_bill_type, jinpan_bill_code
)
SELECT
    -- ========== 来源：dwd_bt_ab_voucherinfo (票据主表) ==========
    v.orig_no,
    dict_bill_type.type_name,
    dict_bill_flag.type_name,
    v.bill_money,
    v.start_date,
    v.end_date,
    v.acceptor,
    v.new_stm_issuofppr_ind,
    -- blgrdbagcrcl_prmt_ind: 1是0否 → 中文
    CASE v.blgrdbagcrcl_prmt_ind WHEN '1' THEN '是' WHEN '0' THEN '否' END,
    v.sbbll_rng_strt_sn,
    v.sbbll_rng_end_sn,
    -- repeat_rec_sign: 1是0否 → 中文
    CASE v.repeat_rec_sign WHEN 1 THEN '是' WHEN 0 THEN '否' END,

    -- ========== 来源：dwd_bt_ab_accrecords (票据流水表) ==========
    a.id,
    a.vid,
    a.vvid,
    -- status: 数值 → 中文
    CASE
        WHEN a.status = -2 THEN '已删除'
        WHEN a.status = -1 THEN '打回'
        WHEN a.status = 0  THEN '暂存'
        WHEN a.status = 10 THEN '提交'
        WHEN a.status BETWEEN 11 AND 94 THEN '审批中'
        WHEN a.status = 95 THEN '已完成'
        WHEN a.status = 96 THEN '已拆包'
    END,
    -- opt_status: 筛选19，固定转译为"业务完成"
    '业务完成',
    a.send_sign,
    -- brief_id: 关联 DWD_BT_ab_brief_status 取 statusname
    bs.statusname,
    a.business_date,

    -- ========== 来源：dwd_bt_ab_voucherinfo_vice (票据从表) ==========
    vi.id,
    vi.vid,
    -- corp_id: 关联 dwd_bt_sys_corp 取 name
    c.name,
    vi.bank_acc,
    vi.bank_name,
    -- cn_accrecords（前手）：取自 accrecords，有值用 cn_accrecords，否则用 rec_nm
    CASE
        WHEN a.cn_accrecords IS NOT NULL AND TRIM(a.cn_accrecords) != '' THEN a.cn_accrecords
        ELSE a.rec_nm
    END AS cn_accrecords,
    -- type: 0/1 → 中文
    CASE vi.type WHEN '0' THEN '应付票据' WHEN '1' THEN '应收票据' END,

    -- ========== 来源：dwd_bt_sys_corp (单位表) ==========
    c.code,

    -- ========== 来源：DWD_BW_ZTBPC002_COM (公司映射表) ==========
    d.cbukrs,
    d.cbuktx,

    -- ========== 计算字段：银行信用等级 & 金盘票据分类 ==========
    -- bank_level: 根据 bill_type + acceptor_bank_name + acceptorbankno前3位 判定
    CASE
        WHEN v.bill_type NOT IN (10, 11) THEN '信用等级低'
        WHEN v.acceptor_bank_name LIKE '%银行%' AND LEFT(v.acceptorbankno, 3) IN ('302','304','104','303','102','301','308','103','305','309','105','310','316','307','403') THEN '信用等级高'
        WHEN v.acceptor_bank_name LIKE '%银行%' THEN '信用等级中等'
        WHEN LEFT(v.acceptorbankno, 3) IN ('402','011','001') THEN '信用等级中等'
        ELSE '信用等级低'
    END,
    -- jinpan_bill_type: 根据 bill_type + bank_level 映射
    CASE
        WHEN v.bill_type = 10 AND v.acceptor_bank_name LIKE '%银行%' AND LEFT(v.acceptorbankno, 3) IN ('302','304','104','303','102','301','308','103','305','309','105','310','316','307','403') THEN '银行承兑-信用等级高'
        WHEN v.bill_type = 10 AND v.acceptor_bank_name LIKE '%银行%' THEN '银行承兑-信用等级一般'
        WHEN v.bill_type = 10 AND v.acceptor_bank_name NOT LIKE '%银行%' AND LEFT(v.acceptorbankno, 3) IN ('402','011','001') THEN '银行承兑-信用等级一般'
        WHEN v.bill_type = 10 THEN '银行承兑-非金融机构'
        WHEN v.bill_type = 12 THEN '商业承兑-金融平台'
        WHEN v.bill_type = 11 THEN '商业承兑-普通'
        ELSE NULL
    END,
    -- jinpan_bill_code: 与金盘票据类型对应（高=10, 一般=20, 非金融=30, 普通商票=40, 金融平台=50）
    CASE
        WHEN v.bill_type = 10 AND v.acceptor_bank_name LIKE '%银行%' AND LEFT(v.acceptorbankno, 3) IN ('302','304','104','303','102','301','308','103','305','309','105','310','316','307','403') THEN '10'
        WHEN v.bill_type = 10 AND v.acceptor_bank_name LIKE '%银行%' THEN '20'
        WHEN v.bill_type = 10 AND v.acceptor_bank_name NOT LIKE '%银行%' AND LEFT(v.acceptorbankno, 3) IN ('402','011','001') THEN '20'
        WHEN v.bill_type = 10 THEN '30'
        WHEN v.bill_type = 12 THEN '50'
        WHEN v.bill_type = 11 THEN '40'
        ELSE NULL
    END

FROM dwd_dcp.dwd_bt_ab_accrecords a
-- 关联票据主表
LEFT JOIN dwd_dcp.dwd_bt_ab_voucherinfo v ON a.vid = v.id
-- 关联票据从表
LEFT JOIN dwd_dcp.dwd_bt_ab_voucherinfo_vice vi ON a.vvid = vi.id
-- 关联业务类型表，取业务类型名称
LEFT JOIN dwd_dcp.DWD_BT_ab_brief_status bs ON a.brief_id = bs.status
-- 字典：票据类型（内关联 dict + dict_group）
LEFT JOIN (
    SELECT sd.type_code, sd.type_name
    FROM dwd_dcp.dwd_bt_sys_dict sd
    INNER JOIN dwd_dcp.dwd_bt_sys_dict_group sg ON sd.type_group_id = sg.id AND sg.type_group_name = '票据类型'
) dict_bill_type ON v.bill_type = dict_bill_type.type_code
-- 字典：流通介质（内关联 dict + dict_group）
LEFT JOIN (
    SELECT sd.type_code, sd.type_name
    FROM dwd_dcp.dwd_bt_sys_dict sd
    INNER JOIN dwd_dcp.dwd_bt_sys_dict_group sg ON sd.type_group_id = sg.id AND sg.type_group_name = '流通介质'
) dict_bill_flag ON v.bill_flag = dict_bill_flag.type_code
-- 关联单位表，通过从表的 corp_id 取公司代码和名称
LEFT JOIN dwd_dcp.dwd_bt_sys_corp c ON vi.corp_id = c.id
-- 关联公司映射表，通过 code 取清洗后的公司代码和描述
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_COM d ON c.code = d.sbukrs
WHERE vi.type = '1'
  AND a.opt_status = '19'
  AND a.brief_id IN ('9003', '6001', '9010');
