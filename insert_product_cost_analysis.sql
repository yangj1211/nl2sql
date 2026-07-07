-- 产品成本分析表：数据来源 sap_data.zcor011_99991231
-- 筛选：MATKL（物料组）以 3 开头
-- cbukrs/cbuktx 从 DWD_BW_ZTBPC002_COM 取（sbukrs=BUKRS）
-- cprctr/cprctx 从 DWD_BW_ZTBPC002_PRC 取，优先精确匹配(sysid+bukrs+sprctr)，否则宽松匹配(sysid+sprctr, bukrs为空)，再补零匹配
TRUNCATE TABLE jst_flat.product_cost_analysis;

INSERT INTO jst_flat.product_cost_analysis
SELECT
  a.MJAHR, a.ZMONTH, a.ZWEEK, a.BUDAT,
  a.BUKRS, c.cbukrs, c.cbuktx,
  a.WERKS, w.NAME1, a.UMWRK, a.LGORT,
  a.PRCTR,
  COALESCE(d1.cprctr, d2.cprctr, d3.cprctr, d4.cprctr),
  COALESCE(d1.cprctx, d2.cprctx, d3.cprctx, d4.cprctx),
  a.NAM1, a.SETNAME, a.DESCRIPT,
  a.BKLAS, a.BWTAR, a.KALNR,
  a.SPART, a.VTEXT, a.MATKL, a.WGBEZ,
  a.MATNR, a.MAKTX,
  a.BWART, a.BTEXT,
  a.FEVOR, a.MEINS, a.MENGE,
  a.GUIGE_N, a.FERTH, a.ZMENGE,
  a.PVPRS1, a.PVPRS2,
  a.DMBTR, a.DMBTR1,
  a.WAERS,
  a.ZSCZZ, a.ZSCZZ1,
  a.CHARG, a.SOBKZ,
  a.MBLNR, a.ZEILE, a.XBLNR,
  a.VGART, a.BLART,
  a.MAT_KDAUF, a.MAT_KDPOS,
  a.EBELN, a.EBELP,
  a.AUFNR, a.MATNR_AUFNR,
  a.MAT_PSPNR, a.NPLNR, a.KOSTL,
  a.ZZ_FLAG, a.YWLX,
  a.KST001, a.KST003, a.KST005,
  a.KST007, a.KST009,
  a.KST011, a.KST013, a.KST015,
  a.KST017, a.KST019, a.KST021,
  a.KST023, a.KST025,
  a.KST027, a.KST029, a.KST031,
  a.KST033, a.KST035, a.KST037,
  a.SUM,
  a.FORMT, a.ZZ_IS_COIL_CHG
FROM sap_data.zcor011_99991231 a
-- 生产工厂描述
LEFT JOIN dwd_dcp.dwd_s4_t001w w
    ON a.WERKS = w.WERKS
-- 公司代码清洗
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_COM c
    ON a.BUKRS = c.sbukrs
-- 利润中心清洗：精确匹配(sysid=CN1 + bukrs + sprctr, bukrs不为空)
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC d1
    ON d1.sysid = 'CN1'
    AND d1.bukrs = a.BUKRS
    AND d1.sprctr = a.PRCTR
    AND d1.bukrs != ''
-- 利润中心清洗：宽松匹配(sysid=CN1 + sprctr, bukrs为空)
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC d2
    ON d2.sysid = 'CN1'
    AND d2.sprctr = a.PRCTR
    AND (d2.bukrs = '' OR d2.bukrs IS NULL)
-- 利润中心清洗：补零精确匹配(prctr前补0000, bukrs不为空)
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC d3
    ON d3.sysid = 'CN1'
    AND d3.bukrs = a.BUKRS
    AND d3.sprctr = CONCAT('0000', a.PRCTR)
    AND d3.bukrs != ''
    AND LEFT(a.PRCTR, 4) != '0000'
-- 利润中心清洗：补零宽松匹配(prctr前补0000, bukrs为空)
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC d4
    ON d4.sysid = 'CN1'
    AND d4.sprctr = CONCAT('0000', a.PRCTR)
    AND (d4.bukrs = '' OR d4.bukrs IS NULL)
    AND LEFT(a.PRCTR, 4) != '0000'
WHERE a.MATKL LIKE '3%';
