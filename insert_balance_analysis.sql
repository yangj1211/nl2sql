INSERT INTO jst_flat.balance_analysis
SELECT
    t.bank_acc,
    t.acc_name,
    t.corp_id,
    t.code,
    t.cbukrs,
    t.cbuktx,
    t.bank_name,
    t.type_name,
    t.nature_name,
    t.cur_name,
    t.get_date,
    t.bal_date,
    t.bal,
    t.avail_bal,
    t.frz_bal,
    t.status
FROM (
    SELECT
        bal.bank_acc,
        acc.acc_name,
        bal.corp_id,
        corp.code,
        com.cbukrs,
        com.cbuktx,
        acc.bank_name,
        dict.type_name,
        nat.nature_name,
        cur.cur_name,
        bal.get_date,
        bal.bal_date,
        bal.bal,
        bal.avail_bal,
        bal.frz_bal,
        bal.status,
        ROW_NUMBER() OVER (PARTITION BY bal.bank_acc, bal.bal_date ORDER BY bal.get_date DESC) AS rn
    FROM dwd_dcp.dwd_bt_bis_acc_bal bal
-- 银行账户主数据: 通过银行账号关联，取账户名称(acc_name)、开户行名称(bank_name)、账户类别编码(acc_type)、账户性质ID(nature_id)
LEFT JOIN dwd_dcp.dwd_bt_bank_acc acc
    ON bal.bank_acc = acc.bank_acc
-- 单位(公司)信息: 通过单位ID关联，取公司代码(code)
LEFT JOIN dwd_dcp.dwd_bt_sys_corp corp
    ON bal.corp_id = corp.id
-- 公司代码清洗映射: 通过公司代码关联BW清洗表，将司库公司代码(code)映射为合并报表公司代码(cbukrs)和公司描述(cbuktx)，sysid='CN1'表示中国区系统
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_COM com
    ON corp.code = com.sbukrs AND com.sysid = 'CN1'
-- 账户类别字典组: 关联dwd_bt_sys_dict_group，限定字典组编码为'btBankAcc.accType'(账户类别)
LEFT JOIN dwd_dcp.dwd_bt_sys_dict_group dg
    ON dg.type_group_code = 'btBankAcc.accType'
-- 账户类别字典: 通过账户类别编码和字典组ID关联通用字典表，取账户类别名称(type_name)，避免匹配到其他字典组的同名编码
LEFT JOIN dwd_dcp.dwd_bt_sys_dict dict
    ON acc.acc_type = dict.type_code
    AND dict.type_group_id = dg.id
-- 账户性质: 通过账户性质ID关联，取账户性质名称(nature_name)
LEFT JOIN dwd_dcp.dwd_bt_acc_nature nat
    ON acc.nature_id = nat.id
-- 币别: 通过币别ID关联，取币别名称(cur_name)
LEFT JOIN dwd_dcp.dwd_bt_currency cur
    ON bal.cur_id = cur.id
-- 银行账户状态过滤: 排除注销账户(status=-2)和无效账户(valid_sign='0')
WHERE (acc.status IS NULL OR acc.status <> -2)
  AND (acc.valid_sign IS NULL OR acc.valid_sign <> '0')
) t
WHERE t.rn = 1;
