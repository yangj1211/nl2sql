-- ============================================================
-- 目标表: output_value_pc (生产产值汇总表)
-- 数据来源: dwd_dcp.DWD_BW_BIC_AZBCN1PP072 (BW 生产产值)
-- ============================================================
INSERT INTO output_value_pc (
    bic_zsys_id, calmonth, b28_s_kgdtvnx, b28_s_kgd4rtr, b28_s_kgdxoi5,
    bic_zcompcode, cbukrs, cbuktx, bic_zprft_ctr, cprctr, cprctx, bic_zco_area,
    bic_zprodord, bic_zmaterial, bic_zmatl_grp,
    recordmode,
    zkfy01_1, zkfy01_2, zkfy01_3, zkfy01_4,
    zkfy02_1, zkfy02_2, zkfy02_3, zkfy02_4,
    zkfy03_1, zkfy03_2, zkfy03_3, zkfy03_4,
    zkfy08_1, zkfy08_2, zkfy08_3, zkfy08_4
)
SELECT
    t.bic_zsys_id, t.calmonth, t.b28_s_kgdtvnx, t.b28_s_kgd4rtr, t.b28_s_kgdxoi5,
    t.bic_zcompcode, com.cbukrs, com.cbuktx,
    t.bic_zprft_ctr,
    COALESCE(prc1.cprctr, prc2.cprctr) AS cprctr,
    COALESCE(prc1.cprctx, prc2.cprctx) AS cprctx,
    t.bic_zco_area,
    t.bic_zprodord, t.bic_zmaterial, t.bic_zmatl_grp,
    t.recordmode,
    t.zkfy01_1, t.zkfy01_2, t.zkfy01_3, t.zkfy01_4,
    t.zkfy02_1, t.zkfy02_2, t.zkfy02_3, t.zkfy02_4,
    t.zkfy03_1, t.zkfy03_2, t.zkfy03_3, t.zkfy03_4,
    t.zkfy08_1, t.zkfy08_2, t.zkfy08_3, t.zkfy08_4
FROM dwd_dcp.DWD_BW_BIC_AZBCN1PP072 t
-- 公司代码清洗映射: bic_zcompcode -> cbukrs, cbuktx
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_COM com
    ON t.bic_zcompcode = com.sbukrs AND com.sysid = t.bic_zsys_id
-- 利润中心清洗映射(精确匹配): sysid + bukrs + sprctr -> cprctr, cprctx
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC prc1
    ON prc1.sysid = t.bic_zsys_id AND prc1.bukrs IS NOT NULL AND prc1.bukrs != ''
    AND prc1.bukrs = t.bic_zcompcode AND prc1.sprctr = t.bic_zprft_ctr
-- 利润中心清洗映射(通用兜底): sysid + sprctr -> cprctr, cprctx (bukrs为空时)
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC prc2
    ON prc2.sysid = t.bic_zsys_id AND (prc2.bukrs IS NULL OR prc2.bukrs = '')
    AND prc2.sprctr = t.bic_zprft_ctr;
