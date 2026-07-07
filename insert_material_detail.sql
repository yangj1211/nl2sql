-- 物料明细表 数据插入
-- 筛选条件: DWD_BW_ZTBPC002_ACC.cractx LIKE '%物料消耗%'，且排除64开头科目号
-- CN1 → DWD_S4_ACDOCA, US1 → DWD_BM_ACDOCA

INSERT INTO jst_flat.MATERIAL_DETAIL (
    rbukrs, cbukrs, cbuktx,
    belnr, blart, budat, sgtxt,
    racct, cracct, cractx,
    prctr, cprctr, cprctx,
    rfarea, cfartx,
    rcntr, ktext,
    anred, dept_id, dept_name,
    matnr, maktx, matkl, wgbez, mtbez,
    tsl, rtcur, wsl, rwcur,
    msl, runit,
    werks, ebeln, kdauf, aufnr, lifnr, kunnr, data_source
)
SELECT * FROM (

SELECT
    a.rbukrs,
    com.cbukrs,
    com.cbuktx,
    a.belnr,
    a.blart,
    a.budat,
    a.sgtxt,
    a.racct,
    acc.cracct,
    acc.cractx,
    a.prctr,
    COALESCE(prc2.cprctr, prc1.cprctr) AS cprctr,
    COALESCE(prc2.cprctx, prc1.cprctx) AS cprctx,
    a.rfarea,
    fun.cfartx,
    a.rcntr,
    cskt.ktext,
    csks.anred,
    dept.dept_id,
    dept.dept_name,
    a.matnr,
    makt.maktx,
    mara.matkl,
    t023t.wgbez,
    t134t.mtbez,
    a.tsl,
    a.rtcur,
    a.wsl,
    a.rwcur,
    a.msl,
    a.runit,
    a.werks,
    a.ebeln,
    a.kdauf,
    a.aufnr,
    a.lifnr,
    a.kunnr,
    'S4' AS data_source
FROM dwd_dcp.DWD_S4_ACDOCA a

-- 筛选物料消耗科目，sysid='CN1'关联S4
INNER JOIN dwd_dcp.DWD_BW_ZTBPC002_ACC acc
    ON a.racct = acc.sracct
    AND a.racct NOT LIKE '64%'
    AND acc.sysid = 'CN1'
    AND acc.cractx LIKE '%物料消耗%'
-- 公司代码和描述（清洗后），RBUKRS = ZTBPC002_COM.sbukrs
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_COM com
    ON a.rbukrs = com.sbukrs
-- 利润中心（清洗后），优先bukrs不为空的三字段匹配，否则两字段匹配
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC prc1
    ON prc1.sysid = 'CN1'
    AND a.prctr = prc1.sprctr
    AND (prc1.bukrs IS NULL OR prc1.bukrs = '')
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC prc2
    ON prc2.sysid = 'CN1'
    AND a.rbukrs = prc2.bukrs
    AND a.prctr = prc2.sprctr
    AND prc2.bukrs IS NOT NULL AND prc2.bukrs != ''
-- 功能范围描述，sysid='CN1'关联fun
LEFT JOIN dwd_dcp.dwd_BW_ztbpc002_fun fun
    ON a.rfarea = fun.sfarea
    AND fun.sysid = 'CN1'
-- 成本中心名称，RCNTR = CSKT.KOSTL AND DATBI = '99991231'
LEFT JOIN dwd_dcp.DWD_S4_CSKT cskt
    ON a.rcntr = cskt.kostl
    AND cskt.datbi = '99991231'
-- 标题，RCNTR = CSKS.KOSTL
LEFT JOIN dwd_dcp.DWD_S4_CSKS csks
    ON a.rcntr = csks.kostl
-- 部门编码/名称，ANRED不足8位补0，LS01按1000处理后关联core_dept取数
LEFT JOIN jst.core_dept dept
    ON CASE
        WHEN UPPER(csks.anred) = 'LS01' THEN LPAD('1000', 8, '0')
        WHEN LENGTH(csks.anred) < 8 THEN LPAD(csks.anred, 8, '0')
        ELSE csks.anred
    END = dept.dept_id
-- 物料描述，MATNR = MAKT.MATNR
LEFT JOIN dwd_dcp.DWD_S4_MAKT makt
    ON a.matnr = makt.matnr
-- 物料组，MATNR = MARA.MATNR
LEFT JOIN dwd_dcp.DWD_S4_MARA mara
    ON a.matnr = mara.matnr
-- 物料组描述，MARA.MATKL = T023T.MATKL
LEFT JOIN dwd_dcp.DWD_S4_T023T t023t
    ON mara.matkl = t023t.matkl
-- 物料类型描述，MARA.MTART = T134T.MTART
LEFT JOIN dwd_dcp.DWD_S4_T134T t134t
    ON mara.mtart = t134t.mtart

UNION ALL

SELECT
    a.rbukrs,
    com.cbukrs,
    com.cbuktx,
    a.belnr,
    a.blart,
    a.budat,
    a.sgtxt,
    a.racct,
    acc.cracct,
    acc.cractx,
    a.prctr,
    COALESCE(prc2.cprctr, prc1.cprctr) AS cprctr,
    COALESCE(prc2.cprctx, prc1.cprctx) AS cprctx,
    a.rfarea,
    fun.cfartx,
    a.rcntr,
    cskt.ktext,
    '1050' AS anred,
    dept.dept_id,
    dept.dept_name,
    a.matnr,
    makt.maktx,
    mara.matkl,
    t023t.wgbez,
    t134t.mtbez,
    a.tsl,
    a.rtcur,
    a.wsl,
    a.rwcur,
    a.msl,
    a.runit,
    a.werks,
    a.ebeln,
    a.kdauf,
    a.aufnr,
    a.lifnr,
    a.kunnr,
    'BM' AS data_source
FROM dwd_dcp.DWD_BM_ACDOCA a
-- 筛选物料消耗科目，sysid='US1'关联BM
INNER JOIN dwd_dcp.DWD_BW_ZTBPC002_ACC acc
    ON a.racct = acc.sracct
    AND a.racct NOT LIKE '64%'
    AND acc.sysid = 'US1'
    AND acc.cractx LIKE '%物料消耗%'
-- 公司代码和描述（清洗后），RBUKRS = ZTBPC002_COM.sbukrs
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_COM com
    ON a.rbukrs = com.sbukrs
-- 利润中心（清洗后），优先bukrs不为空的三字段匹配，否则两字段匹配
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC prc1
    ON prc1.sysid = 'US1'
    AND a.prctr = prc1.sprctr
    AND (prc1.bukrs IS NULL OR prc1.bukrs = '')
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC prc2
    ON prc2.sysid = 'US1'
    AND a.rbukrs = prc2.bukrs
    AND a.prctr = prc2.sprctr
    AND prc2.bukrs IS NOT NULL AND prc2.bukrs != ''
-- 功能范围描述，sysid='US1'关联fun
LEFT JOIN dwd_dcp.dwd_BW_ztbpc002_fun fun
    ON a.rfarea = fun.sfarea
    AND fun.sysid = 'US1'
-- 成本中心名称，RCNTR = CSKT.KOSTL AND DATBI = '99991231'
LEFT JOIN dwd_dcp.DWD_BM_CSKT cskt
    ON a.rcntr = cskt.kostl
    AND cskt.datbi = '99991231'
-- 部门编码/名称，ANRED固定为'1050'关联core_dept取数
LEFT JOIN jst.core_dept dept
    ON LPAD('1050', 8, '0') = dept.dept_id
-- 物料描述，MATNR = MAKT.MATNR
LEFT JOIN dwd_dcp.DWD_BM_MAKT makt
    ON a.matnr = makt.matnr
-- 物料组，MATNR = MARA.MATNR
LEFT JOIN dwd_dcp.DWD_BM_MARA mara
    ON a.matnr = mara.matnr
-- 物料组描述，MARA.MATKL = T023T.MATKL
LEFT JOIN dwd_dcp.DWD_BM_T023T t023t
    ON mara.matkl = t023t.matkl
-- 物料类型描述，MARA.MTART = T134T.MTART
LEFT JOIN dwd_dcp.DWD_BM_T134T t134t
    ON mara.mtart = t134t.mtart

) t;
