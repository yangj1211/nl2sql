-- ============================================================
-- 利润中心与部门映射数据
-- 数据来源：用户提供的映射图（利润中心编码 / 利润中心描述 / 部门编码）
-- 主数据：jst.core_dept（dept_id / dept_name 最终来自这里）
--
-- 流程：
--   1) INSERT 写入 business_unit_id + business_unit_desc + 原始 OA 编码（未补 0）；
--   2) 通过 jst.core_dept 把 dept_id 规范到 8 位，并回填 dept_name；
--   3) 校验：如果 dept_name IS NULL，说明该 OA 编码在 core_dept 找不到。
-- ============================================================

TRUNCATE TABLE jst_flat.business_unit_mapping;

INSERT INTO jst_flat.business_unit_mapping (
    business_unit_id,
    business_unit_desc,
    dept_id,
    dept_name
)
SELECT
    m.business_unit_id,
    m.business_unit_desc,
    d.dept_id,
    d.dept_name
FROM (
    SELECT '1000' AS oa_dept_id, '100000' AS business_unit_id, '金盘科技集团' AS business_unit_desc
    UNION ALL SELECT '1032', '100001', '海南生产-树脂干变'
    UNION ALL SELECT '1044', '100101', '海南电力系统工程事业部'
    UNION ALL SELECT '1044', '100201', '武汉新型电力系统工程事业部'
    UNION ALL SELECT '1043', '101001', '干变事业部'
    UNION ALL SELECT '1014', '101002', '电抗变频事业部'
    UNION ALL SELECT '1014', '101003', '电抗变频事业部'
    UNION ALL SELECT '1037', '101004', '出口开关事业部'
    UNION ALL SELECT '1012', '101005', '成套电气事业部'
    UNION ALL SELECT '1012', '101006', '成套电气事业部'
    UNION ALL SELECT '1012', '101007', '成套电气事业部'
    UNION ALL SELECT '1044', '101008', '海南电力系统工程事业部'
    UNION ALL SELECT '1039', '101009', '国内储能事业部'
    UNION ALL SELECT '1022', '101010', '售后服务事业部'
    UNION ALL SELECT '1043', '101011', '干变事业部'
    UNION ALL SELECT '1047', '101012', '工商储事业部'
    UNION ALL SELECT '1665', '101016', '海风变事业部'
    UNION ALL SELECT '1037', '101017', '出口开关事业部'
    UNION ALL SELECT '1672', '101020', '金盘机器人（武汉）有限公司'
    UNION ALL SELECT '1037', '101021', '出口开关事业部'
    UNION ALL SELECT '1682', '101022', '油变事业部'
    UNION ALL SELECT '1672', '101023', '金盘机器人（武汉）有限公司'
    UNION ALL SELECT '1691', '101025', '电源模块事业部'
    UNION ALL SELECT '1704', '101026', '国网南网事业部'
    UNION ALL SELECT '1043', '101101', '干变事业部'
    UNION ALL SELECT '1014', '101102', '电抗变频事业部'
    UNION ALL SELECT '1014', '101103', '电抗变频事业部'
    UNION ALL SELECT '1043', '101201', '干变事业部'
    UNION ALL SELECT '1014', '101202', '电抗变频事业部'
    UNION ALL SELECT '1014', '101203', '电抗变频事业部'
    UNION ALL SELECT '1037', '101204', '出口开关事业部'
    UNION ALL SELECT '1012', '101205', '成套电气事业部'
    UNION ALL SELECT '1012', '101206', '成套电气事业部'
    UNION ALL SELECT '1012', '101207', '成套电气事业部'
    UNION ALL SELECT '1044', '101208', '海南电力系统工程事业部'
    UNION ALL SELECT '1040', '140001', '新能源事业部'
    UNION ALL SELECT '1037', '180001', '出口开关事业部'
    UNION ALL SELECT '1037', '180101', '出口开关事业部'
    UNION ALL SELECT '1663', '190001', '武汉金拓事业部'
    UNION ALL SELECT '1017', '220101', '装备事业部'
    UNION ALL SELECT '1665', '220201', '武汉分生产-海风变'
    UNION ALL SELECT '1014', '300001', '电抗变频事业部'
    UNION ALL SELECT '1014', '300097', '电抗变频事业部'
    UNION ALL SELECT '1037', '300201', '出口开关事业部'
    UNION ALL SELECT '1014', '301001', '电抗变频事业部'
    UNION ALL SELECT '1014', '301002', '电抗变频事业部'
    UNION ALL SELECT '1037', '301003', '出口开关事业部'
    UNION ALL SELECT '1043', '301004', '干变事业部'
    UNION ALL SELECT '1014', '301101', '电抗变频事业部'
    UNION ALL SELECT '1014', '301102', '电抗变频事业部'
    UNION ALL SELECT '1014', '301201', '电抗变频事业部'
    UNION ALL SELECT '1014', '301202', '电抗变频事业部'
    UNION ALL SELECT '1037', '301203', '出口开关事业部'
    UNION ALL SELECT '1669', '390001', '非晶合金事业部'
    UNION ALL SELECT '1031', '400001', '桂林生产-树脂干变'
    UNION ALL SELECT '1031', '400101', '桂林生产-成套'
    UNION ALL SELECT '1012', '400201', '成套电气事业部'
    UNION ALL SELECT '1691', '400701', '桂林生产-电源模块'
    UNION ALL SELECT '1043', '401001', '干变事业部'
    UNION ALL SELECT '1012', '401002', '成套电气事业部'
    UNION ALL SELECT '1012', '401003', '成套电气事业部'
    UNION ALL SELECT '1012', '401004', '成套电气事业部'
    UNION ALL SELECT '1043', '401101', '出口干变事业部'
    UNION ALL SELECT '1043', '401201', '干变事业部'
    UNION ALL SELECT '1012', '401202', '成套电气事业部'
    UNION ALL SELECT '1012', '401203', '成套电气事业部'
    UNION ALL SELECT '1012', '401204', '成套电气事业部'
    UNION ALL SELECT '1017', '401205', '装备事业部'
    UNION ALL SELECT '1043', '501001', '出口干变事业部'
    UNION ALL SELECT '1014', '501002', '电抗变频事业部'
    UNION ALL SELECT '1014', '501003', '电抗变频事业部'
    UNION ALL SELECT '1037', '600015', '出口开关事业部'
) m
INNER JOIN jst.core_dept d
    ON d.dept_id = LPAD(m.oa_dept_id, 8, '0');

-- 校验（可选）：在 core_dept 找不到对应主数据的 OA 编码
-- SELECT * FROM jst_flat.business_unit_mapping WHERE dept_name IS NULL;
