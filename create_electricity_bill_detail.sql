CREATE TABLE jst_flat.electricity_bill_detail (
  bukrs     VARCHAR(255) COMMENT '公司代码',
  cbukrs    VARCHAR(255) COMMENT '公司代码（清洗后）',
  cbuktx    VARCHAR(255) COMMENT '公司描述（清洗后）',
  gjahr     VARCHAR(255) COMMENT '会计年度',
  monat     VARCHAR(255) COMMENT '期间',
  zbh       VARCHAR(255) COMMENT '编号',
  zydxz     VARCHAR(255) COMMENT '用电性质',
  zjd       VARCHAR(255) COMMENT '基地',
  capacity1 DECIMAL(23,2) COMMENT '发电量',
  capacity2 DECIMAL(23,2) COMMENT '生产用量',
  capacity3 DECIMAL(23,2) COMMENT '办公用量'
) COMMENT='电费明细表';
