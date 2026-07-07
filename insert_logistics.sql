-- 从 dwd_dcp.DWD_S4_ZTMM0008K 插入数据到 jst_flat_table.logistics
-- cprctr, cprctx 从 DWD_BW_ZTBPC002_PRC 取，优先精确匹配(sysid+bukrs+sprctr)，否则宽松匹配(sysid+sprctr, bukrs为空)
-- cbukrs, cbuktx 从 DWD_BW_ZTBPC002_COM 取
-- ktext 通过 LEFT JOIN DWD_S4_CSKT 按 kostl 关联取得
INSERT INTO jst_flat_table.logistics (
    vbeln, posnr, zposnr1, zfate, zbillno, zsbilln,
    sebeln, sebelp, zdepartment, ekorg, bukrs, werks, vkorg, vstel,
    country, addr, fhxxdz, zyunstyle, ztransfer,
    lifnr, name1, vgbel, vgpos, ebeln, ebelp,
    zdnsdate, zdnedate, zsfdate, zsjdate,
    zstate, zshipmentname, zshipment, zproivnce, zcity, zregion,
    maktx, lfimg, zsplitqty, zmiles, zweight, zweightunit,
    zunit, znetprice, zprice, mwskz, zprice2, zprice3, zprice4,
    waers2, zshiptype, zdmiles, zsalefate, waers, zdec,
    prctr, cprctr, cprctx,
    kostl, cbukrs, cbuktx,
    zdnvalue, zflag, zcarrid, zaddriver, ztelephone,
    zpayflag, zpayment, ekgrp, vtweg,
    xloek, zqtyunit, checkflag,
    mblnr, mjahr, zeile, no_fgt, sign_date, gl_date_rel,
    updkz, bg_number, remark,
    sap_crm_flag, sap_crm_date, sap_crm_time,
    budat, cost_type, kz_pri, kz_waers, zcx,
    ktext
)
SELECT
    a.vbeln, a.posnr, a.zposnr1, a.zfate, a.zbillno, a.zsbilln,
    a.sebeln, a.sebelp, a.zdepartment, a.ekorg, a.bukrs, a.werks, a.vkorg, a.vstel,
    a.country, a.addr, a.fhxxdz, a.zyunstyle, a.ztransfer,
    a.lifnr, a.name1, a.vgbel, a.vgpos, a.ebeln, a.ebelp,
    a.zdnsdate, a.zdnedate, a.zsfdate, a.zsjdate,
    a.zstate, a.zshipmentname, a.zshipment, a.zproivnce, a.zcity, a.zregion,
    a.maktx, a.lfimg, a.zsplitqty, a.zmiles, a.zweight, a.zweightunit,
    a.zunit, a.znetprice, a.zprice, a.mwskz, a.zprice2, a.zprice3, a.zprice4,
    a.waers2, a.zshiptype, a.zdmiles, a.zsalefate, a.waers, a.zdec,
    a.prctr, COALESCE(d1.cprctr, d2.cprctr, d3.cprctr, d4.cprctr) AS cprctr, COALESCE(d1.cprctx, d2.cprctx, d3.cprctx, d4.cprctx) AS cprctx,
    a.kostl, c.cbukrs, c.cbuktx,
    a.zdnvalue, a.zflag, a.zcarrid, a.zaddriver, a.ztelephone,
    a.zpayflag, a.zpayment, a.ekgrp, a.vtweg,
    a.xloek, a.zqtyunit, a.checkflag,
    a.mblnr, a.mjahr, a.zeile, a.no_fgt, a.sign_date, a.gl_date_rel,
    a.updkz, a.bg_number, a.remark,
    a.sap_crm_flag, a.sap_crm_date, a.sap_crm_time,
    a.budat, a.cost_type, a.kz_pri, a.kz_waers, a.zcx,
    b.ktext
FROM dwd_dcp.DWD_S4_ZTMM0008K a
LEFT JOIN dwd_dcp.DWD_S4_CSKT b
    ON a.kostl = b.kostl
    AND b.datbi = '99991231'
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_COM c
    ON a.bukrs = c.sbukrs
-- 精确匹配: sysid=CN1 + bukrs + sprctr (bukrs不为空)
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC d1
    ON d1.sysid = 'CN1'
    AND d1.bukrs = a.bukrs
    AND d1.sprctr = a.prctr
    AND d1.bukrs != ''
-- 宽松匹配: sysid=CN1 + sprctr (bukrs为空)
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC d2
    ON d2.sysid = 'CN1'
    AND d2.sprctr = a.prctr
    AND (d2.bukrs = '' OR d2.bukrs IS NULL)
-- 补零精确匹配: prctr前补0000再匹配 (bukrs不为空)
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC d3
    ON d3.sysid = 'CN1'
    AND d3.bukrs = a.bukrs
    AND d3.sprctr = CONCAT('0000', a.prctr)
    AND d3.bukrs != ''
    AND LEFT(a.prctr, 4) != '0000'
-- 补零宽松匹配: prctr前补0000再匹配 (bukrs为空)
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC d4
    ON d4.sysid = 'CN1'
    AND d4.sprctr = CONCAT('0000', a.prctr)
    AND (d4.bukrs = '' OR d4.bukrs IS NULL)
    AND LEFT(a.prctr, 4) != '0000';
