-- ============================================================
-- 目标表：jst_flat.inventory_aging_pc（存货账龄-管口）
-- 源表：dwd_dcp.dwd_s4_ztmm019
-- 筛选：zorg_level = 'G'（集团层级）
-- maktx: 根据 matnr 关联 dwd_dcp.dwd_s4_MAKT 取 MAKTX
-- ============================================================

INSERT INTO jst_flat.inventory_aging_pc (
    werks, name1, prctr, cprctr, cprctx,
    lgort, lgobe, matnr, maktx, charg,
    pvprs, stprs, peinh, waers, zsl, meins,
    zzqzje, zbzzje, zklts, ernam, sobkz,
    vbeln, posnr, pspnr, lifnr, zsection,
    zjcbl, zjcje, bwtar, zorg_level, zpvprs,
    guige, guige_n, kunnr, name_org1, bstkd_e,
    vkbur, bezei, vkgrp, zbezei, zdates
)
SELECT
    t.werks,
    w.name1,
    t.prctr,
    prc.cprctr,
    prc.cprctx,
    t.lgort,
    l.lgobe,
    t.matnr,
    makt.maktx,
    t.charg,
    t.pvprs,
    t.stprs,
    t.peinh,
    t.waers,
    t.zsl,
    t.meins,
    t.zzqzje,
    t.zbzzje,
    t.zklts,
    t.ernam,
    t.sobkz,
    t.vbeln,
    t.posnr,
    t.pspnr,
    t.lifnr,
    t.zsection,
    t.zjcbl,
    t.zjcje,
    t.bwtar,
    t.zorg_level,
    t.zpvprs,
    m.guige,
    m.guige_n,
    v.kunnr,
    b.name_org1,
    d.bstkd_e,
    v.vkbur,
    kb.bezei,
    v.vkgrp,
    gr.bezei AS zbezei,
    t.zdates
FROM dwd_dcp.dwd_s4_ztmm019 t
LEFT JOIN dwd_dcp.dwd_s4_t001w w ON t.werks = w.werks
LEFT JOIN dwd_dcp.dwd_s4_t001l l ON t.werks = l.werks AND t.lgort = l.lgort
LEFT JOIN dwd_dcp.dwd_s4_mara m ON t.matnr = m.matnr
LEFT JOIN dwd_dcp.dwd_s4_MAKT makt ON t.matnr = makt.matnr
LEFT JOIN dwd_dcp.dwd_s4_vbak v ON t.vbeln = v.vbeln
LEFT JOIN dwd_dcp.dwd_s4_but000 b ON v.kunnr = b.partner
LEFT JOIN dwd_dcp.dwd_s4_vbkd d ON t.vbeln = d.vbeln AND t.posnr = d.posnr
LEFT JOIN dwd_dcp.dwd_s4_tvkbt kb ON v.vkbur = kb.vkbur
LEFT JOIN dwd_dcp.dwd_s4_tvgrt gr ON v.vkgrp = gr.vkgrp
-- 利润中心清洗映射: sysid=CN1, sprctr -> cprctr, cprctx (ztmm019无bukrs，用兜底匹配)
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC prc
    ON prc.sysid = 'CN1' AND (prc.bukrs IS NULL OR prc.bukrs = '')
    AND prc.sprctr = t.prctr
WHERE t.zorg_level = 'G';
