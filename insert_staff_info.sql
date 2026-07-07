-- ============================================================
-- 目标表: jst_flat.staff_info (人员信息表)
-- 主表: dwd_secrecy.dwd_s4_zxzmx (在职职工薪资明细)
-- zbmdm: 直接取主表 zxzmx.zbmdm（部门代码）
-- zbmmc: 直接取主表 zxzmx.zbmmc（部门名称）
-- zygxm: 直接取主表 zxzmx.zygxm（员工姓名）
-- ============================================================
-- 关联逻辑说明:
--
-- 1. 奖金明细 (dwd_secrecy.dwd_s4_zjjmx)
--    关联条件: LEFT(zjjmx.zffrq, 6) = zxzmx.zxzyf AND zjjmx.zygdm = zxzmx.zygdm
--    说明: 同一员工、同一月份可能存在多条不同批次的奖金记录，
--          因此先按 LEFT(zffrq,6) + zygdm 做 SUM 汇总后再关联
--    用途: 计算 labor_cost 中的奖金及计提部分
--
-- 2. 离职状态 (dwd_dcp.dwd_s4_pa0000)
--    关联条件: pa0000.pernr = zxzmx.zygdm
--             AND LEFT(pa0000.begda, 6) <= zxzmx.zxzyf
--             AND pa0000.stat2 = '0'
--    说明: 以薪资月份为时间维度，若该人员存在离职月份不晚于薪资月份的
--          stat2='0' 记录，则标记为"离职"，否则为"在职"
--    用途: 生成 employment_status 字段
--
-- 3. 成本中心 -> 利润中心 (dwd_dcp.dwd_s4_csks)
--    关联条件: csks.kostl = zxzmx.kostl
--             AND zxzmx.zxzyf >= LEFT(csks.datab, 6)
--             AND zxzmx.zxzyf <= LEFT(csks.datbi, 6)
--    说明: 通过成本中心代码关联，薪资月份需落在成本中心的有效期区间内
--          (datab=开始生效日期, datbi=有效截至日期)
--    用途: 获取 prctr (利润中心)
--
-- 4. 利润中心清洗映射 (dwd_dcp.DWD_BW_ZTBPC002_PRC)
--    精确匹配 (prc1): sysid='CN1' AND bukrs 不为空
--      关联条件: prc1.sysid='CN1' AND prc1.bukrs=csks.bukrs AND prc1.sprctr=csks.prctr
--    兜底匹配 (prc2): sysid='CN1' AND bukrs 为空
--      关联条件: prc2.sysid='CN1' AND prc2.sprctr=csks.prctr
--    说明: 优先使用 sysid+bukrs+sprctr 三字段精确匹配，
--          匹配不到时退回到 sysid+sprctr 两字段兜底匹配，通过 COALESCE 取值
--    用途: 获取 cprctr (清洗后利润中心) 和 cprctx (清洗后利润中心描述)
-- ============================================================

INSERT INTO jst_flat_table.staff_info (
    zxzyf,
    zygdm,
    zygxm,
    zssgs,
    zzwmc,
    zgwmc,
    zygz,
    zbmdm,
    zbmmc,
    employment_status,
    kostl,
    prctr,
    cprctr,
    cprctx,
    labor_cost
)
SELECT
    t.zxzyf,
    t.zygdm,
    t.zygxm,
    t.zssgs,
    t.zzwmc,
    t.zgwmc,
    t.zygz,
    t.zbmdm,
    t.zbmmc,
    CASE WHEN EXISTS (
        SELECT 1
        FROM dwd_dcp.dwd_s4_pa0000 pa
        WHERE pa.pernr = t.zygdm
          AND pa.stat2 = '0'
          AND LEFT(pa.begda, 6) <= t.zxzyf
    ) THEN '离职' ELSE '在职' END AS employment_status,
    t.kostl,
    csks.prctr,
    COALESCE(prc1.cprctr, prc2.cprctr) AS cprctr,
    COALESCE(prc1.cprctx, prc2.cprctx) AS cprctx,
    -- labor_cost (人工成本-人力)
    -- 来源于两张表:
    --   dwd_s4_zxzmx: zsj049(应发工资) + zsj095(社保公司合计) + zsj096(公积金公司合计) + zsj098(工会费计提)
    --   dwd_s4_zjjmx: zsj001(管理奖月发放标准) + zsj002(加班费合计) + zsj003(岗位津贴)
    --                 + zsj004(计件工资) + zsj005(辅助工时工资) + zsj006(销售人员月度绩效奖金)
    --                 + zsj007(营销费用控制奖金) + zsj008(工会费计提) + zsj009(应发年终奖金)
    --                 + zsj021(创新重大项目奖金) + zsj022(年终岗位津贴) + zsj023(年终销售奖金)
    --                 + zsj024(创新重大项目奖金-分摊计税) + zsj025(年终岗位津贴-分摊计税) + zsj026(年终销售奖金-分摊计税)
    --                 + zsj010(非周期补项) - zsj011(非周期扣项)
    --                 + zsj016(创新先进等奖励计提) + zsj017(年终奖月度计提) + zsj018(年终岗位津贴计提)
    --                 + zsj019(年终销售奖金计提) + zsj020(应发年终奖与计提差异金额)
    t.zsj049 + t.zsj095 + t.zsj096 + t.zsj098
    + IFNULL(jj.zsj001, 0) + IFNULL(jj.zsj002, 0) + IFNULL(jj.zsj003, 0) + IFNULL(jj.zsj004, 0)
    + IFNULL(jj.zsj005, 0) + IFNULL(jj.zsj006, 0) + IFNULL(jj.zsj007, 0) + IFNULL(jj.zsj008, 0)
    + IFNULL(jj.zsj009, 0) + IFNULL(jj.zsj021, 0) + IFNULL(jj.zsj022, 0) + IFNULL(jj.zsj023, 0)
    + IFNULL(jj.zsj024, 0) + IFNULL(jj.zsj025, 0) + IFNULL(jj.zsj026, 0)
    + IFNULL(jj.zsj010, 0) - IFNULL(jj.zsj011, 0)
    + IFNULL(jj.zsj016, 0) + IFNULL(jj.zsj017, 0) + IFNULL(jj.zsj018, 0) + IFNULL(jj.zsj019, 0)
    + IFNULL(jj.zsj020, 0) AS labor_cost

FROM dwd_secrecy.dwd_s4_zxzmx t

-- [关联1] 奖金明细: 按发放月份+员工代码汇总后关联
LEFT JOIN (
    SELECT LEFT(zffrq, 6) AS ym, zygdm,
        SUM(zsj001) AS zsj001, SUM(zsj002) AS zsj002, SUM(zsj003) AS zsj003,
        SUM(zsj004) AS zsj004, SUM(zsj005) AS zsj005, SUM(zsj006) AS zsj006,
        SUM(zsj007) AS zsj007, SUM(zsj008) AS zsj008, SUM(zsj009) AS zsj009,
        SUM(zsj010) AS zsj010, SUM(zsj011) AS zsj011,
        SUM(zsj016) AS zsj016, SUM(zsj017) AS zsj017, SUM(zsj018) AS zsj018,
        SUM(zsj019) AS zsj019, SUM(zsj020) AS zsj020,
        SUM(zsj021) AS zsj021, SUM(zsj022) AS zsj022, SUM(zsj023) AS zsj023,
        SUM(zsj024) AS zsj024, SUM(zsj025) AS zsj025, SUM(zsj026) AS zsj026
    FROM dwd_secrecy.dwd_s4_zjjmx
    GROUP BY LEFT(zffrq, 6), zygdm
) jj ON jj.ym = t.zxzyf AND jj.zygdm = t.zygdm

-- [关联2] 成本中心 -> 利润中心: 薪资月份需在成本中心有效期区间内
LEFT JOIN dwd_dcp.dwd_s4_csks csks
    ON csks.kostl = t.kostl
    AND t.zxzyf >= LEFT(csks.datab, 6)
    AND t.zxzyf <= LEFT(csks.datbi, 6)

-- [关联3a] 利润中心清洗(精确匹配): bukrs不为空时, 用 sysid + bukrs + sprctr 三字段匹配
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC prc1
    ON prc1.sysid = 'CN1' AND prc1.bukrs IS NOT NULL AND prc1.bukrs != ''
    AND prc1.bukrs = csks.bukrs AND prc1.sprctr = csks.prctr

-- [关联3b] 利润中心清洗(兜底匹配): bukrs为空时, 用 sysid + sprctr 两字段匹配
LEFT JOIN dwd_dcp.DWD_BW_ZTBPC002_PRC prc2
    ON prc2.sysid = 'CN1' AND (prc2.bukrs IS NULL OR prc2.bukrs = '')
    AND prc2.sprctr = csks.prctr;
