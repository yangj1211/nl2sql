-- ============================================================
-- 其它应收（实时）- 数据插入
-- 目标表：jst_flat.receivable_other_realtime
-- 底表：sap_data.ZRFI011_99991231QTYS（中国S4）
-- 筛选：RACCT LIKE '123101%' OR RACCT LIKE '123102%'
-- 单项计提：dwd_dcp.DWD_BW_ZTBPC010_05 (CN1, 取最新zbdat)
-- 公司清洗：DWD_BW_ZTBPC002_COM (sbukrs=RBUKRS) → cbukrs/cbuktx
-- 利润中心清洗：DWD_BW_ZTBPC002_PRC (CN1，精确+宽松+补零) → cprctr/cprctx
-- 部门映射：staging_db.sales_office_mapping
--   有 VKBUR 编码 → 仅按 sales_office_code；无编码 → BEZEI_N/BEZEI 按 sales_office_desc
-- ============================================================

TRUNCATE TABLE jst_flat.receivable_other_realtime;

INSERT INTO jst_flat.receivable_other_realtime (
    BSTDK, RBUKRS, cbukrs, cbuktx, VKBUR, BEZEI_N, dept_id, dept_name,
    VKGRP, VKGRP_TN, KUNNR, NAME1, VBELN, BSTKD_EN, KZWI1, YFHJE, YSYE, DSYQZE, BLDAT,
    KXXZ, TEXT1, YQ01, YQ02, YQ03, YQ04, YQ05, YQ06, YQ07, YQ08, JZ, ZOPAMT,
    YQ10, YQ11, YQ12, YS01, YS02, YS03, YS04, YS05, YS06, YS07, YS08, YQ09,
    YS1, YS2, YS3, YS4, YQ1, YQ2, YQ3, YQ4, YS1Y, YS2Y, YS3Y, YQ1Y, YQ2Y, YQ3Y,
    DESCRIPTION, DESCRIPT, LEADER, SETNAME, PRCTR, cprctr, cprctx, KTEXT, RACCT, RACCT_T,
    VTWEG_T, IND_SECTOR, YQ13, TEXT, COMP_HEAD, CREDIT_GROUP, CREDIT_GROUP_T, CRMXM, HTQRS,
    KVGR1, KVGR1_T, QRSZJE, YSK, WHKBL, YFHHKBL, HKZHTBL, JZDAT, TS, ZQNXS,
    DSYSYEZXSBL, YS1YZXSBL, YS2YZXSBL, YS3YZXSBL, DSYQZEZXSBL, YQ1YZXSBL, YQ2YZXSBL,
    BEZEI, YQ3YZXSBL, YSZKZZTS, VTWEG, DHDAT, VKGRP_T, BSTKD_E, ZJTBL, ZKTEXT, ZBEZEI
)
SELECT
    s.BSTDK,
    s.RBUKRS,
    com.cbukrs,
    com.cbuktx,
    s.VKBUR,
    s.BEZEI_N,
    COALESCE(m_code.dept_id, m_desc.dept_id)     AS dept_id,
    COALESCE(m_code.dept_name, m_desc.dept_name) AS dept_name,
    s.VKGRP,
    s.VKGRP_TN,
    s.KUNNR,
    s.NAME1,
    s.VBELN,
    s.BSTKD_EN,
    s.KZWI1,
    s.YFHJE,
    s.YSYE,
    s.DSYQZE,
    s.BLDAT,
    s.KXXZ,
    s.TEXT1,
    s.YQ01,
    s.YQ02,
    s.YQ03,
    s.YQ04,
    s.YQ05,
    s.YQ06,
    s.YQ07,
    s.YQ08,
    s.JZ,
    s.ZOPAMT,
    s.YQ10,
    s.YQ11,
    s.YQ12,
    s.YS01,
    s.YS02,
    s.YS03,
    s.YS04,
    s.YS05,
    s.YS06,
    s.YS07,
    s.YS08,
    s.YQ09,
    s.YS1,
    s.YS2,
    s.YS3,
    s.YS4,
    s.YQ1,
    s.YQ2,
    s.YQ3,
    s.YQ4,
    s.YS1Y,
    s.YS2Y,
    s.YS3Y,
    s.YQ1Y,
    s.YQ2Y,
    s.YQ3Y,
    s.DESCRIPTION,
    s.DESCRIPT,
    s.LEADER,
    s.SETNAME,
    s.PRCTR,
    COALESCE(prc1.cprctr, prc2.cprctr, prc3.cprctr, prc4.cprctr) AS cprctr,
    COALESCE(prc1.cprctx, prc2.cprctx, prc3.cprctx, prc4.cprctx) AS cprctx,
    s.KTEXT,
    s.RACCT,
    s.RACCT_T,
    s.VTWEG_T,
    s.IND_SECTOR,
    s.YQ13,
    s.TEXT,
    s.COMP_HEAD,
    s.CREDIT_GROUP,
    s.CREDIT_GROUP_T,
    s.CRMXM,
    s.HTQRS,
    s.KVGR1,
    s.KVGR1_T,
    s.QRSZJE,
    s.YSK,
    s.WHKBL,
    s.YFHHKBL,
    s.HKZHTBL,
    s.JZDAT,
    s.TS,
    s.ZQNXS,
    s.DSYSYEZXSBL,
    s.YS1YZXSBL,
    s.YS2YZXSBL,
    s.YS3YZXSBL,
    s.DSYQZEZXSBL,
    s.YQ1YZXSBL,
    s.YQ2YZXSBL,
    s.BEZEI,
    s.YQ3YZXSBL,
    s.YSZKZZTS,
    s.VTWEG,
    s.DHDAT,
    s.VKGRP_T,
    s.BSTKD_E,
    jt.zjtbl,
    zk.zktext,
    yx.zbezei
FROM sap_data.ZRFI011_99991231QTYS s
-- 公司代码清洗
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_COM com
    ON s.RBUKRS = com.sbukrs
-- 利润中心清洗（CN1）
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC prc1
    ON prc1.sysid = 'CN1' AND prc1.bukrs = s.RBUKRS AND prc1.sprctr = s.PRCTR AND prc1.bukrs != ''
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC prc2
    ON prc2.sysid = 'CN1' AND prc2.sprctr = s.PRCTR AND (prc2.bukrs = '' OR prc2.bukrs IS NULL)
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC prc3
    ON prc3.sysid = 'CN1' AND prc3.bukrs = s.RBUKRS AND prc3.sprctr = CONCAT('0000', s.PRCTR)
   AND prc3.bukrs != '' AND LEFT(s.PRCTR, 4) != '0000'
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC prc4
    ON prc4.sysid = 'CN1' AND prc4.sprctr = CONCAT('0000', s.PRCTR)
   AND (prc4.bukrs = '' OR prc4.bukrs IS NULL) AND LEFT(s.PRCTR, 4) != '0000'
-- 单项计提（CN1，取最新zbdat）
LEFT JOIN (
    SELECT sbukrs, kunnr, zjtbl
    FROM (
        SELECT sbukrs, kunnr, zjtbl,
               ROW_NUMBER() OVER (PARTITION BY sbukrs, kunnr ORDER BY zbdat DESC) AS rn
        FROM dwd_dcp.DWD_BW_ZTBPC010_05
        WHERE bic_zsys_id = 'CN1'
    ) t WHERE rn = 1
) jt ON s.RBUKRS = jt.sbukrs AND s.KUNNR = jt.kunnr
-- 考核利润中心
LEFT JOIN dwd_dcp.dwd_s4_zkhlz zk
    ON s.PRCTR = zk.prctr
-- 考核销售代表处
LEFT JOIN dwd_dcp.dwd_s4_zyxzx yx
    ON s.VKGRP = yx.vkgrp
-- 部门：有代表处编码用编码映射，否则用名称映射
LEFT JOIN staging_db.sales_office_mapping m_code
    ON s.VKBUR IS NOT NULL AND TRIM(s.VKBUR) != ''
   AND s.VKBUR = m_code.sales_office_code
LEFT JOIN staging_db.sales_office_mapping m_desc
    ON (s.VKBUR IS NULL OR TRIM(s.VKBUR) = '')
   AND COALESCE(NULLIF(TRIM(s.BEZEI_N), ''), NULLIF(TRIM(s.BEZEI), '')) = m_desc.sales_office_desc
WHERE s.RACCT LIKE '123101%' OR s.RACCT LIKE '123102%';
