-- 采购入库大表 数据插入
-- 基表: sap_data.zmm0018_zmm0018

INSERT INTO jst_flat.purchase_receipt_cn (
    bukrs, cbukrs, cbuktx, werks, prctr, cprctr, cprctx, ernam, uname, aedat,
    bsart, ekgrp, ebeln, ebelp,
    lifnr, name1, mwskz, text1,
    matnr, txz01, matkl, wgbez,
    menge_ekpo, meins, mseht,
    netpr, peinh, netwr, waers, wkurs,
    menge_ekbe, bamng, menge_jhcb, meins_jb,
    kschl, vtext, wrbtr, zwrbtr, zwrbtr2, zwrbtr3,
    bwart, belnr, buzei, budat, charg, lgort, bktxt, belnr_2,
    knttp, ptext, hkont, bednr, eindt, ctype,
    zwlzxl, zjgpl, zhxcl, zgj, zlb, unit_price_excl_tax, unit_price_incl_tax, remark, is_calculated, delivery_amt, per_sap,
    kbetr,
    comp_head
)
SELECT
    a.bukrs,
    com.cbukrs,
    com.cbuktx,
    a.werks, a.prctr,
    COALESCE(prc2.cprctr, prc1.cprctr) AS cprctr,
    COALESCE(prc2.cprctx, prc1.cprctx) AS cprctx,
    a.ernam, a.uname, a.aedat,
    a.bsart, a.ekgrp, a.ebeln, a.ebelp,
    a.lifnr, a.name1, a.mwskz, a.text1,
    a.matnr, a.txz01, a.matkl, a.wgbez,
    a.menge_ekpo, a.meins, a.mseht,
    a.netpr, a.peinh, a.netwr, a.waers, a.wkurs,
    a.menge_ekbe, a.bamng, a.menge_jhcb, a.meins_jb,
    a.kschl, a.vtext, a.wrbtr, a.zwrbtr, a.zwrbtr2, a.zwrbtr3,
    a.bwart, a.belnr, a.buzei, a.budat, a.charg, a.lgort, a.bktxt, a.belnr_2,
    a.knttp, a.ptext, a.hkont, a.bednr, a.eindt, a.ctype,
    a.zwlzxl, a.zjgpl, a.zhxcl, a.zgj, a.zlb,
    -- 入库不含税单价：集团币别入库含税值 / 入库数量
    CASE WHEN a.menge_ekbe IS NOT NULL AND a.menge_ekbe != 0
         THEN a.zwrbtr3 / a.menge_ekbe
         ELSE NULL END AS unit_price_excl_tax,
    -- 入库含税单价：入库不含税单价 * (1 + 税率/100)
    CASE WHEN a.menge_ekbe IS NOT NULL AND a.menge_ekbe != 0
         THEN (a.zwrbtr3 / a.menge_ekbe) * (1 + konp.kbetr / 1000)
         ELSE NULL END AS unit_price_incl_tax,
    NULL AS remark,
    NULL AS is_calculated,
    NULL AS delivery_amt,
    NULL AS per_sap,
    -- 税率：A003(税码→条件记录号) → KONP(条件记录号→税率)
    konp.kbetr / 10 AS kbetr,
    -- 控股方：通过供应商代码关联BP001
    COALESCE(bp.comp_head, a.name1) AS comp_head
FROM sap_data.zmm0018_zmm0018 a
-- 公司代码（清洗后）
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_COM com
    ON a.bukrs = com.sbukrs
-- 利润中心（清洗后），优先bukrs不为空的精确匹配，否则通用匹配
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC prc1
    ON prc1.sysid = 'CN1'
    AND a.prctr = prc1.sprctr
    AND (prc1.bukrs IS NULL OR prc1.bukrs = '')
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC prc2
    ON prc2.sysid = 'CN1'
    AND a.bukrs = prc2.bukrs
    AND a.prctr = prc2.sprctr
    AND prc2.bukrs IS NOT NULL AND prc2.bukrs != ''
-- 税率：通过A003取条件记录号，再关联KONP取税率
LEFT JOIN dwd_dcp.dwd_s4_a003 a003
    ON a.mwskz = a003.mwskz
    AND a003.kappl = 'TX'
    AND a003.kschl = 'MWVS'
    AND a003.aland = 'CN'
LEFT JOIN dwd_dcp.dwd_s4_konp konp
    ON a003.knumh = konp.knumh
-- 控股方：通过供应商代码关联BP001
LEFT JOIN dwd_dcp.dwd_s4_bp001 bp
    ON a.lifnr = bp.partner;
