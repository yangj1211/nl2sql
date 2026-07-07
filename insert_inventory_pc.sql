-- ============================================================
-- 目标表: inventory_pc (物料收发存汇总表)
-- 数据来源: dwd_dcp.dwd_s4_ztmm0253 (SAP S4 物料收发存)
-- 说明: sysid 固定为 'CN1' (中国数据)，仅取 zorg_level='G' 且 zpri_type='P'
-- maktx: 根据 matnr 关联 dwd_dcp.dwd_s4_MAKT 取 MAKTX
-- mtbez: 根据 mtart 关联 dwd_dcp.dwd_s4_T134T 取 MTBEZ
-- zmtbez: 根据 mtart 关联 dwd_dcp.dwd_s4_ZT134T 取 ZMTBEZ（产品分类）
-- wgbez: 根据 matkl 关联 dwd_dcp.dwd_s4_T023T 取 WGBEZ
-- vtext: 根据 spart 关联 dwd_dcp.dwd_s4_TSPAT 取 VTEXT
-- ltext: 根据语言=ZH（spras='1'）、werks、sobsl 关联 dwd_dcp.dwd_s4_T460T 取 LTEXT
-- txt20: 根据语言=ZH（spras='1'）、账目表=1000、总账科目编号(konts) 关联 dwd_dcp.dwd_s4_SKAT 取 TXT20
-- beskz: 根据 werks、matnr 关联 dwd_dcp.dwd_s4_MARC 取 BESKZ
-- ============================================================
INSERT INTO jst_flat.inventory_pc (
    zorg_level, zpri_type, zmonth,
    bukrs, cbukrs, cbuktx,
    werks, name1,
    matnr, maktx,
    sobkz, bwtar, mat_kdauf, mat_kdpos, mat_pspnr, waers,
    mtart, mtbez, zmtbez,
    matkl, wgbez,
    spart, vtext,
    ekgrp,
    prctr, cprctr, cprctx,
    sobsl, ltext, beskz,
    maabc, guige, bklas,
    konts, txt20,
    meins,
    zqcsl, zqcdj, zqcje,
    zqmsl, zqmdj, zqmje,
    zpusl, zpudj, zpuje,
    zmosl, zmodj, zmoje,
    zdbrsl, zdbrdj, zdbrje,
    zqtrsl, zqtrdj, zqtrje,
    zqrsl_sum, zqrdj_sum, zqrje_sum,
    zmolsl, zmoldj, zomlje,
    zdbtsl, zdbtdj, zdbtje,
    zqttsl, zqttdj, zqttje,
    zsosl, zsodj, zsoje,
    ztzsl, ztzdj, ztzje,
    zqtsl_sum, zqtdj_sum, zqtje_sum,
    zjspusl, zjspudj, zjspuje,
    zjsrsl, zjsrdj, zjsrje,
    zjsshsl, zjsshdj, zjsshje,
    zqcjssl, zqcjsdj, zqcjsje,
    zjsjcsl, zjsjcdj, zjsjcje,
    zncsl, zncje,
    znrksl, znrkje,
    zncksl, znckje,
    zntzsl, zntzje,
    zhrkdate, zhckdate,
    zpowqsl, lwedt
)
SELECT
    t.zorg_level, t.zpri_type, t.zmonth,
    t.bukrs, com.cbukrs, com.cbuktx,
    t.werks, t001w.name1,
    t.matnr, makt.maktx,
    t.sobkz, t.bwtar, t.mat_kdauf, t.mat_kdpos, t.mat_pspnr, t.waers,
    t.mtart, t134t.mtbez, zt134t.zmtbez,
    t.matkl, t023t.wgbez,
    t.spart, tspat.vtext,
    t.ekgrp,
    t.prctr,
    COALESCE(prc1.cprctr, prc2.cprctr) AS cprctr,
    COALESCE(prc1.cprctx, prc2.cprctx) AS cprctx,
    t.sobsl, t460t.ltext, marc.beskz,
    t.maabc, t.guige, t.bklas,
    t.konts, skat.txt20,
    t.meins,
    t.zqcsl, t.zqcdj, t.zqcje,
    t.zqmsl, t.zqmdj, t.zqmje,
    t.zpusl, t.zpudj, t.zpuje,
    t.zmosl, t.zmodj, t.zmoje,
    t.zdbrsl, t.zdbrdj, t.zdbrje,
    t.zqtrsl, t.zqtrdj, t.zqtrje,
    t.zqrsl_sum, t.zqrdj_sum, t.zqrje_sum,
    t.zmolsl, t.zmoldj, t.zomlje,
    t.zdbtsl, t.zdbtdj, t.zdbtje,
    t.zqttsl, t.zqttdj, t.zqttje,
    t.zsosl, t.zsodj, t.zsoje,
    t.ztzsl, t.ztzdj, t.ztzje,
    t.zqtsl_sum, t.zqtdj_sum, t.zqtje_sum,
    t.zjspusl, t.zjspudj, t.zjspuje,
    t.zjsrsl, t.zjsrdj, t.zjsrje,
    t.zjsshsl, t.zjsshdj, t.zjsshje,
    t.zqcjssl, t.zqcjsdj, t.zqcjsje,
    t.zjsjcsl, t.zjsjcdj, t.zjsjcje,
    t.zncsl, t.zncje,
    t.znrksl, t.znrkje,
    t.zncksl, t.znckje,
    t.zntzsl, t.zntzje,
    t.zhrkdate, t.zhckdate,
    t.zpowqsl, t.lwedt
FROM dwd_dcp.dwd_s4_ztmm0253 t                                          -- 主表: SAP S4 物料收发存
-- 公司代码清洗映射: bukrs -> cbukrs, cbuktx
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_COM com
    ON t.bukrs = com.sbukrs AND com.sysid = 'CN1'
-- 利润中心清洗映射(精确匹配): sysid + bukrs + sprctr -> cprctr, cprctx
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC prc1
    ON prc1.sysid = 'CN1' AND prc1.bukrs IS NOT NULL AND prc1.bukrs != ''
    AND prc1.bukrs = t.bukrs AND prc1.sprctr = t.prctr
-- 利润中心清洗映射(通用兜底): sysid + sprctr -> cprctr, cprctx (bukrs为空时)
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC prc2
    ON prc2.sysid = 'CN1' AND (prc2.bukrs IS NULL OR prc2.bukrs = '')
    AND prc2.sprctr = t.prctr
-- 物料描述: 根据 matnr 关联 dwd_s4_MAKT 取 MAKTX
LEFT JOIN dwd_dcp.dwd_s4_MAKT makt
    ON makt.matnr = t.matnr
-- 物料类型描述: 根据 mtart 关联 dwd_s4_T134T 取 MTBEZ
LEFT JOIN dwd_dcp.dwd_s4_T134T t134t
    ON t134t.mtart = t.mtart
-- 产品分类: 根据 mtart 关联 dwd_s4_ZT134T 取 ZMTBEZ
LEFT JOIN dwd_dcp.dwd_s4_ZT134T zt134t
    ON zt134t.mtart = t.mtart
-- 物料组描述: 根据 matkl 关联 dwd_s4_T023T 取 WGBEZ
LEFT JOIN dwd_dcp.dwd_s4_T023T t023t
    ON t023t.matkl = t.matkl
-- 产品组描述: 根据 spart 关联 dwd_s4_TSPAT 取 VTEXT
LEFT JOIN dwd_dcp.dwd_s4_TSPAT tspat
    ON tspat.spart = t.spart
-- 特殊采购类型描述: 语言=ZH（spras='1'）、werks、sobsl 关联 dwd_s4_T460T 取 LTEXT
LEFT JOIN dwd_dcp.dwd_s4_T460T t460t
    ON t460t.spras = '1' AND t460t.werks = t.werks AND t460t.sobsl = t.sobsl
-- 采购类型: 根据 werks、matnr 关联 dwd_s4_MARC 取 BESKZ
LEFT JOIN dwd_dcp.dwd_s4_MARC marc
    ON marc.werks = t.werks AND marc.matnr = t.matnr
-- 总账科目编号描述: 语言=ZH（spras='1'）、账目表=1000、konts 关联 dwd_s4_SKAT 取 TXT20
LEFT JOIN dwd_dcp.dwd_s4_SKAT skat
    ON skat.spras = '1' AND skat.ktopl = '1000' AND skat.saknr = t.konts
-- 工厂描述: werks -> name1
LEFT JOIN dwd_dcp.dwd_s4_T001W t001w
    ON t001w.werks = t.werks
WHERE t.zorg_level = 'G'
  AND t.zpri_type = 'P';
