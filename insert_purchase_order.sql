INSERT INTO jst_flat.purchase_order (
    ebeln, ebelp, loekz, bstyp, bstyp_text, bsart, bsart_text, pstyp, bedat, frgke, memory, ernam,
    bukrs, sbuktx, cbukrs, cbuktx, ekorg, ekgrp, eknam, werks, werks_name, lgort, lgobe,
    knttp, knttp_text, kostl, kostl_text, anln1, prctr, cprctr, cprctx,
    lifnr, lifnr_name,
    matnr, txz01, matkl, wgbez, infnr, zlb, zcjlb, zph,
    menge, meins, lmein, bprme, lagmg,
    netpr, peinh, unit_price, netwr, waers, rlwrt,
    mwskz, mwskz_text,
    bednr, open_qty, open_val, open_inv_qty, open_inv_val
)
SELECT
    base.ebeln,
    base.ebelp,
    base.loekz,
    base.bstyp,
    -- 根据BSTYP硬编码映射
    CASE base.bstyp
        WHEN 'A' THEN '询价'
        WHEN 'B' THEN '采购申请'
        WHEN 'F' THEN '采购订单'
        WHEN 'I' THEN '信息记录'
        WHEN 'K' THEN '合同'
        WHEN 'L' THEN '计划协议'
        WHEN 'Q' THEN '服务输入表'
        WHEN 'W' THEN '货源清单'
        WHEN 'S' THEN '简化的服务条目表'
        WHEN 'R' THEN '询价'
        WHEN 'O' THEN '报价'
        WHEN 'C' THEN '集中采购合同'
        ELSE base.bstyp
    END AS bstyp_text,
    base.bsart,
    t161t.batxt AS bsart_text,
    base.pstyp,
    base.bedat,
    base.frgke,
    base.memory,
    base.ernam,
    base.bukrs,
    com.sbuktx,
    com.cbukrs,
    com.cbuktx,
    base.ekorg,
    base.ekgrp,
    t024.eknam,
    base.werks,
    t001w.name1 AS werks_name,
    base.lgort,
    t001l.lgobe,
    base.knttp,
    t163i.knttx AS knttp_text,
    base.kostl,
    cskt.ktext AS kostl_text,
    base.anln1,
    base.prctr,
    -- 利润中心清洗: 优先精确匹配(sysid+bukrs+sprctr)，其次通用匹配(sysid+sprctr)
    COALESCE(prc_exact.cprctr, prc_gen.cprctr) AS cprctr,
    COALESCE(prc_exact.cprctx, prc_gen.cprctx) AS cprctx,
    base.lifnr,
    -- 供应商名称: EKKO.LIFNR=LFA1.LIFNR
    lfa1.name1 AS lifnr_name,
    base.matnr,
    base.txz01,
    base.matkl,
    -- 物料组描述: EKPO.MATKL=T023T.MATKL, T023T.SPRAS='1'
    t023t.wgbez,
    base.infnr,
    ggpzb.zlb,
    ggpzb.zcjlb,
    ggpzb.zph,
    base.menge,
    base.meins,
    base.lmein,
    base.bprme,
    -- SKU数量 = MENGE * UMREZ / UMREN
    base.menge * base.umrez / NULLIF(base.umren, 0) AS lagmg,
    base.netpr,
    base.peinh,
    -- 采购不含税单价 = NETPR / PEINH
    base.netpr / NULLIF(base.peinh, 0) AS unit_price,
    base.netwr,
    base.waers,
    base.rlwrt,
    base.mwskz,
    t007s.text1 AS mwskz_text,
    base.bednr,
    -- 仍要交货数量: ELIKZ='X'或LOEKZ='L'则为0，否则 = MENGE - 已收货数量(EKBE VGABE='1', S正H负)
    CASE
        WHEN base.elikz = 'X' OR base.loekz = 'L' THEN 0
        ELSE base.menge - COALESCE(ekbe_agg.gr_qty, 0)
    END AS open_qty,
    -- 仍要交货价值 = 仍要交货数量 * (NETPR / PEINH)
    CASE
        WHEN base.elikz = 'X' OR base.loekz = 'L' THEN 0
        ELSE (base.menge - COALESCE(ekbe_agg.gr_qty, 0)) * (base.netpr / NULLIF(base.peinh, 0))
    END AS open_val,
    -- 仍要开票数量: EREKZ='X'或LOEKZ='L'则为0，否则 = MENGE - 已发票数量(EKBE VGABE='2', S正H负)
    CASE
        WHEN base.erekz = 'X' OR base.loekz = 'L' THEN 0
        ELSE base.menge - COALESCE(ekbe_agg.iv_qty, 0)
    END AS open_inv_qty,
    -- 仍要开票价值 = 仍要开票数量 * (NETPR / PEINH)
    CASE
        WHEN base.erekz = 'X' OR base.loekz = 'L' THEN 0
        ELSE (base.menge - COALESCE(ekbe_agg.iv_qty, 0)) * (base.netpr / NULLIF(base.peinh, 0))
    END AS open_inv_val

-- 主表: EKKO + EKPO + EKKN 合并，预计算利润中心
-- 以 EKKO 抬头为主表，保证只有采购订单抬头、暂无行项目的单据也能进入大表
FROM (
    SELECT
        hd.ebeln, po.ebelp, po.loekz, hd.bstyp, po.pstyp, po.knttp, po.lgort,
        po.matnr, po.txz01, po.matkl, po.infnr, po.bprme, po.lmein,
        po.menge, po.meins, po.netpr, po.peinh, po.netwr, po.mwskz, po.bednr,
        po.umrez, po.umren, po.elikz, po.erekz, po.ko_prctr, po.werks,
        hd.bsart, hd.bedat, hd.frgke, hd.memory, hd.ernam, hd.bukrs, hd.ekorg,
        hd.ekgrp, hd.lifnr, hd.waers, hd.rlwrt,
        acct.kostl,
        acct.anln1,
        -- EKKN.PRCTR优先，为空则取EKPO.KO_PRCTR
        CASE WHEN acct.prctr IS NOT NULL AND acct.prctr != '' THEN acct.prctr ELSE po.ko_prctr END AS prctr
    FROM dwd_dcp.dwd_s4_ekko hd
    LEFT JOIN dwd_dcp.DWD_S4_EKPO po
        ON hd.ebeln = po.ebeln
    LEFT JOIN dwd_dcp.DWD_S4_EKKN acct
        ON po.ebeln = acct.ebeln
       AND po.ebelp = acct.ebelp
       AND acct.zekkn = '01'
    -- frgke（批准标识）允许为空；排除删除标识为L的行项目和EKKO.MEMORY='X'的暂存订单
    WHERE (po.loekz IS NULL OR po.loekz != 'L')
      AND COALESCE(TRIM(hd.memory), '') != 'X'
) base
-- 采购组描述
LEFT JOIN dwd_dcp.DWD_S4_T024 t024
    ON base.ekgrp = t024.ekgrp

-- 供应商名称: LIFNR
LEFT JOIN dwd_dcp.dwd_s4_lfa1 lfa1
    ON base.lifnr = lfa1.lifnr

-- 工厂名称
LEFT JOIN dwd_dcp.DWD_S4_T001W t001w
    ON base.werks = t001w.werks

-- 税码描述: SPRAS='1', KALSM='TAXCN'
LEFT JOIN dwd_dcp.DWD_S4_T007S t007s
    ON base.mwskz = t007s.mwskz
   AND t007s.spras = '1'
   AND t007s.kalsm = 'TAXCN'

-- 采购凭证类型描述: SPRAS='1', BSTYP='F'
LEFT JOIN dwd_dcp.DWD_S4_T161T t161t
    ON base.bsart = t161t.bsart
   AND t161t.bstyp = 'F'
   AND t161t.spras = '1'

-- 科目分配类别描述: SPRAS='1'
LEFT JOIN dwd_dcp.DWD_S4_T163I t163i
    ON base.knttp = t163i.knttp
   AND t163i.spras = '1'

-- 成本中心描述: SPRAS='1', DATBI='99991231'
LEFT JOIN dwd_dcp.DWD_S4_CSKT cskt
    ON base.kostl = cskt.kostl
   AND cskt.spras = '1'
   AND cskt.datbi = '99991231'

-- 库存地点描述: WERKS + LGORT
LEFT JOIN dwd_dcp.DWD_S4_T001L t001l
    ON base.werks = t001l.werks
   AND base.lgort = t001l.lgort

-- 物料组描述: SPRAS='1'
LEFT JOIN dwd_dcp.DWD_S4_T023T t023t
    ON base.matkl = t023t.matkl
   AND t023t.spras = '1'

-- 物料扩展: ZLB/ZCJLB/ZPH
LEFT JOIN dwd_dcp.dwd_s4_ZMM_GGPZB ggpzb
    ON base.matnr = ggpzb.matnr

-- 公司代码映射: SBUKTX/CBUKRS/CBUKTX
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_COM com
    ON base.bukrs = com.sbukrs

-- 利润中心映射(精确): sysid='CN1', bukrs不为空
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC prc_exact
    ON prc_exact.sysid = 'CN1'
   AND base.bukrs = prc_exact.bukrs
   AND base.prctr = prc_exact.sprctr
   AND prc_exact.bukrs IS NOT NULL AND prc_exact.bukrs != ''

-- 利润中心映射(通用): sysid='CN1', bukrs为空
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC prc_gen
    ON prc_gen.sysid = 'CN1'
   AND base.prctr = prc_gen.sprctr
   AND (prc_gen.bukrs IS NULL OR prc_gen.bukrs = '')

-- 采购历史: 收货数量(VGABE='1')和发票数量(VGABE='2'), S正H负
LEFT JOIN (
    SELECT ebeln, ebelp,
           SUM(CASE WHEN vgabe = '1' AND shkzg = 'S' THEN menge
                    WHEN vgabe = '1' AND shkzg = 'H' THEN -menge ELSE 0 END) AS gr_qty,
           SUM(CASE WHEN vgabe = '2' AND shkzg = 'S' THEN menge
                    WHEN vgabe = '2' AND shkzg = 'H' THEN -menge ELSE 0 END) AS iv_qty
    FROM dwd_dcp.dwd_s4_ekbe
    WHERE vgabe IN ('1', '2')
    GROUP BY ebeln, ebelp
) ekbe_agg
    ON base.ebeln = ekbe_agg.ebeln
   AND base.ebelp = ekbe_agg.ebelp;
