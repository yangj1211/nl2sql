-- ============================================================
-- 销售订单结果表 INSERT 语句
-- 源表: dwd_load.sales_orders
-- 目标表: jst_flat.sales_orders_result
-- ============================================================

INSERT INTO jst_flat.sales_orders_result (
  `期间`, `系统标识`, `凭证日期`, `凭证类型代码`, `凭证类型描述`,
  `销售订单`, `主销售订单号`, `交货行号`, `合同签订日期`, `订单类别`,
  `是否投标代码`, `是否投标描述`,
  `销售组织`, `销售组织描述`, `销售渠道`,
  `分销渠道代码`, `分销渠道描述`,
  `销售地区代码`, `销售地区描述`,
  `销售代表处代码`, `销售代表处`, `销售人员代码`, `销售员`,
  `客户`, `客户名称`, `控股方`, `是否关联`, `客户信用评级`, `客户首次合作日期`,
  `客户所在国家代码`, `客户所在国家`, `客户所在省份代码`, `客户所在省份`,
  `实际出口国家`,
  `行业代码`, `最终用户行业分类2描述`, `最终用户行业一类`, `最终用户行业二类`,
  `物料号`, `物料描述`, `型号`,
  `产品组`, `产品组描述`, `产品分类一级`, `产品分类二级`, `产品分类三级`,
  `利润中心代码`, `利润中心代码（清洗后）`, `利润中心描述（清洗后）`, `事业部描述`,
  `项目名称`,
  `数量`, `主机台数`, `主机单台数量`, `主机数量`,
  `货币`, `行项目金额(CNY)`, `行项目不含税金额(CNY)`,
  `行项目含税金额(订单货币)`, `行项目不含税金额(订单货币)`,
  `首次交货日期`
)
SELECT
  -- ========== 原始字段（直接取源表） ==========
  s.`期间`, s.`系统标识`,

  -- ========== 凭证日期: CN1取dwd_s4_vbak.audat, US1取dwd_bm_vbak.audat ==========
  CASE WHEN s.`系统标识` = 'CN1' THEN cn.audat WHEN s.`系统标识` = 'US1' THEN us.audat ELSE NULL END AS `凭证日期`,

  -- ========== 凭证类型代码: CN1取dwd_s4_vbak.auart, US1取dwd_bm_vbak.auart ==========
  CASE WHEN s.`系统标识` = 'CN1' THEN cn.auart WHEN s.`系统标识` = 'US1' THEN us.auart ELSE NULL END AS `凭证类型代码`,

  -- ========== 凭证类型描述: CN1取dwd_s4_tvakt.bezei, US1取dwd_bm_tvakt.bezei ==========
  CASE WHEN s.`系统标识` = 'CN1' THEN cn_tvakt.bezei WHEN s.`系统标识` = 'US1' THEN us_tvakt.bezei ELSE NULL END AS `凭证类型描述`,

  -- ========== 原始字段 ==========
  s.`销售订单`, s.`主销售订单号`, s.`交货行号`,

  -- ========== 合同签订日期: CN1取dwd_s4_vbkd.bstdk(POSNR='000000'), US1取dwd_bm_vbkd.bstdk ==========
  CASE WHEN s.`系统标识` = 'CN1' THEN cn_vbkd.bstdk WHEN s.`系统标识` = 'US1' THEN us_vbkd.bstdk ELSE NULL END AS `合同签订日期`,

  -- ========== 订单类别: CN1取dwd_s4_vbak.leib; US1根据dwd_bm_vbkd.inco1映射(CIF/DAP/DDP/EXW/FCA/FOB) ==========
  CASE
    WHEN s.`系统标识` = 'CN1' THEN cn.leib
    WHEN s.`系统标识` = 'US1' THEN
      CASE us_vbkd.inco1
        WHEN 'CIF' THEN '出口CIF'
        WHEN 'DAP' THEN '出口DAP'
        WHEN 'DDP' THEN '出口DDP'
        WHEN 'EXW' THEN '出口EXW'
        WHEN 'FCA' THEN '出口FCA'
        WHEN 'FOB' THEN '出口FOB'
        ELSE NULL
      END
    ELSE NULL
  END AS `订单类别`,

  -- ========== 是否投标代码: CN1取dwd_s4_vbak.kvgr5, US1为NULL ==========
  CASE WHEN s.`系统标识` = 'CN1' THEN cn.kvgr5 ELSE NULL END AS `是否投标代码`,

  -- ========== 是否投标描述: kvgr5='Y'→'是', 'N'→'否' ==========
  CASE WHEN s.`系统标识` = 'CN1' AND cn.kvgr5 = 'Y' THEN '是' WHEN s.`系统标识` = 'CN1' AND cn.kvgr5 = 'N' THEN '否' ELSE NULL END AS `是否投标描述`,

  -- ========== 销售组织: CN1通过dwd_s4_vbak.vkorg→ztbpc002_com.cbukrs; US1通过dwd_bm_vbak.vkorg→dwd_bm_tvko.bukrs→ztbpc002_com.cbukrs ==========
  CASE WHEN s.`系统标识` = 'CN1' THEN cn_com.cbukrs WHEN s.`系统标识` = 'US1' THEN us_com.cbukrs ELSE NULL END AS `销售组织`,

  -- ========== 销售组织描述: 通过(系统标识+销售组织=sbukrs)关联ztbpc002_com取cbuktx ==========
  org_desc.cbuktx AS `销售组织描述`,

  -- ========== 销售渠道: CN1根据vtweg判断(40/60→内销, 50→外销); US1默认'外销' ==========
  CASE WHEN s.`系统标识` = 'US1' THEN '外销' WHEN s.`系统标识` = 'CN1' AND cn.vtweg IN ('40','60') THEN '内销' WHEN s.`系统标识` = 'CN1' AND cn.vtweg = '50' THEN '外销' ELSE NULL END AS `销售渠道`,

  -- ========== 分销渠道代码: CN1取dwd_s4_vbak.vtweg, US1取dwd_bm_vbak.vtweg ==========
  CASE WHEN s.`系统标识` = 'CN1' THEN cn.vtweg WHEN s.`系统标识` = 'US1' THEN us.vtweg ELSE NULL END AS `分销渠道代码`,

  -- ========== 分销渠道描述: 通过vtweg关联dwd_s4_tvtwt取vtext ==========
  tvtwt.vtext AS `分销渠道描述`,

  -- ========== 销售地区代码: CN1取dwd_s4_vbkd.bzirk, US1取dwd_bm_vbkd.bzirk ==========
  CASE WHEN s.`系统标识` = 'CN1' THEN cn_vbkd.bzirk WHEN s.`系统标识` = 'US1' THEN us_vbkd.bzirk ELSE NULL END AS `销售地区代码`,

  -- ========== 销售地区描述: 通过(系统标识+bzirk)关联dim_t171t取bztxt ==========
  t171t.bztxt AS `销售地区描述`,

  -- ========== 销售代表处代码: CN1取dwd_s4_vbak.vkbur, US1取dwd_bm_vbak.vkbur ==========
  CASE WHEN s.`系统标识` = 'CN1' THEN cn.vkbur WHEN s.`系统标识` = 'US1' THEN us.vkbur ELSE NULL END AS `销售代表处代码`,

  -- ========== 销售代表处: 通过(系统标识+vkbur)关联dim_tvkbt取bezei ==========
  tvkbt.bezei AS `销售代表处`,

  -- ========== 销售人员代码: CN1取dwd_s4_vbak.vkgrp, US1为NULL ==========
  CASE WHEN s.`系统标识` = 'CN1' THEN cn.vkgrp ELSE NULL END AS `销售人员代码`,

  -- ========== 销售员: CN1通过vkgrp关联dwd_s4_tvgrt取bezei; US1默认'美国销售团队' ==========
  CASE WHEN s.`系统标识` = 'CN1' THEN tvgrt.bezei WHEN s.`系统标识` = 'US1' THEN '美国销售团队' ELSE NULL END AS `销售员`,

  -- ========== 原始字段 ==========
  s.`客户`,

  -- ========== 客户名称: CN1通过kunnr关联dwd_s4_kna1取name1; US1通过cvi_cust_link→but000取name_org1, 为空则fallback到dwd_bm_kna1.name1 ==========
  CASE
    WHEN s.`系统标识` = 'CN1' THEN cn_kna1.name1
    WHEN s.`系统标识` = 'US1' THEN
      CASE WHEN us_but.name_org1 IS NULL OR TRIM(us_but.name_org1) = '' THEN us_kna1.name1 ELSE us_but.name_org1 END
    ELSE NULL
  END AS `客户名称`,

  -- ========== 原始字段 ==========
  s.`控股方`,

  -- ========== 是否关联: 通过(客户+系统标识)关联dws_bpqx, cbugrp='OCT101'→'是', 其他→'否' ==========
  CASE WHEN bp.cbugrp = 'OCT101' THEN '是' ELSE '否' END AS `是否关联`,

  -- ========== 客户信用评级: CN1通过客户关联ukmbp_cms→ukm_cust_grp0t取cred_group_txt; US1为NULL ==========
  CASE WHEN s.`系统标识` = 'CN1' THEN cred_txt.cred_group_txt ELSE NULL END AS `客户信用评级`,

  -- ========== 客户首次合作日期: CN1通过partner关联dwd_s4_but000取found_dat; US1取dwd_bm_vbak中该客户最早erdat ==========
  CASE WHEN s.`系统标识` = 'CN1' THEN cn_but000.found_dat WHEN s.`系统标识` = 'US1' THEN us_min_erdat.min_erdat ELSE NULL END AS `客户首次合作日期`,

  -- ========== 客户所在国家代码: CN1取dwd_s4_kna1.land1, US1取dwd_bm_kna1.land1 ==========
  CASE WHEN s.`系统标识` = 'CN1' THEN cn_kna1.land1 WHEN s.`系统标识` = 'US1' THEN us_kna1.land1 ELSE NULL END AS `客户所在国家代码`,

  -- ========== 客户所在国家: 通过国家代码关联dwd_bw_bi0_tcountry取txtlg ==========
  country.txtlg AS `客户所在国家`,

  -- ========== 客户所在省份代码: CN1取dwd_s4_kna1.regio, US1取dwd_bm_kna1.regio ==========
  CASE WHEN s.`系统标识` = 'CN1' THEN cn_kna1.regio WHEN s.`系统标识` = 'US1' THEN us_kna1.regio ELSE NULL END AS `客户所在省份代码`,

  -- ========== 客户所在省份: 通过(国家代码+省份代码)关联dwd_bw_bi0_tregion取txtsh ==========
  region.txtsh AS `客户所在省份`,

  -- ========== 实际出口国家: CN1优先取vbak.zland1, 其次取交货方kna1.land1, 最后取客户kna1.land1; US1类似逻辑 ==========
  CASE
    WHEN s.`系统标识` = 'CN1' AND cn.zland1 IS NOT NULL AND TRIM(cn.zland1) != '' THEN cn.zland1
    WHEN s.`系统标识` = 'CN1' AND cn_dlv_kna1.land1 IS NOT NULL AND TRIM(cn_dlv_kna1.land1) != '' THEN cn_dlv_kna1.land1
    WHEN s.`系统标识` = 'US1' AND us_dlv_kna1.land1 IS NOT NULL AND TRIM(us_dlv_kna1.land1) != '' THEN us_dlv_kna1.land1
    WHEN s.`系统标识` = 'CN1' THEN cn_kna1.land1
    WHEN s.`系统标识` = 'US1' THEN us_kna1.land1
    ELSE NULL
  END AS `实际出口国家`,

  -- ========== 原始字段 ==========
  s.`行业代码`,

  -- ========== 最终用户行业分类2描述: 通过(系统标识+行业代码)关联ztbpc002_usr取ckvgtx, CN1需LPAD(行业代码,2,'0') ==========
  usr.ckvgtx AS `最终用户行业分类2描述`,

  -- ========== 最终用户行业一类: 同上关联取ckvgtx3 ==========
  usr.ckvgtx3 AS `最终用户行业一类`,

  -- ========== 最终用户行业二类: 同上关联取ckvgtx2 ==========
  usr.ckvgtx2 AS `最终用户行业二类`,

  -- ========== 原始字段 ==========
  s.`物料号`, s.`物料描述`, s.`型号`,
  s.`产品组`,

  -- ========== 产品组描述: 通过(系统标识+产品组)关联ztbpc002_pro取cspatx ==========
  pro.cspatx AS `产品组描述`,

  -- ========== 产品分类一级: 通过ztbpc002_pro.cspart关联b28_pkgdo4wi取b28_s_kgpoc3g ==========
  pw.b28_s_kgpoc3g AS `产品分类一级`,

  -- ========== 产品分类二级: 同上取b28_s_kgp4hnf ==========
  pw.b28_s_kgp4hnf AS `产品分类二级`,

  -- ========== 产品分类三级: 同上取b28_s_kgpn0dz ==========
  pw.b28_s_kgpn0dz AS `产品分类三级`,

  -- ========== 原始字段 ==========
  s.`利润中心代码`,

  -- ========== 利润中心代码（清洗后）: 通过(系统标识+利润中心代码+销售组织)关联ztbpc002_prc取cprctr, CN1需LPAD(利润中心代码,10,'0') ==========
  prc.cprctr AS `利润中心代码（清洗后）`,

  -- ========== 利润中心描述（清洗后）: 同上取cprctx ==========
  prc.cprctx AS `利润中心描述（清洗后）`,

  -- ========== 事业部描述: 通过cprctr向上钻取层级树(l1→l10), 找到PC_8位数字层级(事业部层级), ==========
  -- ========== 干变事业部(PC_11010101)特殊处理取PC_10位数字层级, 最终关联b28_tkgd4rtr取txtlg ==========
  dept_txt.txtlg AS `事业部描述`,

  -- ========== 项目名称: CN1取dwd_s4_vbkd.bstkd_e(POSNR='000000'), US1取dwd_bm_vbkd.bstkd ==========
  CASE WHEN s.`系统标识` = 'CN1' THEN cn_vbkd.bstkd_e WHEN s.`系统标识` = 'US1' THEN us_vbkd.bstkd ELSE NULL END AS `项目名称`,

  -- ========== 原始字段 ==========
  s.`数量`, s.`主机台数`, s.`主机单台数量`, s.`主机数量`,

  -- ========== 货币: CN1取dwd_s4_vbak.waerk, US1取dwd_bm_vbak.waerk ==========
  CASE WHEN s.`系统标识` = 'CN1' THEN cn.waerk WHEN s.`系统标识` = 'US1' THEN us.waerk ELSE NULL END AS `货币`,

  -- ========== 原始字段 ==========
  s.`行项目金额(CNY)`, s.`行项目不含税金额(CNY)`,
  s.`行项目含税金额(订单货币)`, s.`行项目不含税金额(订单货币)`,
  s.`首次交货日期`

-- ============================================================
-- FROM 及 JOIN 部分
-- ============================================================
FROM dwd_load.sales_orders s

-- ========== CN1销售订单抬头: 关联dwd_s4_vbak获取CN1的订单主数据(凭证日期/类型/渠道/代表处/销售员/货币等) ==========
LEFT JOIN dwd_dcp.dwd_s4_vbak cn
  ON s.`系统标识` = 'CN1' AND cn.vbeln = s.`销售订单`

-- ========== CN1销售组织映射: 通过vkorg关联ztbpc002_com获取CN1的cbukrs(销售组织) ==========
LEFT JOIN dwd_dcp.dwd_bw_ztbpc002_com cn_com
  ON s.`系统标识` = 'CN1' AND cn_com.sysid = s.`系统标识` AND cn_com.sbukrs = cn.vkorg

-- ========== US1销售订单抬头: 关联dwd_bm_vbak获取US1的订单主数据, 注意US1的vbeln需LPAD补零到10位 ==========
LEFT JOIN dwd_dcp.dwd_bm_vbak us
  ON s.`系统标识` = 'US1' AND us.vbeln = LPAD(s.`销售订单`, 10, '0')

-- ========== US1销售组织中间表: 通过vkorg关联dwd_bm_tvko获取bukrs ==========
LEFT JOIN dwd_dcp.dwd_bm_tvko us_tvko
  ON s.`系统标识` = 'US1' AND us_tvko.vkorg = us.vkorg

-- ========== US1销售组织映射: 通过bukrs关联ztbpc002_com获取US1的cbukrs(销售组织) ==========
LEFT JOIN dwd_dcp.dwd_bw_ztbpc002_com us_com
  ON s.`系统标识` = 'US1' AND us_com.sysid = s.`系统标识` AND us_com.sbukrs = us_tvko.bukrs

-- ========== 是否关联: 通过(客户+系统标识)关联dws_bpqx, 客户代码需LPAD补零到10位 ==========
LEFT JOIN (
  SELECT sysid, customer, MAX(cbugrp) AS cbugrp, MAX(partner) AS partner
  FROM dws_dcp.dws_bpqx
  WHERE customer != ''
  GROUP BY sysid, customer
) bp
  ON bp.customer = LPAD(s.`客户`, 10, '0') AND bp.sysid = s.`系统标识`

-- ========== 销售组织描述: 通过cbukrs二次关联ztbpc002_com取cbuktx ==========
LEFT JOIN dwd_dcp.dwd_bw_ztbpc002_com org_desc
  ON org_desc.sysid = s.`系统标识`
  AND org_desc.cbukrs = CASE
    WHEN s.`系统标识` = 'CN1' THEN cn_com.cbukrs
    WHEN s.`系统标识` = 'US1' THEN us_com.cbukrs
    ELSE NULL
  END

-- ========== CN1客户主数据: 关联dwd_s4_kna1获取客户名称/国家/省份, kunnr需LPAD补零到10位 ==========
LEFT JOIN dwd_dcp.dwd_s4_kna1 cn_kna1
  ON s.`系统标识` = 'CN1' AND cn_kna1.kunnr = LPAD(s.`客户`, 10, '0')

-- ========== US1客户名称(步骤1): 通过kunnr关联cvi_cust_link获取partner_guid ==========
LEFT JOIN dwd_dcp.dwd_bm_cvi_cust_link us_cl
  ON s.`系统标识` = 'US1' AND us_cl.customer = us.kunnr

-- ========== US1客户名称(步骤2): 通过partner_guid关联but000获取name_org1 ==========
LEFT JOIN dwd_dcp.dwd_bm_but000 us_but
  ON s.`系统标识` = 'US1' AND us_but.partner_guid = us_cl.partner_guid

-- ========== US1客户名称(fallback): 当name_org1为空时, 通过kunnr关联dwd_bm_kna1取name1 ==========
LEFT JOIN dwd_dcp.dwd_bm_kna1 us_kna1
  ON s.`系统标识` = 'US1' AND us_kna1.kunnr = us.kunnr

-- ========== CN1订单行项目: 关联dwd_s4_vbkd(POSNR='000000')获取合同签订日期/项目名称/销售地区/订单类别 ==========
LEFT JOIN dwd_dcp.dwd_s4_vbkd cn_vbkd
  ON s.`系统标识` = 'CN1' AND cn_vbkd.vbeln = s.`销售订单` AND cn_vbkd.posnr = '000000'

-- ========== US1订单行项目: 关联dwd_bm_vbkd(POSNR='000000')获取合同签订日期/项目名称/销售地区/订单类别 ==========
LEFT JOIN dwd_dcp.dwd_bm_vbkd us_vbkd
  ON s.`系统标识` = 'US1' AND us_vbkd.vbeln = LPAD(s.`销售订单`, 10, '0') AND us_vbkd.posnr = '000000'

-- ========== 最终用户行业: 通过(系统标识+行业代码)关联ztbpc002_usr, CN1的行业代码需LPAD(2,'0') ==========
LEFT JOIN dwd_dcp.dwd_bw_ztbpc002_usr usr
  ON usr.sysid = s.`系统标识`
  AND CASE WHEN s.`系统标识` = 'CN1' THEN LPAD(s.`行业代码`, 2, '0') ELSE s.`行业代码` END = usr.skvgr1

-- ========== 销售代表处描述: 通过(系统标识+vkbur)关联dim_tvkbt取bezei ==========
LEFT JOIN dws_dcp.dim_tvkbt tvkbt
  ON tvkbt.sysid = s.`系统标识`
  AND tvkbt.vkbur = CASE WHEN s.`系统标识` = 'CN1' THEN cn.vkbur WHEN s.`系统标识` = 'US1' THEN us.vkbur ELSE NULL END

-- ========== CN1销售员: 通过vkgrp关联dwd_s4_tvgrt取bezei ==========
LEFT JOIN dwd_dcp.dwd_s4_tvgrt tvgrt
  ON s.`系统标识` = 'CN1' AND tvgrt.vkgrp = cn.vkgrp

-- ========== 利润中心清洗: 通过(系统标识+利润中心代码+销售组织)关联ztbpc002_prc ==========
-- ========== CN1的利润中心代码需LPAD补零到10位, US1直接使用原值(如68P001) ==========
-- ========== bukrs为空时只匹配sprctr, 不为空时还需匹配销售组织 ==========
LEFT JOIN dwd_dcp.dwd_bw_ztbpc002_prc prc
  ON prc.sysid = s.`系统标识`
  AND prc.sprctr = CASE WHEN s.`系统标识` = 'CN1' THEN LPAD(s.`利润中心代码`, 10, '0') ELSE s.`利润中心代码` END
  AND (prc.bukrs = '' OR prc.bukrs = CASE WHEN s.`系统标识` = 'CN1' THEN cn_com.cbukrs WHEN s.`系统标识` = 'US1' THEN us_com.cbukrs ELSE NULL END)

-- ========== 事业部层级树: 从cprctr出发, 通过parenth1逐级向上钻取(最多10层) ==========
-- ========== 用于找到事业部层级(PC_8位数字), 干变事业部(PC_11010101)特殊处理 ==========
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_dkgd4rtr l1 ON l1.cpmb_kgd4rtr = prc.cprctr
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_dkgd4rtr l2 ON l2.cpmb_kgd4rtr = l1.parenth1
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_dkgd4rtr l3 ON l3.cpmb_kgd4rtr = l2.parenth1
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_dkgd4rtr l4 ON l4.cpmb_kgd4rtr = l3.parenth1
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_dkgd4rtr l5 ON l5.cpmb_kgd4rtr = l4.parenth1
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_dkgd4rtr l6 ON l6.cpmb_kgd4rtr = l5.parenth1
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_dkgd4rtr l7 ON l7.cpmb_kgd4rtr = l6.parenth1
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_dkgd4rtr l8 ON l8.cpmb_kgd4rtr = l7.parenth1
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_dkgd4rtr l9 ON l9.cpmb_kgd4rtr = l8.parenth1
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_dkgd4rtr l10 ON l10.cpmb_kgd4rtr = l9.parenth1

-- ========== 事业部描述文本: 通过事业部层级代码关联b28_tkgd4rtr取txtlg ==========
-- ========== 层级判断逻辑: PC_8位数字=事业部层级, 遇到PC_11010101(干变事业部)则取上一层(PC_10位数字) ==========
LEFT JOIN dwd_dcp.dwd_bw_b28_tkgd4rtr dept_txt
  ON dept_txt.b28_s_kgd4rtr = CASE
    WHEN l1.cpmb_kgd4rtr RLIKE '^PC_[0-9]{8}$' AND l1.cpmb_kgd4rtr != 'PC_11010101' THEN l1.cpmb_kgd4rtr
    WHEN l2.cpmb_kgd4rtr = 'PC_11010101' THEN l1.cpmb_kgd4rtr
    WHEN l2.cpmb_kgd4rtr RLIKE '^PC_[0-9]{8}$' THEN l2.cpmb_kgd4rtr
    WHEN l3.cpmb_kgd4rtr = 'PC_11010101' THEN l2.cpmb_kgd4rtr
    WHEN l3.cpmb_kgd4rtr RLIKE '^PC_[0-9]{8}$' THEN l3.cpmb_kgd4rtr
    WHEN l4.cpmb_kgd4rtr = 'PC_11010101' THEN l3.cpmb_kgd4rtr
    WHEN l4.cpmb_kgd4rtr RLIKE '^PC_[0-9]{8}$' THEN l4.cpmb_kgd4rtr
    WHEN l5.cpmb_kgd4rtr = 'PC_11010101' THEN l4.cpmb_kgd4rtr
    WHEN l5.cpmb_kgd4rtr RLIKE '^PC_[0-9]{8}$' THEN l5.cpmb_kgd4rtr
    WHEN l6.cpmb_kgd4rtr = 'PC_11010101' THEN l5.cpmb_kgd4rtr
    WHEN l6.cpmb_kgd4rtr RLIKE '^PC_[0-9]{8}$' THEN l6.cpmb_kgd4rtr
    WHEN l7.cpmb_kgd4rtr = 'PC_11010101' THEN l6.cpmb_kgd4rtr
    WHEN l7.cpmb_kgd4rtr RLIKE '^PC_[0-9]{8}$' THEN l7.cpmb_kgd4rtr
    WHEN l8.cpmb_kgd4rtr = 'PC_11010101' THEN l7.cpmb_kgd4rtr
    WHEN l8.cpmb_kgd4rtr RLIKE '^PC_[0-9]{8}$' THEN l8.cpmb_kgd4rtr
    WHEN l9.cpmb_kgd4rtr = 'PC_11010101' THEN l8.cpmb_kgd4rtr
    WHEN l9.cpmb_kgd4rtr RLIKE '^PC_[0-9]{8}$' THEN l9.cpmb_kgd4rtr
    WHEN l10.cpmb_kgd4rtr = 'PC_11010101' THEN l9.cpmb_kgd4rtr
    WHEN l10.cpmb_kgd4rtr RLIKE '^PC_[0-9]{8}$' THEN l10.cpmb_kgd4rtr
    ELSE NULL
  END

-- ========== 产品组/产品分类: 通过(系统标识+产品组)关联ztbpc002_pro取cspart, 再关联b28_pkgdo4wi取分类 ==========
-- ========== 产品组为1位时需LPAD补零到2位 ==========
LEFT JOIN dwd_dcp.dwd_bw_ztbpc002_pro pro
  ON pro.sysid = s.`系统标识` AND pro.sspart = CASE WHEN CHAR_LENGTH(s.`产品组`) = 1 THEN LPAD(s.`产品组`, 2, '0') ELSE s.`产品组` END

-- ========== 产品分类维度表: 通过cspart关联b28_pkgdo4wi获取一/二/三级分类 ==========
LEFT JOIN dwd_dcp.dwd_bw_b28_pkgdo4wi pw
  ON pw.b28_s_kgdo4wi = pro.cspart

-- ========== CN1凭证类型描述: 通过auart关联dwd_s4_tvakt取bezei ==========
LEFT JOIN dwd_dcp.dwd_s4_tvakt cn_tvakt
  ON s.`系统标识` = 'CN1' AND cn_tvakt.auart = cn.auart

-- ========== US1凭证类型描述: 通过auart关联dwd_bm_tvakt取bezei ==========
LEFT JOIN dwd_dcp.dwd_bm_tvakt us_tvakt
  ON s.`系统标识` = 'US1' AND us_tvakt.auart = us.auart

-- ========== 客户所在国家: 通过国家代码关联dwd_bw_bi0_tcountry取txtlg ==========
LEFT JOIN dwd_dcp.dwd_bw_bi0_tcountry country
  ON country.country = CASE WHEN s.`系统标识` = 'CN1' THEN cn_kna1.land1 WHEN s.`系统标识` = 'US1' THEN us_kna1.land1 ELSE NULL END

-- ========== 分销渠道描述: 通过vtweg关联dwd_s4_tvtwt取vtext ==========
LEFT JOIN dwd_dcp.dwd_s4_tvtwt tvtwt
  ON tvtwt.vtweg = CASE WHEN s.`系统标识` = 'CN1' THEN cn.vtweg WHEN s.`系统标识` = 'US1' THEN us.vtweg ELSE NULL END

-- ========== 客户所在省份: 通过(国家代码+省份代码)关联dwd_bw_bi0_tregion取txtsh ==========
LEFT JOIN dwd_dcp.dwd_bw_bi0_tregion region
  ON region.country = CASE WHEN s.`系统标识` = 'CN1' THEN cn_kna1.land1 WHEN s.`系统标识` = 'US1' THEN us_kna1.land1 ELSE NULL END
  AND region.region = CASE WHEN s.`系统标识` = 'CN1' THEN cn_kna1.regio WHEN s.`系统标识` = 'US1' THEN us_kna1.regio ELSE NULL END

-- ========== CN1实际出口国家(交货方): 通过销售订单+交货行号找到交货单(lips→likp), 再取交货方的国家 ==========
LEFT JOIN (
  SELECT vgbel, vgpos, MIN(vbeln) AS vbeln FROM dwd_dcp.dwd_s4_lips WHERE vgbel != '' GROUP BY vgbel, vgpos
) cn_lips
  ON s.`系统标识` = 'CN1' AND cn_lips.vgbel = s.`销售订单` AND cn_lips.vgpos = LPAD(s.`交货行号`, 6, '0')
LEFT JOIN dwd_dcp.dwd_s4_likp cn_likp
  ON cn_lips.vbeln IS NOT NULL AND cn_likp.vbeln = cn_lips.vbeln
LEFT JOIN dwd_dcp.dwd_s4_kna1 cn_dlv_kna1
  ON cn_likp.kunnr IS NOT NULL AND cn_dlv_kna1.kunnr = cn_likp.kunnr

-- ========== US1实际出口国家(交货方): 同CN1逻辑, 使用dwd_bm_前缀的表 ==========
LEFT JOIN (
  SELECT vgbel, vgpos, MIN(vbeln) AS vbeln FROM dwd_dcp.dwd_bm_lips WHERE vgbel != '' GROUP BY vgbel, vgpos
) us_lips
  ON s.`系统标识` = 'US1' AND us_lips.vgbel = LPAD(s.`销售订单`, 10, '0') AND us_lips.vgpos = LPAD(s.`交货行号`, 6, '0')
LEFT JOIN dwd_dcp.dwd_bm_likp us_likp
  ON us_lips.vbeln IS NOT NULL AND us_likp.vbeln = us_lips.vbeln
LEFT JOIN dwd_dcp.dwd_bm_kna1 us_dlv_kna1
  ON us_likp.kunnr IS NOT NULL AND us_dlv_kna1.kunnr = us_likp.kunnr

-- ========== 销售地区描述: 通过(系统标识+bzirk)关联dim_t171t取bztxt ==========
LEFT JOIN dws_dcp.dim_t171t t171t
  ON t171t.sysid = s.`系统标识`
  AND t171t.bzirk = CASE WHEN s.`系统标识` = 'CN1' THEN cn_vbkd.bzirk WHEN s.`系统标识` = 'US1' THEN us_vbkd.bzirk ELSE NULL END

-- ========== CN1客户首次合作日期: 通过partner关联dwd_s4_but000取found_dat ==========
LEFT JOIN dwd_dcp.dwd_s4_but000 cn_but000
  ON s.`系统标识` = 'CN1' AND cn_but000.partner = bp.partner

-- ========== US1客户首次合作日期: 取该客户在dwd_bm_vbak中最早的erdat ==========
LEFT JOIN (
  SELECT kunnr, MIN(erdat) AS min_erdat FROM dwd_dcp.dwd_bm_vbak WHERE kunnr != '' GROUP BY kunnr
) us_min_erdat
  ON s.`系统标识` = 'US1' AND us_min_erdat.kunnr = LPAD(s.`客户`, 10, '0')

-- ========== CN1客户信用评级: 通过客户代码关联ukmbp_cms取credit_group, 再关联ukm_cust_grp0t取描述 ==========
LEFT JOIN dwd_dcp.dwd_s4_ukmbp_cms ukm
  ON ukm.partner = LPAD(s.`客户`, 10, '0')
LEFT JOIN dwd_dcp.dwd_s4_ukm_cust_grp0t cred_txt
  ON cred_txt.cred_group = ukm.credit_group;
