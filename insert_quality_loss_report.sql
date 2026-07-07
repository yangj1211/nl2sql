-- ============================================================
-- 质量损失报表 - 数据插入
-- 目标表：jst_flat.quality_loss_report
-- 数据来源：dwd_dcp.dwd_ims_quality_loss_report
-- 公司清洗：DWD_BW_ZTBPC002_COM (sbukrs = company_code)
-- 利润中心清洗：DWD_BW_ZTBPC002_PRC (CN1，多策略匹配 sprctr/cprctr)
-- 过滤：剔除过账日期为本月；剔除【是否质量相关】(remark4) 为「否」
-- ============================================================

TRUNCATE TABLE jst_flat.quality_loss_report;

INSERT INTO jst_flat.quality_loss_report (
    id,
    company_code,
    cbukrs,
    cbuktx,
    post_date,
    data_source_code,
    data_source,
    profit_center_code,
    cprctr,
    cprctx,
    profit_center_desc,
    profit_group_code,
    profit_group_desc,
    cost_center_code,
    cost_center_desc,
    quality_loss_code,
    new_quality_loss_code,
    is_person_check,
    pre_after_sale,
    is_warranty,
    loss_type_one,
    loss_type_two,
    direct_cost,
    indirect_cost,
    total_cost,
    salvage_value,
    actual_loss,
    internal_order,
    after_service_case_no,
    problem_desc,
    quality_notice_no,
    supplier_name,
    material_factory,
    batch_no,
    finish_storage_time,
    actual_delivery_date,
    root_cause_big,
    root_cause_small,
    abnormal_part,
    abnormal_performance,
    duty_dept_d4,
    sale_order_no,
    customer_name,
    purchase_order,
    production_order_no,
    gl_voucher_no,
    line_item,
    voucher_sale_order,
    voucher_sale_line,
    material_voucher,
    material_no,
    material_desc,
    material_group,
    material_batch,
    quantity,
    account_code,
    remark1,
    remark2,
    remark3,
    remark4,
    remark5
)
SELECT
    s.id,
    s.company_code,
    com.cbukrs,
    com.cbuktx,
    s.post_date,
    s.data_source_code,
    s.data_source,
    s.profit_center_code,
    COALESCE(prc1.cprctr, prc2.cprctr, prc3.cprctr, prc4.cprctr, prc5.cprctr),
    COALESCE(prc1.cprctx, prc2.cprctx, prc3.cprctx, prc4.cprctx, prc5.cprctx),
    s.profit_center_desc,
    s.profit_group_code,
    s.profit_group_desc,
    s.cost_center_code,
    s.cost_center_desc,
    s.quality_loss_code,
    s.new_quality_loss_code,
    s.is_person_check,
    s.pre_after_sale,
    s.is_warranty,
    s.loss_type_one,
    s.loss_type_two,
    CASE WHEN s.direct_cost IS NULL OR TRIM(s.direct_cost) = '' THEN NULL ELSE CAST(s.direct_cost AS DECIMAL(38,2)) END,
    CASE WHEN s.indirect_cost IS NULL OR TRIM(s.indirect_cost) = '' THEN NULL ELSE CAST(s.indirect_cost AS DECIMAL(38,2)) END,
    CASE WHEN s.total_cost IS NULL OR TRIM(s.total_cost) = '' THEN NULL ELSE CAST(s.total_cost AS DECIMAL(38,2)) END,
    CASE WHEN s.salvage_value IS NULL OR TRIM(s.salvage_value) = '' THEN NULL ELSE CAST(s.salvage_value AS DECIMAL(38,2)) END,
    CASE WHEN s.actual_loss IS NULL OR TRIM(s.actual_loss) = '' THEN NULL ELSE CAST(s.actual_loss AS DECIMAL(38,2)) END,
    s.internal_order,
    s.after_service_case_no,
    s.problem_desc,
    s.quality_notice_no,
    s.supplier_name,
    s.material_factory,
    s.batch_no,
    s.finish_storage_time,
    s.actual_delivery_date,
    s.root_cause_big,
    s.root_cause_small,
    s.abnormal_part,
    s.abnormal_performance,
    s.duty_dept_d4,
    s.sale_order_no,
    s.customer_name,
    s.purchase_order,
    s.production_order_no,
    s.gl_voucher_no,
    s.line_item,
    s.voucher_sale_order,
    s.voucher_sale_line,
    s.material_voucher,
    s.material_no,
    s.material_desc,
    s.material_group,
    s.material_batch,
    s.quantity,
    s.account_code,
    s.remark1,
    s.remark2,
    s.remark3,
    s.remark4,
    s.remark5
FROM dwd_dcp.dwd_ims_quality_loss_report s
-- 公司代码清洗
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_COM com
    ON s.company_code = com.sbukrs
-- 利润中心清洗：精确匹配(公司+源利润中心)
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC prc1
    ON prc1.sysid = 'CN1'
    AND prc1.bukrs = s.company_code
    AND prc1.sprctr = s.profit_center_code
    AND prc1.bukrs != ''
-- 利润中心清洗：宽松匹配(源利润中心，公司为空)
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC prc2
    ON prc2.sysid = 'CN1'
    AND prc2.sprctr = s.profit_center_code
    AND (prc2.bukrs = '' OR prc2.bukrs IS NULL)
-- 利润中心清洗：补零精确匹配
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC prc3
    ON prc3.sysid = 'CN1'
    AND prc3.bukrs = s.company_code
    AND prc3.sprctr = CONCAT('0000', s.profit_center_code)
    AND prc3.bukrs != ''
    AND LEFT(s.profit_center_code, 4) != '0000'
-- 利润中心清洗：补零宽松匹配
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC prc4
    ON prc4.sysid = 'CN1'
    AND prc4.sprctr = CONCAT('0000', s.profit_center_code)
    AND (prc4.bukrs = '' OR prc4.bukrs IS NULL)
    AND LEFT(s.profit_center_code, 4) != '0000'
-- 利润中心清洗：源字段已是合并利润中心代码
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC prc5
    ON prc5.sysid = 'CN1'
    AND prc5.cprctr = s.profit_center_code
WHERE TRIM(COALESCE(s.remark4, '')) != '否'
  AND (
      s.post_date IS NULL
      OR TRIM(s.post_date) = ''
      OR LEFT(TRIM(s.post_date), 7) != DATE_FORMAT(CURRENT_DATE(), '%Y-%m')
  );
