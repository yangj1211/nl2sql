-- ============================================================
-- 应收账款（实时）- 数据插入
-- 目标表：jst_flat.accounts_receivable_realtime
-- 底表：中国数据 sap_data.zfi0081_99991231
-- cbukrs/cbuktx 从 DWD_BW_ZTBPC002_COM 取（sbukrs=RBUKRS）
-- cprctr/cprctx 从 DWD_BW_ZTBPC002_PRC 取，优先精确匹配(sysid+bukrs+sprctr)，
--   否则宽松匹配(sysid+sprctr, bukrs为空)，再补零匹配
-- 部门映射：staging_db.business_unit_mapping
--   有 cprctr（清洗后利润中心）→ 按 business_unit_id；无 cprctr 不映射
-- ============================================================

TRUNCATE TABLE jst_flat.accounts_receivable_realtime;

INSERT INTO jst_flat.accounts_receivable_realtime (
  RBUKRS, cbukrs, cbuktx,
  PRCTR, cprctr, cprctx, dept_id, dept_name,
  DESCRIPT, RACCT, BEZEI, KTEXT, ZQNXS, BSTDK, VKGRP_T, Z_TERM_XCLEAR, Z_TERM_ZBKBL, NAME1, LEIB, Z_WAERK,
  Z_BSTKD, Z_ZFKB9, YS01, KZWI1, Z_DE_AMOUNT, YS02, Z_AR_DATE, KUNNR, YS03, VBELN, Z_XBLNR, YS04, KXXZ,
  Z_BLDAT, YS05, Z_QKXZ, YSYE, YS06, DSYQZE, Z_AD_AMOUNT, YS07, Z_IN_DAT, Z_IN_AMOUNT, YS08, Z_RE_DAT,
  Z_RE_AMOUNT, YS1Y, ZCBBA, ZCBDT, YQ10, TS, YQ11, Z_DB_RATE_1, Z_DB_RATE_2, YQ12, Z_DB_SUM, YQ13, ZFBDT,
  `TEXT`, ZENDUSER, YQ01, ZEXISTENCE, YQ02, ZCUS_RATE, Z_IS_COM, Z_REG_CAP, YQ03, Z_PAID_IN, Z_SHAREHOLDER,
  YQ04, Z_STAFF_SIZE, Z_IND_NUM, YQ05, Z_SUED_NUM_2, Z_IS_EXECUTION, RACCT_T, YQ06, YQ07, YQ08, YQ1Y, YQ2Y,
  YQ3Y, ZYY, ZSJFBDT, ZSJZE, Z_RYQ10, Z_RYQ11, Z_RYQ12, Z_RYQ01, Z_RYQ02, Z_RYQ03, Z_RYQ04, Z_RYQ05, Z_RYQ06,
  Z_RYQ07, Z_RYQ08, Z_RYQ1Y, Z_RYQ2Y, Z_RYQ3Y, COMP_HEAD, DESCRIPTION, Z_IS_DISHONEST, Z_PAY_DETAIL, ZSFYQ, ZZB,
  ZFHJL, ZFKJH, ZJHLS, ZSSZZ, ZWFYY, ZSJJBR, ZZTJD, ZTSSJ, ZTDSJ, ZHKLY, ZDQJD, ZFKKS, ZFKWC, ZYJHK, ZHKJE, ZFZR,
  ZLXR, ZKN, ZJY, Z_ZLXFS, Z_ZYFJE, Z_QKXZ_C, ZYDMQ3, ZYSYF, ZZBQR, ZZBQR_FORM, ZSFZBZN, ZWJFPT, YQ09,
  ZKTEXT, ZBEZEI, ZKXSFMQ, ZHTYDSXTS, ZYSBHRQ, ZLYHBRQ, ZZLHBRQ, ZZFHBRQ, ZZLTJ, ZZKRQ, ZDHRQ, ZJGRQ, ZJSRQ,
  ZSJRQ, ZFKSXSX, Z_RYQ13, Z_RYQ14, BSTKD_E, Z_TERM_CODE, Z_TERM_TEXT, Z_Z003_TEXT,
  ZYFYQJE, ZGLWTBZJ, ZSSMK, ZSHMK, ZSXED
)
SELECT
  s.RBUKRS,
  com.cbukrs,
  com.cbuktx,
  s.PRCTR,
  COALESCE(prc1.cprctr, prc2.cprctr, prc3.cprctr, prc4.cprctr) AS cprctr,
  COALESCE(prc1.cprctx, prc2.cprctx, prc3.cprctx, prc4.cprctx) AS cprctx,
  m_cprctr.dept_id     AS dept_id,
  m_cprctr.dept_name   AS dept_name,
  s.DESCRIPT,
  s.RACCT,
  s.BEZEI,
  s.KTEXT,
  s.ZQNXS,
  s.BSTDK,
  s.VKGRP_T,
  s.Z_TERM_XCLEAR,
  s.Z_TERM_ZBKBL,
  s.NAME1,
  s.LEIB,
  s.Z_WAERK,
  s.Z_BSTKD,
  s.Z_ZFKB9,
  s.YS01,
  s.KZWI1,
  s.Z_DE_AMOUNT,
  s.YS02,
  s.Z_AR_DATE,
  s.KUNNR,
  s.YS03,
  s.VBELN,
  s.Z_XBLNR,
  s.YS04,
  s.KXXZ,
  s.Z_BLDAT,
  s.YS05,
  s.Z_QKXZ,
  s.YSYE,
  s.YS06,
  s.DSYQZE,
  s.Z_AD_AMOUNT,
  s.YS07,
  s.Z_IN_DAT,
  s.Z_IN_AMOUNT,
  s.YS08,
  s.Z_RE_DAT,
  s.Z_RE_AMOUNT,
  s.YS1Y,
  s.ZCBBA,
  s.ZCBDT,
  s.YQ10,
  s.TS,
  s.YQ11,
  s.Z_DB_RATE_1,
  s.Z_DB_RATE_2,
  s.YQ12,
  s.Z_DB_SUM,
  s.YQ13,
  s.ZFBDT,
  s.`TEXT`,
  s.ZENDUSER,
  s.YQ01,
  s.ZEXISTENCE,
  s.YQ02,
  s.ZCUS_RATE,
  s.Z_IS_COM,
  s.Z_REG_CAP,
  s.YQ03,
  s.Z_PAID_IN,
  s.Z_SHAREHOLDER,
  s.YQ04,
  s.Z_STAFF_SIZE,
  s.Z_IND_NUM,
  s.YQ05,
  s.Z_SUED_NUM_2,
  s.Z_IS_EXECUTION,
  s.RACCT_T,
  s.YQ06,
  s.YQ07,
  s.YQ08,
  s.YQ1Y,
  s.YQ2Y,
  s.YQ3Y,
  s.ZYY,
  s.ZSJFBDT,
  s.ZSJZE,
  s.Z_RYQ10,
  s.Z_RYQ11,
  s.Z_RYQ12,
  s.Z_RYQ01,
  s.Z_RYQ02,
  s.Z_RYQ03,
  s.Z_RYQ04,
  s.Z_RYQ05,
  s.Z_RYQ06,
  s.Z_RYQ07,
  s.Z_RYQ08,
  s.Z_RYQ1Y,
  s.Z_RYQ2Y,
  s.Z_RYQ3Y,
  s.COMP_HEAD,
  s.DESCRIPTION,
  s.Z_IS_DISHONEST,
  s.Z_PAY_DETAIL,
  s.ZSFYQ,
  s.ZZB,
  s.ZFHJL,
  s.ZFKJH,
  s.ZJHLS,
  s.ZSSZZ,
  s.ZWFYY,
  s.ZSJJBR,
  s.ZZTJD,
  s.ZTSSJ,
  s.ZTDSJ,
  s.ZHKLY,
  s.ZDQJD,
  s.ZFKKS,
  s.ZFKWC,
  s.ZYJHK,
  s.ZHKJE,
  s.ZFZR,
  s.ZLXR,
  s.ZKN,
  s.ZJY,
  s.Z_ZLXFS,
  s.Z_ZYFJE,
  s.Z_QKXZ_C,
  s.ZYDMQ3,
  s.ZYSYF,
  s.ZZBQR,
  s.ZZBQR_FORM,
  s.ZSFZBZN,
  s.ZWJFPT,
  s.YQ09,
  s.ZKTEXT,
  s.ZBEZEI,
  s.ZKXSFMQ,
  s.ZHTYDSXTS,
  s.ZYSBHRQ,
  s.ZLYHBRQ,
  s.ZZLHBRQ,
  s.ZZFHBRQ,
  s.ZZLTJ,
  s.ZZKRQ,
  s.ZDHRQ,
  s.ZJGRQ,
  s.ZJSRQ,
  s.ZSJRQ,
  s.ZFKSXSX,
  s.Z_RYQ13,
  s.Z_RYQ14,
  s.BSTKD_E,
  s.Z_TERM_CODE,
  s.Z_TERM_TEXT,
  s.Z_Z003_TEXT,
  NULL AS ZYFYQJE,    -- 应付逾期金额（待开发）
  NULL AS ZGLWTBZJ,   -- 关联未退保证金（待开发）
  NULL AS ZSSMK,      -- 诉讼模块（待开发）
  NULL AS ZSHMK,      -- 售后模块（待开发）
  NULL AS ZSXED       -- 授信额度（待开发）
FROM sap_data.zfi0081_99991231 s
-- 公司代码清洗
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_COM com
  ON s.RBUKRS = com.sbukrs
-- 利润中心清洗：精确匹配(sysid=CN1 + bukrs + sprctr, bukrs不为空)
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC prc1
  ON prc1.sysid = 'CN1'
  AND prc1.bukrs = s.RBUKRS
  AND prc1.sprctr = s.PRCTR
  AND prc1.bukrs != ''
-- 利润中心清洗：宽松匹配(sysid=CN1 + sprctr, bukrs为空)
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC prc2
  ON prc2.sysid = 'CN1'
  AND prc2.sprctr = s.PRCTR
  AND (prc2.bukrs = '' OR prc2.bukrs IS NULL)
-- 利润中心清洗：补零精确匹配(prctr前补0000, bukrs不为空)
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC prc3
  ON prc3.sysid = 'CN1'
  AND prc3.bukrs = s.RBUKRS
  AND prc3.sprctr = CONCAT('0000', s.PRCTR)
  AND prc3.bukrs != ''
  AND LEFT(s.PRCTR, 4) != '0000'
-- 利润中心清洗：补零宽松匹配(prctr前补0000, bukrs为空)
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC prc4
  ON prc4.sysid = 'CN1'
  AND prc4.sprctr = CONCAT('0000', s.PRCTR)
  AND (prc4.bukrs = '' OR prc4.bukrs IS NULL)
  AND LEFT(s.PRCTR, 4) != '0000'
-- 部门：仅按清洗后利润中心 cprctr 映射
LEFT JOIN staging_db.business_unit_mapping m_cprctr
  ON COALESCE(prc1.cprctr, prc2.cprctr, prc3.cprctr, prc4.cprctr) IS NOT NULL
 AND TRIM(COALESCE(prc1.cprctr, prc2.cprctr, prc3.cprctr, prc4.cprctr)) != ''
 AND COALESCE(prc1.cprctr, prc2.cprctr, prc3.cprctr, prc4.cprctr) = m_cprctr.business_unit_id;
