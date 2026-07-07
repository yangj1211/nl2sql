-- ============================================================
-- 其他应付款（管口）- 数据插入
-- 目标表：jst_flat.other_payable
-- 中国数据：sap_data.zfiryffx_99991231QTYF
-- cbukrs/cbuktx 从 DWD_BW_ZTBPC002_COM 取（sbukrs=BUKRS）
-- cprctr/cprctx 从 DWD_BW_ZTBPC002_PRC 取，优先精确匹配(sysid+bukrs+sprctr)，
--   否则宽松匹配(sysid+sprctr, bukrs为空)，再补零匹配
-- ============================================================

TRUNCATE TABLE jst_flat.other_payable;

INSERT INTO jst_flat.other_payable
SELECT
    s.BUKRS,
    c.cbukrs,
    c.cbuktx,
    s.LIFNR,
    s.NAME1,
    s.HKONT,
    s.TXT50,
    s.KHINR,
    s.DESCRIPT,
    s.PRCTR,
    COALESCE(d1.cprctr, d2.cprctr, d3.cprctr, d4.cprctr) AS cprctr,
    COALESCE(d1.cprctx, d2.cprctx, d3.cprctx, d4.cprctx) AS cprctx,
    s.KTEXT,
    s.DMBTR_SUM,
    s.DMBTR_Z1,
    s.DMBTR_Z2,
    s.DMBTR_Z3,
    s.DMBTR_Z4,
    s.DMBTR_Z7,
    s.DMBTR_Z8,
    s.DMBTR_Z9,
    s.DMBTR_Z10,
    s.DMBTR_SUM_YQ,
    s.YQYS_RATE,
    s.DMBTR_F1,
    s.DMBTR_F2,
    s.DMBTR_F3,
    s.DMBTR_F4,
    s.DMBTR_F7,
    s.DMBTR_F8,
    s.DMBTR_F9,
    s.DMBTR_F10
FROM sap_data.zfiryffx_99991231QTYF s
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
    AND LEFT(s.PRCTR, 4) != '0000';
