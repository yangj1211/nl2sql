-- 目标表: jst_flat.payment_collection
-- 销售代表/代表处: S4 从 VBAK→TVGRT/TVKBT（fallback QCBB）；BM 固定 vkbur=6801、描述=美国销售团队、vkgrp 空
-- 部门映射: staging_db.sales_office_mapping
--   有 vkbur 编码 → 仅按 sales_office_code；无编码 → zsal_det 按 sales_office_desc
-- =============================================
TRUNCATE TABLE jst_flat.payment_collection;

INSERT INTO jst_flat.payment_collection
(rbukrs, cbukrs, cbuktx, belnr, xtruerev, rwcur, rocur, racct, prctr, cprctr, cprctx,
 wsl, osl, bldat, blart, zuonr, sgtxt, kunnr, kunnr_txt, comp_head, drcrk,
 zsal_rep, vkgrp, vkbur, zsal_det, dept_id, dept_name, cbugrp, data_source)
SELECT * FROM (

-- S4 数据 (国家='中国')
SELECT
    a.rbukrs,
    -- 公司代码清洗: rbukrs=sbukrs 关联 ZTBPC002_COM, 取cbukrs/cbuktx
    e.cbukrs, e.cbuktx,
    a.belnr, a.xtruerev, a.rwcur, a.rocur, a.racct,
    a.prctr,
    -- 利润中心清洗: 优先bukrs非空匹配, fallback bukrs为空
    COALESCE(f1.cprctr, f2.cprctr),
    COALESCE(f1.cprctx, f2.cprctx),
    a.wsl, a.osl,
    a.bldat, a.blart, a.zuonr, a.sgtxt,
    a.kunnr,
    -- 客户描述: sysid='CN1' AND kunnr=customer 关联 dws_bpqx
    g.cpatnr_txtlg,
    -- 控股公司: kunnr=partner 关联 bp001, '/'处理为空值
    NULLIF(h.comp_head, '/'),
    a.drcrk,
    -- 销售代表描述: VBAK.vkgrp→TVGRT.bezei, fallback QCBB.zsal_rep
    COALESCE(tgrp.bezei, b.zsal_rep),
    -- 销售代表: 优先VBAK, fallback ZTBW_QCBB
    COALESCE(c.vkgrp, b.vkgrp),
    -- 销售代表处: 优先VBAK, fallback ZTBW_QCBB
    COALESCE(c.vkbur, b.vkbur),
    -- 销售代表处描述: VBAK.vkbur→TVKBT.bezei, fallback QCBB.zsal_det
    COALESCE(tbur.bezei, b.zsal_det),
    COALESCE(m_code.dept_id, m_desc.dept_id)     AS dept_id,
    COALESCE(m_code.dept_name, m_desc.dept_name) AS dept_name,
    g.cbugrp,
    'S4' AS data_source
FROM dwd_dcp.DWD_S4_ACDOCA a
-- ZTBW_QCBB: 按vbeln聚合去重, zuonr=vbeln
LEFT JOIN (
    SELECT vbeln, MAX(zsal_rep) AS zsal_rep, MAX(vkgrp) AS vkgrp, MAX(vkbur) AS vkbur, MAX(zsal_det) AS zsal_det
    FROM dwd_dcp.dwd_s4_ztbw_qcbb GROUP BY vbeln
) b ON a.zuonr = b.vbeln
-- VBAK: zuonr=vbeln, 取vkgrp/vkbur(优先级高于ZTBW_QCBB)
LEFT JOIN dwd_dcp.dwd_s4_vbak c ON a.zuonr = c.vbeln
-- 销售代表描述: TVGRT.vkgrp = VBAK.vkgrp
LEFT JOIN dwd_dcp.dwd_s4_tvgrt tgrp ON c.vkgrp = tgrp.vkgrp
-- 销售代表处描述: TVKBT.vkbur = VBAK.vkbur
LEFT JOIN dwd_dcp.dwd_s4_tvkbt tbur ON c.vkbur = tbur.vkbur
-- 公司代码清洗: rbukrs=sbukrs, 取cbukrs/cbuktx
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_COM e ON a.rbukrs = e.sbukrs
-- 利润中心清洗: sysid='CN1', bukrs非空优先匹配
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC f1
    ON f1.sysid = 'CN1' AND f1.bukrs != '' AND f1.bukrs IS NOT NULL AND f1.bukrs = a.rbukrs AND f1.sprctr = a.prctr
-- 利润中心清洗: sysid='CN1', bukrs为空fallback
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC f2
    ON f2.sysid = 'CN1' AND (f2.bukrs = '' OR f2.bukrs IS NULL) AND f2.sprctr = a.prctr
-- 客户描述: sysid='CN1' AND customer=kunnr, 取cpatnr_txtlg
LEFT JOIN dws_dcp.dws_bpqx g
    ON g.sysid = 'CN1' AND g.customer = a.kunnr
-- 控股公司: kunnr=partner, 取comp_head, '/'处理为空值
LEFT JOIN dwd_dcp.dwd_s4_bp001 h ON a.kunnr = h.partner
-- 部门：有代表处编码用编码映射，否则用名称映射
LEFT JOIN staging_db.sales_office_mapping m_code
    ON COALESCE(c.vkbur, b.vkbur) IS NOT NULL AND TRIM(COALESCE(c.vkbur, b.vkbur)) != ''
   AND COALESCE(c.vkbur, b.vkbur) = m_code.sales_office_code
LEFT JOIN staging_db.sales_office_mapping m_desc
    ON (COALESCE(c.vkbur, b.vkbur) IS NULL OR TRIM(COALESCE(c.vkbur, b.vkbur)) = '')
   AND COALESCE(tbur.bezei, b.zsal_det) IS NOT NULL AND TRIM(COALESCE(tbur.bezei, b.zsal_det)) != ''
   AND COALESCE(tbur.bezei, b.zsal_det) = m_desc.sales_office_desc
-- 回款筛选: 贷方 + 应收/预收科目 + 银行存款/银行承兑/商业承兑凭证 + 排除冲销
WHERE a.drcrk = 'H'
    AND (a.racct LIKE '1122%' OR a.racct LIKE '2205%')
    AND a.blart IN ('DZ', 'DW', 'DM')
    AND (a.xtruerev != 'X' OR a.xtruerev IS NULL)

UNION ALL

-- BM 数据 (国家='美国'): 销售代表置空, 代表/代表处描述固定「美国销售团队」, vkbur=6801
SELECT
    a.rbukrs,
    -- 公司代码清洗: rbukrs=sbukrs 关联 ZTBPC002_COM, 取cbukrs/cbuktx
    e.cbukrs, e.cbuktx,
    a.belnr, a.xtruerev, a.rwcur,
    -- rocur: BM无此字段, 固定CNY
    'CNY',
    a.racct,
    a.prctr,
    -- 利润中心清洗: 优先bukrs非空匹配, fallback bukrs为空
    COALESCE(f1.cprctr, f2.cprctr),
    COALESCE(f1.cprctx, f2.cprctx),
    a.wsl,
    -- osl: RMB/CNY直接取wsl, 其他走TCURR换算。勿写 THEN wsl ELSE ukurs*wsl：
    -- MatrixOne 对 CASE 分支做类型对齐时会把 ELSE 放大 10^5（ukurs decimal(9,5) vs wsl decimal(23,2)）
    CASE WHEN a.rwcur NOT IN ('RMB', 'CNY') THEN d.ukurs * a.wsl ELSE a.wsl END,
    a.bldat, a.blart, a.zuonr, a.sgtxt,
    a.kunnr,
    -- 客户描述: sysid='US1' AND kunnr=customer 关联 dws_bpqx
    g.cpatnr_txtlg,
    -- 控股公司: kunnr=partner 关联 bp001, '/'处理为空值
    NULLIF(h.comp_head, '/'),
    a.drcrk,
    '美国销售团队' AS zsal_rep,
    NULL           AS vkgrp,
    '6801'         AS vkbur,
    '美国销售团队' AS zsal_det,
    m_code.dept_id,
    m_code.dept_name,
    g.cbugrp,
    'BM' AS data_source
FROM dwd_dcp.DWD_BM_ACDOCA a
-- TCURR汇率: fcurr=rwcur, tcurr='CNY', gdatu=bldat, kurst='M'
LEFT JOIN dwd_dcp.DWD_S4_TCURR d
    ON d.fcurr = a.rwcur AND d.tcurr = 'CNY' AND d.gdatu = a.bldat AND d.kurst = 'M'
-- 公司代码清洗: rbukrs=sbukrs, 取cbukrs/cbuktx
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_COM e ON a.rbukrs = e.sbukrs
-- 利润中心清洗: sysid='US1', bukrs非空优先匹配
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC f1
    ON f1.sysid = 'US1' AND f1.bukrs != '' AND f1.bukrs IS NOT NULL AND f1.bukrs = a.rbukrs AND f1.sprctr = a.prctr
-- 利润中心清洗: sysid='US1', bukrs为空fallback
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC f2
    ON f2.sysid = 'US1' AND (f2.bukrs = '' OR f2.bukrs IS NULL) AND f2.sprctr = a.prctr
-- 客户描述: sysid='US1' AND customer=kunnr, 取cpatnr_txtlg
LEFT JOIN dws_dcp.dws_bpqx g
    ON g.sysid = 'US1' AND g.customer = a.kunnr
-- 控股公司: kunnr=partner, 取comp_head, '/'处理为空值
LEFT JOIN dwd_dcp.dwd_s4_bp001 h ON a.kunnr = h.partner
-- 部门：美国固定代表处编码 6801
LEFT JOIN staging_db.sales_office_mapping m_code
    ON m_code.sales_office_code = '6801'
-- 回款筛选: 贷方 + 美国应收/预收科目 + 银行存款凭证 + 排除冲销
WHERE a.drcrk = 'H'
    AND (a.racct IN ('0012100000', '0012120000', '0012121000', '0012122000') OR a.racct LIKE '002119%')
    AND a.blart IN ('DZ', 'DW', 'DM')
    AND (a.xtruerev != 'X' OR a.xtruerev IS NULL)

) t;
