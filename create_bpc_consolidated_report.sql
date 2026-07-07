-- ============================================================
-- BPC 合并报表 - 建表
-- 目标表：jst_flat.bpc_consolidated_report
-- 底表：dwd_dcp.dwd_bw_b28_akgiq7yo1 (YO1)
--       dwd_dcp.dwd_bw_b28_akgiq7yo2 (YO2)
-- ============================================================

DROP TABLE IF EXISTS jst_flat.bpc_consolidated_report;

CREATE TABLE jst_flat.bpc_consolidated_report (
  b28_s_kgd4b76            VARCHAR(255)    COMMENT '合并科目',
  cpmb_acctype             VARCHAR(255)    COMMENT '科目类型',
  cpmb_kgprv60             VARCHAR(255)    COMMENT '科目分类',
  cpmb_hir                 VARCHAR(255)    COMMENT '层级标识',
  b28_s_kgd4b76_txtlg      VARCHAR(255)    COMMENT '合并科目描述',
  b28_s_kgdc8w9            VARCHAR(255)    COMMENT '审计线索',
  b28_s_kgdc8w9_txtlg      VARCHAR(255)    COMMENT '审计线索描述',
  b28_s_kgdsxrb            VARCHAR(255)    COMMENT '客户_供应商编码',
  b28_s_kgdsxrb_txtlg      VARCHAR(255)    COMMENT '客户_供应商描述',
  b28_s_kgd4rtr            VARCHAR(255)    COMMENT '合并单元',
  b28_s_kgd4rtr_txtlg      VARCHAR(255)    COMMENT '合并单元描述',
  b28_s_kgdp984            VARCHAR(255)    COMMENT '合并变动',
  b28_s_kgdp984_txtlg      VARCHAR(255)    COMMENT '合并变动描述',
  b28_s_kgd6bc6            VARCHAR(255)    COMMENT '贸易伙伴',
  b28_s_kgd6bc6_txtlg      VARCHAR(255)    COMMENT '贸易伙伴描述',
  b28_s_kgdk1oi            VARCHAR(255)    COMMENT '附注维度1',
  b28_s_kgdk1oi_txtlg      VARCHAR(255)    COMMENT '附注维度1描述',
  b28_s_kgduv2p            VARCHAR(255)    COMMENT '预留维度1',
  b28_s_kgduv2p_txtlg      VARCHAR(255)    COMMENT '预留维度1描述',
  b28_s_kgdo4wi            VARCHAR(255)    COMMENT '产品组',
  b28_s_kgdo4wi_txtlg      VARCHAR(255)    COMMENT '产品组描述',
  b28_s_kgd4kbn            VARCHAR(255)    COMMENT '报表货币',
  b28_s_kgd4kbn_txtlg      VARCHAR(255)    COMMENT '报表货币描述',
  b28_s_kgdxoi5            VARCHAR(255)    COMMENT '合并范围',
  b28_s_kgdxoi5_entity     VARCHAR(255)    COMMENT '合并范围_实体',
  b28_s_kgd4rtr_kgdxoi5    VARCHAR(255)    COMMENT '合并单元_合并范围(实际使用)',
  b28_s_kgd4rtr_kgdxoi5_txtlg VARCHAR(255) COMMENT '合并单元_合并范围描述(实际使用)',
  b28_s_kgdxoi5_txtlg      VARCHAR(255)    COMMENT '合并范围描述',
  b28_s_kgdbez8            VARCHAR(255)    COMMENT '销售订单',
  b28_s_kgdjz4b            VARCHAR(255)    COMMENT '交易货币',
  b28_s_kgdjz4b_txtlg      VARCHAR(255)    COMMENT '交易货币描述',
  b28_s_kgd353d            VARCHAR(255)    COMMENT '合并期间',
  b28_s_kgdbveh            VARCHAR(255)    COMMENT '类型划分',
  b28_s_kgdbveh_txtlg      VARCHAR(255)    COMMENT '类型划分描述',
  b28_s_kgdtvnx            VARCHAR(255)    COMMENT '类别',
  b28_s_kgdtvnx_txtlg      VARCHAR(255)    COMMENT '类别描述',
  b28_s_sdata              DECIMAL(20,7)   COMMENT '数据',
  account_path             VARCHAR(2000)   COMMENT '合并科目父节点路径'
) COMMENT='BPC 合并报表';
