-- 资产台账表 数据插入
-- 基表: sap_data.zfi0056_99991231

INSERT INTO jst_flat.asset_ledger (
    anln1, anln2, txt50, menge, meins, txk20,
    bukrs, cbukrs, cbuktx,
    aktiv, afabg, kostl, ktext, ndjar,
    kansw_begin,
    anbtr_out, anbtr_pro, anbtr_add_resell, anbtr_add_others, anbtr_add_sum,
    anbtr_scrap, anbtr_reduce_resell, anbtr_sell, anbtr_reduce_others, anbtr_reduce_sum,
    anbtr_end,
    knafa_begin,
    nafaz_normal, hsl_add_others, hsl_add_resell, hsl_add_sum,
    hsl_reduce_normal, hsl_scrap, hsl_reduce_resell, hsl_reduce_others, hsl_reduce_sum,
    hsl_period, hsl_end,
    hsl_end_net,
    anred, dept_id, dept_name,
    gdlgrp, gdlgrp_txt, fkbtx, stort, raumn, sernr,
    add_date
)
SELECT
    a.anln1, a.anln2, a.txt50, a.menge, a.meins, a.txk20,
    a.bukrs,
    com.cbukrs,
    com.cbuktx,
    a.aktiv, a.afabg, a.kostl, a.ktext, a.ndjar,
    a.kansw_begin,
    a.anbtr_out, a.anbtr_pro, a.anbtr_add_resell, a.anbtr_add_others, a.anbtr_add_sum,
    a.anbtr_scrap, a.anbtr_reduce_resell, a.anbtr_sell, a.anbtr_reduce_others, a.anbtr_reduce_sum,
    a.anbtr_end,
    a.knafa_begin,
    a.nafaz_normal, a.hsl_add_others, a.hsl_add_resell, a.hsl_add_sum,
    a.hsl_reduce_normal, a.hsl_scrap, a.hsl_reduce_resell, a.hsl_reduce_others, a.hsl_reduce_sum,
    a.hsl_period, a.hsl_end,
    a.hsl_end_net,
    csks.anred,
    dept.dept_id,
    dept.dept_name,
    a.gdlgrp, t087s.gdlgrp_txt, a.fkbtx, a.stort, a.raumn, a.sernr,
    a.add_date
FROM sap_data.zfi0056_99991231 a
-- 公司代码（清洗后）
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_COM com
    ON a.bukrs = com.sbukrs
-- 标题：通过成本中心关联CSKS（取当前有效记录）
LEFT JOIN dwd_dcp.dwd_s4_csks csks
    ON a.kostl = csks.kostl
    AND csks.datbi = '99991231'
-- 部门编码/名称，ANRED = core_dept.dept_id
LEFT JOIN jst.core_dept dept
    ON LPAD(csks.anred, 8, '0') = dept.dept_id
-- 资产类型描述
LEFT JOIN dwd_dcp.dwd_s4_t087s t087s
    ON a.gdlgrp = t087s.gdlgrp;
