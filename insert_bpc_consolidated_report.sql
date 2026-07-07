-- ============================================================
-- BPC 合并报表 - 数据插入
-- 目标表：jst_flat.bpc_consolidated_report
-- 数据来源：YO1 + YO2 两张事实表分两次INSERT
-- YO1: dwd_dcp.dwd_bw_b28_akgiq7yo1
-- YO2: dwd_dcp.dwd_bw_b28_akgiq7yo2
-- 维表关联：合并科目、审计线索、客户供应商、合并单元、
--           合并变动、贸易伙伴、附注维度、预留维度、
--           产品组、报表货币、合并范围、交易货币、类型划分、类别
-- account_path：通过逐层JOIN dwd_dcp.dwd_bw_1cpmb_bkgd4b76
--               构建合并科目的父节点路径（最深9层，排除根节点）
-- ============================================================

TRUNCATE TABLE jst_flat.bpc_consolidated_report;

-- ========== 第一部分：YO1 事实表 ==========
INSERT INTO jst_flat.bpc_consolidated_report
SELECT
    -- 1. 合并科目
    o1.b28_s_kgd4b76,
    b76.cpmb_acctype,
    b76.cpmb_kgprv60,
    b76.cpmb_hir,
    b76t.txtlg,
    -- 2. 审计线索
    o1.b28_s_kgdc8w9,
    c8w9t.txtlg,
    -- 3. 客户&供应商编码
    o1.b28_s_kgdsxrb,
    sxrbt.txtlg,
    -- 4. 合并单元
    o1.b28_s_kgd4rtr,
    d4rtrt.txtlg,
    -- 5. 合并变动
    o1.b28_s_kgdp984,
    p984t.txtlg,
    -- 6. 贸易伙伴
    o1.b28_s_kgd6bc6,
    b6bc6t.txtlg,
    -- 7. 附注维度1
    o1.b28_s_kgdk1oi,
    k1oit.txtlg,
    -- 8. 预留维度1
    o1.b28_s_kgduv2p,
    uv2pt.txtlg,
    -- 9. 产品组
    o1.b28_s_kgdo4wi,
    o4wit.txtlg,
    -- 10. 报表货币
    o1.b28_s_kgd4kbn,
    kbnt.txtlg,
    -- 11. 合并范围
    o1.b28_s_kgdxoi5,
    bxoi5.cpmb_entity,
    CASE
        WHEN o1.b28_s_kgdxoi5 = 'S_NONE' THEN o1.b28_s_kgd4rtr
        ELSE bxoi5.cpmb_entity
    END,
    CASE
        WHEN o1.b28_s_kgdxoi5 = 'S_NONE' THEN d4rtrt.txtlg
        ELSE xoi5t.txtlg
    END,
    xoi5t.txtlg,
    -- 12. 销售订单
    o1.b28_s_kgdbez8,
    -- 13. 交易货币
    o1.b28_s_kgdjz4b,
    z4bt.txtlg,
    -- 14. 合并期间
    o1.b28_s_kgd353d,
    -- 15. 类型划分
    o1.b28_s_kgdbveh,
    bveht.txtlg,
    -- 16. 类别
    o1.b28_s_kgdtvnx,
    tvnxt_desc.txtlg,
    -- 17. 数据
    o1.b28_s_sdata,
    -- 18. 合并科目父节点路径
    ap.account_path
FROM dwd_dcp.dwd_bw_b28_akgiq7yo1 AS o1
-- 1. 合并科目
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_bkgd4b76      AS b76   ON o1.b28_s_kgd4b76 = b76.cpmb_kgd4b76
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_kgd4b76t      AS b76t  ON o1.b28_s_kgd4b76 = b76t.cpmb_kgd4b76
-- 2. 审计线索
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_kgdc8w9       AS c8w9  ON o1.b28_s_kgdc8w9 = c8w9.cpmb_kgdc8w9
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_kgdc8w9t      AS c8w9t ON o1.b28_s_kgdc8w9 = c8w9t.cpmb_kgdc8w9
-- 3. 客户&供应商编码
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_kgdsxrb       AS sxrb  ON o1.b28_s_kgdsxrb = sxrb.cpmb_kgdsxrb
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_kgdsxrbt      AS sxrbt ON o1.b28_s_kgdsxrb = sxrbt.cpmb_kgdsxrb
-- 4. 合并单元
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_dkgd4rtr      AS d4rtr ON o1.b28_s_kgd4rtr = d4rtr.cpmb_kgd4rtr
LEFT JOIN dwd_dcp.dwd_bw_b28_tkgd4rtr        AS d4rtrt ON o1.b28_s_kgd4rtr = d4rtrt.b28_s_kgd4rtr
-- 5. 合并变动
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_kgdp984       AS p984  ON o1.b28_s_kgdp984 = p984.cpmb_kgdp984
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_kgdp984t      AS p984t ON o1.b28_s_kgdp984 = p984t.cpmb_kgdp984
-- 6. 贸易伙伴
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_bkgd6bc6      AS b6bc6  ON o1.b28_s_kgd6bc6 = b6bc6.cpmb_kgd6bc6
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_kgd6bc6t      AS b6bc6t ON o1.b28_s_kgd6bc6 = b6bc6t.cpmb_kgd6bc6
-- 7. 附注维度1
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_kgdk1oi       AS k1oi   ON o1.b28_s_kgdk1oi = k1oi.cpmb_kgdk1oi
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_kgdk1oit      AS k1oit  ON o1.b28_s_kgdk1oi = k1oit.cpmb_kgdk1oi
-- 8. 预留维度1
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_kgduv2p       AS uv2p   ON o1.b28_s_kgduv2p = uv2p.cpmb_kgduv2p
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_kgduv2pt      AS uv2pt  ON o1.b28_s_kgduv2p = uv2pt.cpmb_kgduv2p
-- 9. 产品组
LEFT JOIN dwd_dcp.dwd_bw_b28_pkgdo4wi        AS o4wi   ON o1.b28_s_kgdo4wi = o4wi.b28_s_kgdo4wi
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_kgdo4wit      AS o4wit  ON o1.b28_s_kgdo4wi = o4wit.cpmb_kgdo4wi
-- 10. 报表货币
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_kgd4kbn       AS kbn    ON o1.b28_s_kgd4kbn = kbn.cpmb_kgd4kbn
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_kgd4kbnt      AS kbnt   ON o1.b28_s_kgd4kbn = kbnt.cpmb_kgd4kbn
-- 11. 合并范围
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_bkgdxoi5      AS bxoi5  ON o1.b28_s_kgdxoi5 = bxoi5.cpmb_kgdxoi5
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_kgdxoi5t      AS xoi5t  ON o1.b28_s_kgdxoi5 = xoi5t.cpmb_kgdxoi5
-- 12. 交易货币
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_kgdjz4b       AS z4b    ON o1.b28_s_kgdjz4b = z4b.cpmb_kgdjz4b
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_kgdjz4bt      AS z4bt   ON o1.b28_s_kgdjz4b = z4bt.cpmb_kgdjz4b
-- 13. 类型划分
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_kgdbveh       AS bveh   ON o1.b28_s_kgdbveh = bveh.cpmb_kgdbveh
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_kgdbveht      AS bveht  ON o1.b28_s_kgdbveh = bveht.cpmb_kgdbveh
-- 14. 类别
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_kgdtvnxt      AS tvnx        ON o1.b28_s_kgdtvnx = tvnx.cpmb_kgdtvnx
LEFT JOIN dwd_dcp.dwd_bw_b28_tkgdtvnx        AS tvnxt_desc  ON o1.b28_s_kgdtvnx = tvnxt_desc.b28_s_kgdtvnx
-- 18. 合并科目父节点路径（逐层JOIN，最深9层，排除根节点）
LEFT JOIN (
    SELECT
        h1.cpmb_kgd4b76,
        CONCAT('/',
            h1.cpmb_kgd4b76, '/',
            CASE WHEN h2.cpmb_kgd4b76 IS NOT NULL AND (h2.parenth1 IS NOT NULL AND h2.parenth1 != '') THEN CONCAT(h2.cpmb_kgd4b76, '/') ELSE '' END,
            CASE WHEN h3.cpmb_kgd4b76 IS NOT NULL AND (h3.parenth1 IS NOT NULL AND h3.parenth1 != '') THEN CONCAT(h3.cpmb_kgd4b76, '/') ELSE '' END,
            CASE WHEN h4.cpmb_kgd4b76 IS NOT NULL AND (h4.parenth1 IS NOT NULL AND h4.parenth1 != '') THEN CONCAT(h4.cpmb_kgd4b76, '/') ELSE '' END,
            CASE WHEN h5.cpmb_kgd4b76 IS NOT NULL AND (h5.parenth1 IS NOT NULL AND h5.parenth1 != '') THEN CONCAT(h5.cpmb_kgd4b76, '/') ELSE '' END,
            CASE WHEN h6.cpmb_kgd4b76 IS NOT NULL AND (h6.parenth1 IS NOT NULL AND h6.parenth1 != '') THEN CONCAT(h6.cpmb_kgd4b76, '/') ELSE '' END,
            CASE WHEN h7.cpmb_kgd4b76 IS NOT NULL AND (h7.parenth1 IS NOT NULL AND h7.parenth1 != '') THEN CONCAT(h7.cpmb_kgd4b76, '/') ELSE '' END,
            CASE WHEN h8.cpmb_kgd4b76 IS NOT NULL AND (h8.parenth1 IS NOT NULL AND h8.parenth1 != '') THEN CONCAT(h8.cpmb_kgd4b76, '/') ELSE '' END,
            CASE WHEN h9.cpmb_kgd4b76 IS NOT NULL AND (h9.parenth1 IS NOT NULL AND h9.parenth1 != '') THEN CONCAT(h9.cpmb_kgd4b76, '/') ELSE '' END
        ) AS account_path
    FROM dwd_dcp.dwd_bw_1cpmb_bkgd4b76 h1
    LEFT JOIN dwd_dcp.dwd_bw_1cpmb_bkgd4b76 h2 ON h1.parenth1 = h2.cpmb_kgd4b76
    LEFT JOIN dwd_dcp.dwd_bw_1cpmb_bkgd4b76 h3 ON h2.parenth1 = h3.cpmb_kgd4b76
    LEFT JOIN dwd_dcp.dwd_bw_1cpmb_bkgd4b76 h4 ON h3.parenth1 = h4.cpmb_kgd4b76
    LEFT JOIN dwd_dcp.dwd_bw_1cpmb_bkgd4b76 h5 ON h4.parenth1 = h5.cpmb_kgd4b76
    LEFT JOIN dwd_dcp.dwd_bw_1cpmb_bkgd4b76 h6 ON h5.parenth1 = h6.cpmb_kgd4b76
    LEFT JOIN dwd_dcp.dwd_bw_1cpmb_bkgd4b76 h7 ON h6.parenth1 = h7.cpmb_kgd4b76
    LEFT JOIN dwd_dcp.dwd_bw_1cpmb_bkgd4b76 h8 ON h7.parenth1 = h8.cpmb_kgd4b76
    LEFT JOIN dwd_dcp.dwd_bw_1cpmb_bkgd4b76 h9 ON h8.parenth1 = h9.cpmb_kgd4b76
) AS ap ON o1.b28_s_kgd4b76 = ap.cpmb_kgd4b76;

-- ========== 第二部分：YO2 事实表 ==========
INSERT INTO jst_flat.bpc_consolidated_report
SELECT
    -- 1. 合并科目
    o1.b28_s_kgd4b76,
    b76.cpmb_acctype,
    b76.cpmb_kgprv60,
    b76.cpmb_hir,
    b76t.txtlg,
    -- 2. 审计线索
    o1.b28_s_kgdc8w9,
    c8w9t.txtlg,
    -- 3. 客户&供应商编码
    o1.b28_s_kgdsxrb,
    sxrbt.txtlg,
    -- 4. 合并单元
    o1.b28_s_kgd4rtr,
    d4rtrt.txtlg,
    -- 5. 合并变动
    o1.b28_s_kgdp984,
    p984t.txtlg,
    -- 6. 贸易伙伴
    o1.b28_s_kgd6bc6,
    b6bc6t.txtlg,
    -- 7. 附注维度1
    o1.b28_s_kgdk1oi,
    k1oit.txtlg,
    -- 8. 预留维度1
    o1.b28_s_kgduv2p,
    uv2pt.txtlg,
    -- 9. 产品组
    o1.b28_s_kgdo4wi,
    o4wit.txtlg,
    -- 10. 报表货币
    o1.b28_s_kgd4kbn,
    kbnt.txtlg,
    -- 11. 合并范围
    o1.b28_s_kgdxoi5,
    bxoi5.cpmb_entity,
    CASE
        WHEN o1.b28_s_kgdxoi5 = 'S_NONE' THEN o1.b28_s_kgd4rtr
        ELSE bxoi5.cpmb_entity
    END,
    CASE
        WHEN o1.b28_s_kgdxoi5 = 'S_NONE' THEN d4rtrt.txtlg
        ELSE xoi5t.txtlg
    END,
    xoi5t.txtlg,
    -- 12. 销售订单
    o1.b28_s_kgdbez8,
    -- 13. 交易货币
    o1.b28_s_kgdjz4b,
    z4bt.txtlg,
    -- 14. 合并期间
    o1.b28_s_kgd353d,
    -- 15. 类型划分
    o1.b28_s_kgdbveh,
    bveht.txtlg,
    -- 16. 类别
    o1.b28_s_kgdtvnx,
    tvnxt_desc.txtlg,
    -- 17. 数据
    o1.b28_s_sdata,
    -- 18. 合并科目父节点路径
    ap.account_path
FROM dwd_dcp.dwd_bw_b28_akgiq7yo2 AS o1
-- 1. 合并科目
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_bkgd4b76      AS b76   ON o1.b28_s_kgd4b76 = b76.cpmb_kgd4b76
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_kgd4b76t      AS b76t  ON o1.b28_s_kgd4b76 = b76t.cpmb_kgd4b76
-- 2. 审计线索
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_kgdc8w9       AS c8w9  ON o1.b28_s_kgdc8w9 = c8w9.cpmb_kgdc8w9
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_kgdc8w9t      AS c8w9t ON o1.b28_s_kgdc8w9 = c8w9t.cpmb_kgdc8w9
-- 3. 客户&供应商编码
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_kgdsxrb       AS sxrb  ON o1.b28_s_kgdsxrb = sxrb.cpmb_kgdsxrb
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_kgdsxrbt      AS sxrbt ON o1.b28_s_kgdsxrb = sxrbt.cpmb_kgdsxrb
-- 4. 合并单元
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_dkgd4rtr      AS d4rtr ON o1.b28_s_kgd4rtr = d4rtr.cpmb_kgd4rtr
LEFT JOIN dwd_dcp.dwd_bw_b28_tkgd4rtr        AS d4rtrt ON o1.b28_s_kgd4rtr = d4rtrt.b28_s_kgd4rtr
-- 5. 合并变动
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_kgdp984       AS p984  ON o1.b28_s_kgdp984 = p984.cpmb_kgdp984
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_kgdp984t      AS p984t ON o1.b28_s_kgdp984 = p984t.cpmb_kgdp984
-- 6. 贸易伙伴
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_bkgd6bc6      AS b6bc6  ON o1.b28_s_kgd6bc6 = b6bc6.cpmb_kgd6bc6
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_kgd6bc6t      AS b6bc6t ON o1.b28_s_kgd6bc6 = b6bc6t.cpmb_kgd6bc6
-- 7. 附注维度1
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_kgdk1oi       AS k1oi   ON o1.b28_s_kgdk1oi = k1oi.cpmb_kgdk1oi
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_kgdk1oit      AS k1oit  ON o1.b28_s_kgdk1oi = k1oit.cpmb_kgdk1oi
-- 8. 预留维度1
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_kgduv2p       AS uv2p   ON o1.b28_s_kgduv2p = uv2p.cpmb_kgduv2p
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_kgduv2pt      AS uv2pt  ON o1.b28_s_kgduv2p = uv2pt.cpmb_kgduv2p
-- 9. 产品组
LEFT JOIN dwd_dcp.dwd_bw_b28_pkgdo4wi        AS o4wi   ON o1.b28_s_kgdo4wi = o4wi.b28_s_kgdo4wi
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_kgdo4wit      AS o4wit  ON o1.b28_s_kgdo4wi = o4wit.cpmb_kgdo4wi
-- 10. 报表货币
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_kgd4kbn       AS kbn    ON o1.b28_s_kgd4kbn = kbn.cpmb_kgd4kbn
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_kgd4kbnt      AS kbnt   ON o1.b28_s_kgd4kbn = kbnt.cpmb_kgd4kbn
-- 11. 合并范围
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_bkgdxoi5      AS bxoi5  ON o1.b28_s_kgdxoi5 = bxoi5.cpmb_kgdxoi5
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_kgdxoi5t      AS xoi5t  ON o1.b28_s_kgdxoi5 = xoi5t.cpmb_kgdxoi5
-- 12. 交易货币
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_kgdjz4b       AS z4b    ON o1.b28_s_kgdjz4b = z4b.cpmb_kgdjz4b
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_kgdjz4bt      AS z4bt   ON o1.b28_s_kgdjz4b = z4bt.cpmb_kgdjz4b
-- 13. 类型划分
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_kgdbveh       AS bveh   ON o1.b28_s_kgdbveh = bveh.cpmb_kgdbveh
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_kgdbveht      AS bveht  ON o1.b28_s_kgdbveh = bveht.cpmb_kgdbveh
-- 14. 类别
LEFT JOIN dwd_dcp.dwd_bw_1cpmb_kgdtvnxt      AS tvnx        ON o1.b28_s_kgdtvnx = tvnx.cpmb_kgdtvnx
LEFT JOIN dwd_dcp.dwd_bw_b28_tkgdtvnx        AS tvnxt_desc  ON o1.b28_s_kgdtvnx = tvnxt_desc.b28_s_kgdtvnx
-- 18. 合并科目父节点路径（逐层JOIN，最深9层，排除根节点）
LEFT JOIN (
    SELECT
        h1.cpmb_kgd4b76,
        CONCAT('/',
            h1.cpmb_kgd4b76, '/',
            CASE WHEN h2.cpmb_kgd4b76 IS NOT NULL AND (h2.parenth1 IS NOT NULL AND h2.parenth1 != '') THEN CONCAT(h2.cpmb_kgd4b76, '/') ELSE '' END,
            CASE WHEN h3.cpmb_kgd4b76 IS NOT NULL AND (h3.parenth1 IS NOT NULL AND h3.parenth1 != '') THEN CONCAT(h3.cpmb_kgd4b76, '/') ELSE '' END,
            CASE WHEN h4.cpmb_kgd4b76 IS NOT NULL AND (h4.parenth1 IS NOT NULL AND h4.parenth1 != '') THEN CONCAT(h4.cpmb_kgd4b76, '/') ELSE '' END,
            CASE WHEN h5.cpmb_kgd4b76 IS NOT NULL AND (h5.parenth1 IS NOT NULL AND h5.parenth1 != '') THEN CONCAT(h5.cpmb_kgd4b76, '/') ELSE '' END,
            CASE WHEN h6.cpmb_kgd4b76 IS NOT NULL AND (h6.parenth1 IS NOT NULL AND h6.parenth1 != '') THEN CONCAT(h6.cpmb_kgd4b76, '/') ELSE '' END,
            CASE WHEN h7.cpmb_kgd4b76 IS NOT NULL AND (h7.parenth1 IS NOT NULL AND h7.parenth1 != '') THEN CONCAT(h7.cpmb_kgd4b76, '/') ELSE '' END,
            CASE WHEN h8.cpmb_kgd4b76 IS NOT NULL AND (h8.parenth1 IS NOT NULL AND h8.parenth1 != '') THEN CONCAT(h8.cpmb_kgd4b76, '/') ELSE '' END,
            CASE WHEN h9.cpmb_kgd4b76 IS NOT NULL AND (h9.parenth1 IS NOT NULL AND h9.parenth1 != '') THEN CONCAT(h9.cpmb_kgd4b76, '/') ELSE '' END
        ) AS account_path
    FROM dwd_dcp.dwd_bw_1cpmb_bkgd4b76 h1
    LEFT JOIN dwd_dcp.dwd_bw_1cpmb_bkgd4b76 h2 ON h1.parenth1 = h2.cpmb_kgd4b76
    LEFT JOIN dwd_dcp.dwd_bw_1cpmb_bkgd4b76 h3 ON h2.parenth1 = h3.cpmb_kgd4b76
    LEFT JOIN dwd_dcp.dwd_bw_1cpmb_bkgd4b76 h4 ON h3.parenth1 = h4.cpmb_kgd4b76
    LEFT JOIN dwd_dcp.dwd_bw_1cpmb_bkgd4b76 h5 ON h4.parenth1 = h5.cpmb_kgd4b76
    LEFT JOIN dwd_dcp.dwd_bw_1cpmb_bkgd4b76 h6 ON h5.parenth1 = h6.cpmb_kgd4b76
    LEFT JOIN dwd_dcp.dwd_bw_1cpmb_bkgd4b76 h7 ON h6.parenth1 = h7.cpmb_kgd4b76
    LEFT JOIN dwd_dcp.dwd_bw_1cpmb_bkgd4b76 h8 ON h7.parenth1 = h8.cpmb_kgd4b76
    LEFT JOIN dwd_dcp.dwd_bw_1cpmb_bkgd4b76 h9 ON h8.parenth1 = h9.cpmb_kgd4b76
) AS ap ON o1.b28_s_kgd4b76 = ap.cpmb_kgd4b76;
