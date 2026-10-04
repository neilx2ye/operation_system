-- OPS 数据库结构。所有语句幂等，可在每次冷启动时安全执行。
--
-- 设计取向：业务实体保留完整的 JSON 形态存放在 data(jsonb) 中，原样往返，
-- 避免在迁移期改变实体契约；只把排序/过滤真正用到的键抽成独立列并加索引。
-- 时间键按 ISO 文本比较（COLLATE "C"），与旧文件实现里的字符串排序逐条一致。

-- ============ EDM ============

CREATE TABLE IF NOT EXISTS edm_templates (
  id                 text PRIMARY KEY,
  current_version_id text,
  updated_at         text,
  created_at         text,
  data               jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS edm_templates_updated_idx ON edm_templates (updated_at COLLATE "C" DESC, id COLLATE "C");

CREATE TABLE IF NOT EXISTS edm_template_versions (
  id          text PRIMARY KEY,
  template_id text NOT NULL,
  created_at  text,
  data        jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS edm_template_versions_tpl_idx ON edm_template_versions (template_id, created_at COLLATE "C", id COLLATE "C");

CREATE TABLE IF NOT EXISTS edm_template_categories (
  id   text PRIMARY KEY,
  seq  bigserial,
  data jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS edm_assets (
  id         text PRIMARY KEY,
  created_at text,
  -- body 可能先于元数据写入，故 data 允许为空；读取时按 data IS NOT NULL 过滤
  data       jsonb,
  body       bytea
);
CREATE INDEX IF NOT EXISTS edm_assets_created_idx ON edm_assets (created_at COLLATE "C" DESC, id COLLATE "C");

CREATE TABLE IF NOT EXISTS edm_audiences (
  id         text PRIMARY KEY,
  created_at text,
  expires_at text,
  data       jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS edm_audiences_created_idx ON edm_audiences (created_at COLLATE "C" DESC, id COLLATE "C");

CREATE TABLE IF NOT EXISTS edm_preparations (
  id         text PRIMARY KEY,
  updated_at text,
  data       jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS edm_preparations_updated_idx ON edm_preparations (updated_at COLLATE "C" DESC, id COLLATE "C");

CREATE TABLE IF NOT EXISTS edm_operations (
  id         text PRIMARY KEY,
  created_at text,
  data       jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS edm_operations_created_idx ON edm_operations (created_at COLLATE "C" DESC, id COLLATE "C");

-- Klaviyo 绑定、身份、远端模板、名单、订阅状态的单一文档行
CREATE TABLE IF NOT EXISTS edm_integrations (
  id         smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  data       jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ============ OPS 运营数据 ============

-- 设置（含云途 / Shopify 凭据）。单行文档表。
CREATE TABLE IF NOT EXISTS ops_settings (
  id         smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  data       jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 客户标签 { customer_id -> string[] }
CREATE TABLE IF NOT EXISTS ops_customer_tags (
  customer_id text PRIMARY KEY,
  tags        jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- 客户分组定义与成员
CREATE TABLE IF NOT EXISTS ops_customer_groups (
  id    text PRIMARY KEY,
  name  text NOT NULL,
  color text NOT NULL,
  seq   bigserial
);
CREATE TABLE IF NOT EXISTS ops_customer_group_members (
  customer_id text NOT NULL,
  group_id    text NOT NULL REFERENCES ops_customer_groups(id) ON DELETE CASCADE,
  PRIMARY KEY (customer_id, group_id)
);

-- 云途/Shopify 发货运单记录，按订单号一行
CREATE TABLE IF NOT EXISTS ops_shipments (
  order_id   text PRIMARY KEY,
  data       jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 商品目录人工覆盖参数，按商品 id 一行
CREATE TABLE IF NOT EXISTS ops_catalog_overrides (
  product_id text PRIMARY KEY,
  data       jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Shopify 全量同步缓存与同步状态。单行文档表。
CREATE TABLE IF NOT EXISTS shopify_cache (
  id         smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  data       jsonb NOT NULL,
  synced_at  text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS shopify_sync_status (
  id         smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  data       jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
