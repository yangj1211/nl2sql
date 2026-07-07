-- ============================================================
-- 其它应收 - 数据插入
-- 目标表：jst_flat.receivable_monthly_other
-- 筛选：RACCT LIKE '123101%' OR RACCT LIKE '123102%'
-- 中国数据：sap_data.ZRFI011_99991231 (data_source = 'S4')
-- 美国数据：dws_dcp.DWS_YSZK_BM_WS   (data_source = 'BM')
-- 单项计提：dwd_dcp.DWD_BW_ZTBPC010_05 (CN1/US1, 取最新zbdat)
-- 公司清洗：DWD_BW_ZTBPC002_COM (sbukrs=RBUKRS) → cbukrs/cbuktx
-- 利润中心清洗：DWD_BW_ZTBPC002_PRC (CN1/US1，精确+宽松+补零) → cprctr/cprctx
-- 部门映射：staging_db.sales_office_mapping
--   有 VKBUR 编码 → 仅按 sales_office_code；无编码 → BEZEI_N/BEZEI 按 sales_office_desc
-- ============================================================

TRUNCATE TABLE jst_flat.receivable_monthly_other;

-- 显式列名：排除 MatrixOne 自动列 __mo_fake_pk_col，避免 schema 与插入列数不一致
INSERT INTO jst_flat.receivable_monthly_other (
    data_source, BSTDK, RBUKRS, cbukrs, cbuktx, VKBUR, BEZEI_N, dept_id, dept_name,
    VKGRP, VKGRP_TN, KUNNR, NAME1, VBELN, BSTKD_EN, KZWI1, YFHJE, YSYE, DSYQZE, BLDAT,
    KXXZ, TEXT1, YQ01, YQ02, YQ03, YQ04, YQ05, YQ06, YQ07, YQ08, JZ, ZOPAMT,
    YQ10, YQ11, YQ12, YS01, YS02, YS03, YS04, YS05, YS06, YS07, YS08, YQ09,
    YS1, YS2, YS3, YS4, YQ1, YQ2, YQ3, YQ4, YS1Y, YS2Y, YS3Y, YQ1Y, YQ2Y, YQ3Y,
    DESCRIPTION, DESCRIPT, LEADER, SETNAME, PRCTR, cprctr, cprctx, KTEXT, RACCT, RACCT_T,
    VTWEG_T, IND_SECTOR, YQ13, TEXT, COMP_HEAD, CREDIT_GROUP, CREDIT_GROUP_T, CRMXM, HTQRS,
    KVGR1, KVGR1_T, QRSZJE, YSK, WHKBL, YFHHKBL, HKZHTBL, JZDAT, TS, ZQNXS,
    DSYSYEZXSBL, YS1YZXSBL, YS2YZXSBL, YS3YZXSBL, DSYQZEZXSBL, YQ1YZXSBL, YQ2YZXSBL,
    BEZEI, YQ3YZXSBL, YSZKZZTS, VTWEG, DHDAT, VKGRP_T, BSTKD_E, ZJTBL, ZKTEXT, ZBEZEI, add_date
)
SELECT * FROM (
    -- ========== 中国数据 (S4) ==========
    SELECT
        'S4'                AS data_source,
        s.BSTDK,
        s.RBUKRS,
        com.cbukrs,
        com.cbuktx,
        s.VKBUR,
        s.BEZEI_N,
        COALESCE(m_code.dept_id, m_desc.dept_id)   AS dept_id,
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
        yx.zbezei,
        s.add_date
    FROM sap_data.ZRFI011_99991231 s
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
    WHERE s.RACCT LIKE '123101%' OR s.RACCT LIKE '123102%'

    UNION ALL

    -- ========== 美国数据 (BM) ==========
    -- 销售代表处固定 vkbur=6801、描述=美国销售团队；部门按 6801 映射
    -- 注意：dws_dcp.DWS_YSZK_BM_WS 中很多字段为 BOOL(0) 占位类型，
    -- 无法直接 CAST 为 DECIMAL/VARCHAR，统一用 NULL 替代。
    -- 仅保留有实际数据类型的字段（VARCHAR/DECIMAL/BIGINT）直接映射。
    SELECT
        'BM'                               AS data_source,
        NULL                               AS BSTDK,          -- bstdk: BOOL(0)
        b.rbukrs                           AS RBUKRS,         -- VARCHAR(50)
        com_b.cbukrs,
        com_b.cbuktx,
        '6801'                             AS VKBUR,
        '美国销售团队'                     AS BEZEI_N,
        m_bm.dept_id,
        m_bm.dept_name,
        NULL                               AS VKGRP,          -- 美国表无此字段
        NULL                               AS VKGRP_TN,       -- vkgrp_t: BOOL(0)
        b.kunnr                            AS KUNNR,          -- VARCHAR(100)
        b.name1                            AS NAME1,          -- VARCHAR(255)
        NULL                               AS VBELN,          -- vbeln: BOOL(0)
        NULL                               AS BSTKD_EN,       -- bstkd_e: BOOL(0)
        CAST(b.kzwi1 AS DECIMAL(38,2))    AS KZWI1,          -- BIGINT -> DECIMAL
        NULL                               AS YFHJE,          -- 美国表无此字段
        b.ysye                             AS YSYE,           -- DECIMAL(23,2)
        b.dsyqze                           AS DSYQZE,         -- DECIMAL(23,2)
        NULL                               AS BLDAT,          -- 美国表无此字段
        NULL                               AS KXXZ,           -- kxxz: BOOL(0)
        NULL                               AS TEXT1,          -- z_term_code: BOOL(0)
        b.yq01                             AS YQ01,           -- DECIMAL(23,2)
        b.yq02                             AS YQ02,
        b.yq03                             AS YQ03,
        b.yq04                             AS YQ04,
        b.yq05                             AS YQ05,
        b.yq06                             AS YQ06,
        b.yq07                             AS YQ07,
        b.yq08                             AS YQ08,
        NULL                               AS JZ,             -- 美国表无此字段
        NULL                               AS ZOPAMT,         -- 美国表无此字段
        b.yq10                             AS YQ10,           -- DECIMAL(23,2)
        b.yq11                             AS YQ11,
        b.yq12                             AS YQ12,
        b.ys01                             AS YS01,           -- DECIMAL(23,2)
        b.ys02                             AS YS02,
        b.ys03                             AS YS03,
        b.ys04                             AS YS04,
        b.ys05                             AS YS05,
        b.ys06                             AS YS06,
        b.ys07                             AS YS07,
        b.ys08                             AS YS08,
        CAST(b.yq09 AS DECIMAL(38,2))     AS YQ09,           -- BIGINT -> DECIMAL
        NULL                               AS YS1,            -- 美国表无此字段
        NULL                               AS YS2,
        NULL                               AS YS3,
        NULL                               AS YS4,
        NULL                               AS YQ1,
        NULL                               AS YQ2,
        NULL                               AS YQ3,
        NULL                               AS YQ4,
        b.ys1y                             AS YS1Y,           -- DECIMAL(23,2)
        NULL                               AS YS2Y,           -- 美国表无此字段
        NULL                               AS YS3Y,
        b.yq1y                             AS YQ1Y,           -- DECIMAL(23,2)
        b.yq2y                             AS YQ2Y,
        b.yq3y                             AS YQ3Y,
        NULL                               AS DESCRIPTION,    -- description: BOOL(0)
        NULL                               AS DESCRIPT,        -- descript: BOOL(0)
        NULL                               AS LEADER,          -- 美国表无此字段
        NULL                               AS SETNAME,         -- 美国表无此字段
        CAST(b.prctr AS VARCHAR(255))      AS PRCTR,           -- BIGINT -> VARCHAR
        COALESCE(prc_b1.cprctr, prc_b2.cprctr) AS cprctr,
        COALESCE(prc_b1.cprctx, prc_b2.cprctx) AS cprctx,
        NULL                               AS KTEXT,           -- ktext: BOOL(0)
        NULL                               AS RACCT,           -- racct: BOOL(0)
        NULL                               AS RACCT_T,         -- racct_t: BOOL(0)
        NULL                               AS VTWEG_T,         -- 美国表无此字段
        NULL                               AS IND_SECTOR,      -- 美国表无此字段
        b.yq13                             AS YQ13,            -- DECIMAL(23,2)
        NULL                               AS TEXT,            -- text: BOOL(0)
        NULL                               AS COMP_HEAD,       -- comp_head: BOOL(0)
        NULL                               AS CREDIT_GROUP,    -- 美国表无此字段
        NULL                               AS CREDIT_GROUP_T,
        NULL                               AS CRMXM,
        NULL                               AS HTQRS,
        NULL                               AS KVGR1,
        NULL                               AS KVGR1_T,
        NULL                               AS QRSZJE,
        NULL                               AS YSK,
        NULL                               AS WHKBL,
        NULL                               AS YFHHKBL,
        NULL                               AS HKZHTBL,
        b.add_date                         AS JZDAT,           -- VARCHAR(20)
        NULL                               AS TS,              -- ts: BOOL(0)
        NULL                               AS ZQNXS,           -- zqnxs: BOOL(0)
        NULL                               AS DSYSYEZXSBL,
        NULL                               AS YS1YZXSBL,
        NULL                               AS YS2YZXSBL,
        NULL                               AS YS3YZXSBL,
        NULL                               AS DSYQZEZXSBL,
        NULL                               AS YQ1YZXSBL,
        NULL                               AS YQ2YZXSBL,
        '美国销售团队'                     AS BEZEI,
        NULL                               AS YQ3YZXSBL,
        NULL                               AS YSZKZZTS,
        NULL                               AS VTWEG,
        NULL                               AS DHDAT,
        NULL                               AS VKGRP_T,         -- vkgrp_t: BOOL(0)
        NULL                               AS BSTKD_E,         -- bstkd_e: BOOL(0)
        jt2.zjtbl                          AS zjtbl,
        zk2.zktext                         AS zktext,
        '美国销售团队'                     AS zbezei,
        b.add_date
    FROM dws_dcp.DWS_YSZK_BM_WS b
    -- 公司代码清洗
    LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_COM com_b
        ON b.rbukrs = com_b.sbukrs
    -- 利润中心清洗（US1）
    LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC prc_b1
        ON prc_b1.sysid = 'US1' AND prc_b1.bukrs != '' AND prc_b1.bukrs IS NOT NULL
       AND prc_b1.bukrs = b.rbukrs AND prc_b1.sprctr = CAST(b.prctr AS VARCHAR(255))
    LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC prc_b2
        ON prc_b2.sysid = 'US1' AND (prc_b2.bukrs = '' OR prc_b2.bukrs IS NULL)
       AND prc_b2.sprctr = CAST(b.prctr AS VARCHAR(255))
    -- 单项计提（US1，取最新zbdat）
    LEFT JOIN (
        SELECT sbukrs, kunnr, zjtbl
        FROM (
            SELECT sbukrs, kunnr, zjtbl,
                   ROW_NUMBER() OVER (PARTITION BY sbukrs, kunnr ORDER BY zbdat DESC) AS rn
            FROM dwd_dcp.DWD_BW_ZTBPC010_05
            WHERE bic_zsys_id = 'US1'
        ) t WHERE rn = 1
    ) jt2 ON b.rbukrs = jt2.sbukrs AND b.kunnr = jt2.kunnr
    -- 考核利润中心
    LEFT JOIN dwd_dcp.dwd_s4_zkhlz zk2
        ON CAST(b.prctr AS VARCHAR(255)) = zk2.prctr
    -- 部门：美国固定代表处编码 6801
    LEFT JOIN staging_db.sales_office_mapping m_bm
        ON m_bm.sales_office_code = '6801'
) t;
