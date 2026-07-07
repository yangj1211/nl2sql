INSERT INTO jst_flat.revenue_cost
SELECT
    src.bic_zsys_id, src.ctgry, src.rbukrs,
    com.cbukrs, com.cbuktx,
    src.r_gjahr, src.r_monat, src.zlg_budat,
    src.aubel, src.vgbel, src.prctr,
    COALESCE(prc_exact.cprctr, prc_gen.cprctr) AS cprctr,
    COALESCE(prc_exact.cprctx, prc_gen.cprctx) AS cprctx,
    src.werks,
    dim_w.name1 AS werks_name1,
    src.matnr,
    -- 物料组: CN1从DWD_S4_MARA取, US1从DWD_BM_MARA取
    COALESCE(mara_cn.matkl, mara_us.matkl) AS matkl,
    t023t.wgbez,
    src.zuonr, src.leib,
    src.spart,
    tspat.vtext AS spart_vtext,
    src.vtxtk, src.vtxtk1, src.vtxtk2, src.vtxtk3,
    src.zwxnx, src.txtsh2, src.vkbur,
    tvkbt.bezei AS vkbur_bezei,
    src.vkgrp,
    tvgrt.bezei AS vkgrp_bezei,
    src.bic_zhold_grp,
    src.kunnr, src.name, src.country,
    tcountry.txtsh AS country_txtsh,
    src.region,
    tregion.region_txtsh,
    src.bzirk,
    tzsaledist.txtsh AS bzirk_txtsh,
    src.bstkd_e, src.kdkg1,
    usr.ckvgr1, usr.ckvgtx, usr.ckvgr2, usr.ckvgtx2, usr.ckvgr3, usr.ckvgtx3,
    src.txtmd, src.fkimg, src.zzjts, src.zzjdw, src.zzjdtsl, src.msl, src.zhsxssr, src.zxssr,
    src.zcbjg_jtdc, src.zzzcbsgtz, src.zzzcbhj, src.zzzml,
    src.zwwjgf, src.zazf, src.zazjsfwf, src.lifnr, src.txtmd2,
    src.zhqzxcb, src.zyf, src.zyfcyft, src.zqtcbcyft, src.zxsgscbhj, src.zjml,
    src.elehk, src.zgg, src.zxqdt, src.zxqdt_t, src.zqtdt, src.zqtdt_t,
    src.zjycl, src.zjdzj, src.zptjscl, src.zktjbj, src.zjjg, src.zqtbomcl, src.zwwjg, src.zcphbcp, src.zmgcl,
    src.zrgcb, src.zlwcb, src.zjqcfcb, src.zsdq, src.zfboml, src.zqtfy,
    src.zbdrgcb, src.zbdlwfy, src.zbdjqcfcb, src.zbdsdq, src.zbdfboml, src.zbdqtfy,
    src.zgdcbhj, src.zbdcbhj, src.qrszje, src.kxfje, src.bkxfje,
    src.intrate, src.xszk, src.jsfwb, src.zllxsjmll,
    src.cpart, src.zsfgl, src.zywlb,
    src.werks1,
    dim_w1.name1 AS werks1_name1,
    src.route,
    dim_rt.name1 AS route_name1
FROM dwd_dcp.dwd_bw_ztbpc011_02 src
-- 物料组: CN1系统
LEFT JOIN dwd_dcp.DWD_S4_MARA mara_cn
    ON src.matnr = mara_cn.matnr
   AND src.bic_zsys_id = 'CN1'
-- 物料组: US1系统
LEFT JOIN dwd_dcp.dwd_bm_mara mara_us
    ON src.matnr = mara_us.matnr
   AND src.bic_zsys_id = 'US1'
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_COM com
    ON src.rbukrs = com.sbukrs
-- 工厂描述: SYSID + WERKS
LEFT JOIN dws_dcp.dim_t001w dim_w
    ON src.bic_zsys_id = dim_w.sysid
   AND src.werks = dim_w.werks
-- 销售工厂描述: SYSID + WERKS1
LEFT JOIN dws_dcp.dim_t001w dim_w1
    ON src.bic_zsys_id = dim_w1.sysid
   AND src.werks1 = dim_w1.werks
-- 生产工厂描述: SYSID + ROUTE
LEFT JOIN dws_dcp.dim_t001w dim_rt
    ON src.bic_zsys_id = dim_rt.sysid
   AND src.route = dim_rt.werks
-- 物料组描述: SPRAS='1'
LEFT JOIN dwd_dcp.DWD_S4_T023T t023t
    ON COALESCE(mara_cn.matkl, mara_us.matkl) = t023t.matkl
   AND t023t.spras = '1'
-- 产品组描述: SPRAS='1'
LEFT JOIN dwd_dcp.dwd_s4_tspat tspat
    ON src.spart = tspat.spart
   AND tspat.spras = '1'
-- 销售代表处描述: SYSID + VKBUR
LEFT JOIN dws_dcp.dim_tvkbt tvkbt
    ON src.bic_zsys_id = tvkbt.sysid
   AND src.vkbur = tvkbt.vkbur
-- 销售代表描述: SYSID + VKGRP
LEFT JOIN dws_dcp.dim_tvgrt tvgrt
    ON src.bic_zsys_id = tvgrt.sysid
   AND src.vkgrp = tvgrt.vkgrp
-- 国家描述: COUNTRY, LANGU='1'
LEFT JOIN dwd_dcp.dwd_bw_bi0_tcountry tcountry
    ON src.country = tcountry.country
   AND tcountry.langu = '1'
-- 区域描述: COUNTRY + REGION
LEFT JOIN dws_dcp.dim_bi0_tregion tregion
    ON src.country = tregion.country
   AND src.region = tregion.region
-- 销售地区描述: SYSID + LPAD(BZIRK,6,'0'), LANGU='1'
LEFT JOIN dwd_dcp.dwd_bw_bic_tzsaledist tzsaledist
    ON src.bic_zsys_id = tzsaledist.bic_zsys_id
   AND LPAD(src.bzirk, 6, '0') = tzsaledist.bic_zsaledist
   AND tzsaledist.langu = '1'
-- 行业映射: SYSID + KDKG1(CN1时LPAD补0)
LEFT JOIN dwd_dcp.dwd_bw_ztbpc002_usr usr
    ON src.bic_zsys_id = usr.sysid
   AND CASE WHEN src.bic_zsys_id = 'CN1' THEN LPAD(src.kdkg1, 2, '0') ELSE src.kdkg1 END = usr.skvgr1
-- 利润中心映射(精确): bukrs不为空
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC prc_exact
    ON prc_exact.sysid = src.bic_zsys_id
   AND src.rbukrs = prc_exact.bukrs
   AND src.prctr = prc_exact.sprctr
   AND prc_exact.bukrs IS NOT NULL AND prc_exact.bukrs != ''
-- 利润中心映射(通用): bukrs为空
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC prc_gen
    ON prc_gen.sysid = src.bic_zsys_id
   AND src.prctr = prc_gen.sprctr
   AND (prc_gen.bukrs IS NULL OR prc_gen.bukrs = '');
