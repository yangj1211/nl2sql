-- 费用明细-凭证层级表 数据插入
-- 基表: dwd_dcp.DWD_S4_ACDOCA UNION ALL dwd_dcp.DWD_BM_ACDOCA
-- 中国区(S4)筛选: racct 以 66 开头；预算科目关联 DWD_S4_ZTBW_KMYSYSDM
-- cractx: racct 关联 DWD_BW_ZTBPC002_ACC.sracct（CN1/US1）取 cractx
-- 美国区(BM): ys_gjahr、txt30 置空（无预算科目映射表）

INSERT INTO jst_flat.EXPENSE_DETAIL_VOUCHER (
    gjahr, poper, rbukrs, cbukrs, cbuktx,
    racct, cractx, ys_gjahr, txt30,
    txt20, acct_level1, acct_level2, acct_level3, acct_level4,
    belnr, xref1_hd, bktxt, xref2_hd, xblnr, xreversal, rstgr, xref1, xref3,
    blart, prctr, cprctr, cprctx, rfarea,
    rcntr, ktext, anred, dept_id, dept_name,
    bldat, budat, tsl, rtcur, wsl, rwcur,
    sgtxt, aufnr, ktext_coas, ps_posid, post1, zuonr,
    kunnr, name1, kdauf, matnr, maktx,
    ebeln, ebelp, txz01, lifnr, name1_lfa1, rassc, zaddr7,     data_source
)
SELECT * FROM (
SELECT
    a.gjahr,
    a.poper,
    a.rbukrs,
    o.cbukrs,                -- RBUKRS = ZTBPC002_COM.SBUKRS
    o.cbuktx,                -- 同上
    a.racct,
    acc.cractx,
    kmys.gjahr AS ys_gjahr,  -- RACCT = ZTBW_KMYSYSDM.SAKNR，映射表字段 gjahr
    kmys.txt30,
    g.txt20,                 -- RACCT = SKAT.SAKNR AND SKAT.KTOPL = '1000'
    SUBSTRING_INDEX(g.txt20, '-', 1) AS acct_level1,
    IF(LOCATE('-', g.txt20) > 0, SUBSTRING_INDEX(SUBSTRING_INDEX(g.txt20, '-', 2), '-', -1), NULL) AS acct_level2,
    IF(LENGTH(g.txt20) - LENGTH(REPLACE(g.txt20, '-', '')) >= 2, SUBSTRING_INDEX(SUBSTRING_INDEX(g.txt20, '-', 3), '-', -1), NULL) AS acct_level3,
    IF(LENGTH(g.txt20) - LENGTH(REPLACE(g.txt20, '-', '')) >= 3, SUBSTRING_INDEX(SUBSTRING_INDEX(g.txt20, '-', 4), '-', -1), NULL) AS acct_level4,
    a.belnr,
    d.xref1_hd,              -- RBUKRS = BKPF.BUKRS AND GJAHR = BKPF.GJAHR AND BELNR = BKPF.BELNR
    d.bktxt,                 -- 同上
    d.xref2_hd,              -- 同上
    d.xblnr,                 -- 同上
    d.xreversal,             -- 同上
    e.rstgr,                 -- RBUKRS = BSEG.BUKRS AND GJAHR = BSEG.GJAHR AND BELNR = BSEG.BELNR AND DOCLN = LPAD(BSEG.BUZEI,6,'0')
    e.xref1,                 -- 同上
    e.xref3,                 -- 同上
    a.blart,
    a.prctr,
    COALESCE(p1.cprctr, p2.cprctr) AS cprctr,   -- 优先BUKRS不为空的匹配，再匹配BUKRS为空的
    COALESCE(p1.cprctx, p2.cprctx) AS cprctx,   -- 同上
    a.rfarea,
    a.rcntr,
    b.ktext,                 -- RCNTR = CSKT.KOSTL AND DATBI = '99991231'
    c.anred,                 -- RCNTR = CSKS.KOSTL
    n.dept_id,               -- LPAD(ANRED,8,'0') = core_dept.DEPT_ID
    n.dept_name,             -- 同上
    a.bldat,
    a.budat,
    a.tsl,
    a.rtcur,
    a.wsl,
    a.rwcur,
    a.sgtxt,
    a.aufnr,
    f.ktext AS ktext_coas,   -- AUFNR = COAS.AUFNR
    a.ps_posid,
    i.post1,                 -- PS_POSID = PROJ.PSPNR
    a.zuonr,
    a.kunnr,
    k.name1,                 -- KUNNR = KNA1.KUNNR
    a.kdauf,
    a.matnr,
    l.maktx,                 -- MATNR = MAKT.MATNR
    a.ebeln,
    a.ebelp,
    h.txz01,                 -- EBELN = EKPO.EBELN AND EBELP = EKPO.EBELP
    a.lifnr,
    m.name1 AS name1_lfa1,   -- LIFNR = LFA1.LIFNR
    a.rassc,
    j.zaddr7,                -- RBUKRS = ZTFI0007.BUKRS AND GJAHR = ZTFI0007.GJAHR AND BELNR = ZTFI0007.BELNR
    'S4' AS data_source
FROM dwd_dcp.DWD_S4_ACDOCA a
LEFT JOIN dwd_dcp.DWD_S4_CSKT b
    ON a.rcntr = b.kostl AND b.datbi = '99991231'
LEFT JOIN dwd_dcp.DWD_S4_CSKS c
    ON a.rcntr = c.kostl
LEFT JOIN dwd_dcp.DWD_S4_BKPF d
    ON a.rbukrs = d.bukrs AND a.gjahr = d.gjahr AND a.belnr = d.belnr
LEFT JOIN dwd_dcp.DWD_S4_BSEG e
    ON a.rbukrs = e.bukrs AND a.gjahr = e.gjahr AND a.belnr = e.belnr AND a.docln = LPAD(e.buzei, 6, '0')
LEFT JOIN dwd_dcp.DWD_S4_COAS f
    ON a.aufnr = f.aufnr
LEFT JOIN dwd_dcp.DWD_S4_SKAT g
    ON a.racct = g.saknr AND g.ktopl = '1000'
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_ACC acc
    ON a.racct = acc.sracct AND acc.sysid = 'CN1'
LEFT JOIN dwd_dcp.DWD_S4_ZTBW_KMYSYSDM kmys
    ON a.racct = kmys.saknr
LEFT JOIN dwd_dcp.DWD_S4_EKPO h
    ON a.ebeln = h.ebeln AND a.ebelp = h.ebelp
LEFT JOIN dwd_dcp.DWD_S4_PROJ i
    ON a.ps_posid = i.pspnr
LEFT JOIN dwd_dcp.DWD_S4_ZTFI0007 j
    ON a.rbukrs = j.bukrs AND a.gjahr = j.gjahr AND a.belnr = j.belnr
LEFT JOIN dwd_dcp.DWD_S4_KNA1 k
    ON a.kunnr = k.kunnr
LEFT JOIN dwd_dcp.DWD_S4_MAKT l
    ON a.matnr = l.matnr
LEFT JOIN dwd_dcp.DWD_S4_LFA1 m
    ON a.lifnr = m.lifnr
LEFT JOIN jst.core_dept n
    ON LPAD(c.anred, 8, '0') = n.dept_id
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_COM o
    ON a.rbukrs = o.sbukrs
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC p1
    ON p1.sysid = 'CN1' AND p1.bukrs = a.rbukrs AND p1.sprctr = a.prctr
    AND p1.bukrs IS NOT NULL AND p1.bukrs != ''
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC p2
    ON p2.sysid = 'CN1' AND p2.sprctr = a.prctr
    AND (p2.bukrs IS NULL OR p2.bukrs = '')
WHERE a.racct LIKE '66%'

UNION ALL

-- ========== 美国数据 (BM)，预算科目字段无映射置空 ==========
SELECT
    a.gjahr,
    a.poper,
    a.rbukrs,
    o.cbukrs,
    o.cbuktx,
    a.racct,
    acc.cractx,
    NULL AS ys_gjahr,
    NULL AS txt30,
    g.txt20,
    g.txt20 AS acct_level1,
    NULL AS acct_level2,
    NULL AS acct_level3,
    NULL AS acct_level4,
    a.belnr,
    d.xref1_hd,
    d.bktxt,
    d.xref2_hd,
    d.xblnr,
    d.xreversal,
    e.rstgr,
    e.xref1,
    e.xref3,
    a.blart,
    a.prctr,
    COALESCE(p1.cprctr, p2.cprctr) AS cprctr,
    COALESCE(p1.cprctx, p2.cprctx) AS cprctx,
    a.rfarea,
    a.rcntr,
    b.ktext,
    '1050' AS anred,
    n.dept_id,
    n.dept_name,
    a.bldat,
    a.budat,
    a.tsl,
    a.rtcur,
    a.wsl,
    a.rwcur,
    a.sgtxt,
    a.aufnr,
    f.ktext AS ktext_coas,
    a.ps_posid,
    i.post1,
    a.zuonr,
    a.kunnr,
    k.name1,
    a.kdauf,
    a.matnr,
    l.maktx,
    a.ebeln,
    a.ebelp,
    h.txz01,
    a.lifnr,
    m.name1 AS name1_lfa1,
    a.rassc,
    NULL AS zaddr7,
    'BM' AS data_source
FROM dwd_dcp.DWD_BM_ACDOCA a
LEFT JOIN dwd_dcp.DWD_BM_CSKT b
    ON a.rcntr = b.kostl AND b.datbi = '99991231'
LEFT JOIN dwd_dcp.DWD_BM_SKAT g
    ON a.racct = g.saknr AND g.ktopl = 'YCOA'
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_ACC acc
    ON a.racct = acc.sracct AND acc.sysid = 'US1'
LEFT JOIN dwd_dcp.DWD_BM_BKPF d
    ON a.rbukrs = d.bukrs AND a.gjahr = d.gjahr AND a.belnr = d.belnr
LEFT JOIN dwd_dcp.DWD_BM_BSEG e
    ON a.rbukrs = e.bukrs AND a.gjahr = e.gjahr AND a.belnr = e.belnr AND a.docln = LPAD(e.buzei, 6, '0')
LEFT JOIN dwd_dcp.DWD_BM_COAS f
    ON a.aufnr = f.aufnr
LEFT JOIN dwd_dcp.DWD_BM_EKPO h
    ON a.ebeln = h.ebeln AND a.ebelp = h.ebelp
LEFT JOIN dwd_dcp.DWD_BM_PROJ i
    ON a.ps_posid = i.pspnr
LEFT JOIN dwd_dcp.DWD_BM_KNA1 k
    ON a.kunnr = k.kunnr
LEFT JOIN dwd_dcp.DWD_BM_MAKT l
    ON a.matnr = l.matnr
LEFT JOIN dwd_dcp.DWD_BM_LFA1 m
    ON a.lifnr = m.lifnr
LEFT JOIN jst.core_dept n
    ON n.dept_id = '00001050'
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_COM o
    ON a.rbukrs = o.sbukrs
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC p1
    ON p1.sysid = 'US1' AND p1.bukrs = a.rbukrs AND p1.sprctr = a.prctr
    AND p1.bukrs IS NOT NULL AND p1.bukrs != ''
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC p2
    ON p2.sysid = 'US1' AND p2.sprctr = a.prctr
    AND (p2.bukrs IS NULL OR p2.bukrs = '')
) t;
