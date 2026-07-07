-- ============================================================
-- 预收账款（管口）- 数据插入
-- 目标表：jst_flat.advance_receipts
-- 中国数据：sap_data.ZRFIPA_99991231
-- cbukrs/cbuktx 从 DWD_BW_ZTBPC002_COM 取（sbukrs=BUKRS）
-- cprctr/cprctx 从 DWD_BW_ZTBPC002_PRC 取，优先精确匹配(sysid+bukrs+sprctr)，
--   否则宽松匹配(sysid+sprctr, bukrs为空)，再补零匹配
-- 部门映射：staging_db.sales_office_mapping
--   有 VKBUR 编码 → 仅按 sales_office_code；无编码 → VKBUR_BEZEI 按 sales_office_desc
-- ============================================================

TRUNCATE TABLE jst_flat.advance_receipts;

INSERT INTO jst_flat.advance_receipts
SELECT
    s.BUKRS,
    c.cbukrs,
    c.cbuktx,
    s.DMBTR_SUM,
    s.DMBTR_Z1,
    s.DMBTR_Z2,
    s.DMBTR_Z3,
    s.DMBTR_Z4,
    s.DMBTR_Z7,
    s.DMBTR_Z8,
    s.DMBTR_Z9,
    s.DMBTR_Z10,
    s.KUNNR,
    s.NAME1,
    s.VKBUR,
    s.VKBUR_BEZEI,
    COALESCE(m_code.dept_id, m_desc.dept_id)     AS dept_id,
    COALESCE(m_code.dept_name, m_desc.dept_name) AS dept_name,
    s.VKGRP,
    s.BEZEI,
    s.PRCTR,
    COALESCE(d1.cprctr, d2.cprctr, d3.cprctr, d4.cprctr) AS cprctr,
    COALESCE(d1.cprctx, d2.cprctx, d3.cprctx, d4.cprctx) AS cprctx,
    s.DESCRIPT,
    s.HKONT,
    s.TXT50,
    s.KHINR,
    s.BZIRK,
    s.BZIRK_BZTXT,
    s.KTEXT
FROM sap_data.ZRFIPA_99991231 s
-- 公司代码清洗
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_COM c
    ON s.BUKRS = c.sbukrs
-- 利润中心清洗：精确匹配(sysid=CN1 + bukrs + sprctr, bukrs不为空)
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC d1
    ON d1.sysid = 'CN1'
    AND d1.bukrs = s.BUKRS
    AND d1.sprctr = s.PRCTR
    AND d1.bukrs != ''
-- 利润中心清洗：宽松匹配(sysid=CN1 + sprctr, bukrs为空)
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC d2
    ON d2.sysid = 'CN1'
    AND d2.sprctr = s.PRCTR
    AND (d2.bukrs = '' OR d2.bukrs IS NULL)
-- 利润中心清洗：补零精确匹配(prctr前补0000, bukrs不为空)
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC d3
    ON d3.sysid = 'CN1'
    AND d3.bukrs = s.BUKRS
    AND d3.sprctr = CONCAT('0000', s.PRCTR)
    AND d3.bukrs != ''
    AND LEFT(s.PRCTR, 4) != '0000'
-- 利润中心清洗：补零宽松匹配(prctr前补0000, bukrs为空)
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC d4
    ON d4.sysid = 'CN1'
    AND d4.sprctr = CONCAT('0000', s.PRCTR)
    AND (d4.bukrs = '' OR d4.bukrs IS NULL)
    AND LEFT(s.PRCTR, 4) != '0000'
-- 部门：有代表处编码用编码映射，否则用名称映射
LEFT JOIN staging_db.sales_office_mapping m_code
    ON s.VKBUR IS NOT NULL AND TRIM(s.VKBUR) != ''
   AND s.VKBUR = m_code.sales_office_code
LEFT JOIN staging_db.sales_office_mapping m_desc
    ON (s.VKBUR IS NULL OR TRIM(s.VKBUR) = '')
   AND s.VKBUR_BEZEI IS NOT NULL AND TRIM(s.VKBUR_BEZEI) != ''
   AND s.VKBUR_BEZEI = m_desc.sales_office_desc;
