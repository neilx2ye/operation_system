# 数据存储（PostgreSQL）

本系统原先把数据以 JSON 文件存放在 `web/data/`。现已接入 PostgreSQL，业务数据统一入库，
文件实现保留为回滚/离线后端的兜底。

## 部署

```bash
# 1. 安装并启动 PostgreSQL
sudo apt-get install -y postgresql
sudo systemctl enable --now postgresql

# 2. 建库建用户
sudo -u postgres psql -c "CREATE ROLE ops LOGIN PASSWORD 'your-password';"
sudo -u postgres createdb -O ops ops

# 3. 配置连接（web/.env.local，已被 gitignore）
#    OPS_STORAGE=postgres
#    DATABASE_URL=postgres://ops:your-password@127.0.0.1:5432/ops

# 4. 导入旧的 JSON 文件数据（幂等，可重复执行）
npm run db:migrate
```

表结构在首次访问数据库时按 `lib/db/schema.sql` 自动建立（幂等 DDL），也可由迁移脚本建立。

## 存储后端开关

| `OPS_STORAGE` | 行为 |
| --- | --- |
| `postgres`（默认） | 业务数据落在 PostgreSQL |
| `file` | 旧的 JSON/二进制文件实现（`web/data/`），用于回滚或离线 |
| `memory` | 进程内存，仅测试用（EDM 另可用 `OPS_EDM_MEMORY_STORE=1`） |

连接配置优先取 `DATABASE_URL`；缺失时回退到标准 `PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE` 环境变量。

## 表

| 表 | 说明 |
| --- | --- |
| `edm_templates` / `edm_template_versions` / `edm_template_categories` | EDM 模板、不可变版本快照、分类 |
| `edm_assets` | 素材元数据 + 原图二进制（`bytea`） |
| `edm_audiences` / `edm_preparations` / `edm_operations` | 受众快照、邮件准备记录、执行记录 |
| `edm_integrations` | Klaviyo 绑定/身份/远端模板/名单/订阅状态（单行文档） |
| `ops_settings` | 设置（含云途/Shopify 凭据，单行文档） |
| `ops_customer_tags` | 客户标签 |
| `ops_customer_groups` / `ops_customer_group_members` | 客户分组与成员 |
| `ops_shipments` | 云途/Shopify 运单记录 |
| `ops_catalog_overrides` | 商品目录人工覆盖参数 |
| `shopify_cache` / `shopify_sync_status` | Shopify 全量同步缓存与同步状态 |

实体整体以 `jsonb` 原样往返，只把排序/过滤用到的键抽成独立列并加索引；
时间键按 ISO 文本以 `COLLATE "C"` 比较，与旧文件实现的字符串排序逐条一致。

## 代码结构

- `lib/db/schema.sql` —— 表结构（幂等）。
- `lib/db/pool.ts` —— 连接池、一次性建表、`dbQuery`/`dbOne`/`withTx`。
- `lib/db/docs.ts` —— 设置/标签/分组/运单/目录/Shopify 缓存/同步状态的读写（postgres 与 file 双后端）。
- `lib/edm/repositories/postgres.ts` —— EDM 的 PostgreSQL 仓储，实现与 file/memory 相同的异步契约。
- `scripts/migrate-data-to-db.mjs` —— JSON → DB 迁移。

`lib/edm/service.ts` 与其余访问点已改为异步（`await`），因为数据库访问天然异步；
读改写复合操作以 `lib/edm/storage.ts` 的 `withLock` 进程内队列串行化（沿用单实例部署前提）。

## 数据变更后的前端自动刷新

旧实现靠监听 `web/data/` 下的文件变化触发页面刷新；数据入库后文件事件不再产生。
因此所有写路径（EDM 仓储、`lib/db/docs.ts` 的设置/标签/分组/运单/目录/Shopify 缓存）在写入完成后会调用
`lib/hotReload.ts` 的 `broadcastReload()`，经 `/api/hot-reload` 把 `reload` 事件推给已打开的页面（仅开发环境；
生产环境为 no-op，页面在导航时取数）。

## Shopify 数据同步

设置页 Shopify 卡片提供「同步 Shopify 数据」按钮，调用 `POST /api/shopify/sync` 触发全量同步
（Bulk Operations 拉取商品/订单，分页拉取弃购），写入 `shopify_cache` 表；完成后自动广播刷新。
同步为长任务，页面按 `GET /api/shopify/sync` 轮询进度。需要 Admin Token 具备
`read_products`、`read_orders`、`read_all_orders`、`read_customers` 权限。

## 性能与 Admin API 调用

- `商品 / 订单 / 关联 / 数据源` 等分析接口**只读本地数据库**的 `shopify_cache`（内存聚合 + 短期修订号探测），
  不调用 Shopify Admin API。
- 每次分析请求只做一次很轻的"修订号探测"（`readShopifyCacheRevision` / `readCatalogOverridesRevision`），
  只有修订号变化时才读取整包缓存并重建内存聚合——避免每次请求都拉取数百 KB 的 JSONB。
- `客户 / 用户`页读取标签会调用 Admin API，现已加短期缓存（默认 60s，`SHOPIFY_TAGS_CACHE_MS` 可调），
  写标签后自动失效；重复切页不再重复请求。
- `看板(site)` 页调用 ShopifyQL 获取站内分析，服务端缓存 5 分钟。
- 真正的 Admin API 全量拉取只在点击「同步 Shopify 数据」（`POST /api/shopify/sync`）时发生。

## 增量更新（各数据页的「更新数据」按钮）

订单、商品、客户（分析 / 管理）页面工具栏都有「更新数据」按钮，点击触发**增量同步**：

- `POST /api/shopify/sync?mode=incremental`：用 `updated_at:>'<游标>'` 只拉取上次以来变化的
  商品变体与订单，`buildOrders` 顺带更新涉及的客户；按 id **合并覆盖**进现有缓存（不会重复累加）。
- 游标保存在 `shopify_cache.data.syncCursor`，每次成功同步后前进；并回退 5 分钟安全余量，
  宁可下次多拉一点，也不漏掉 bulk 期间的变更。
- 没有基线缓存时自动退化为全量同步；同一时刻只允许一个同步任务。
- 已知边界：**删除**的商品/订单不会在增量里移除（需全量同步）；**弃购**没有可靠的 `updated_at`
  过滤器，增量时保持不变，由全量同步刷新。
- 完成后服务端写入缓存并广播刷新；当前页面由按钮的 `onDone` 立即重新取数，其它已打开页面自动刷新。

实测（真实店铺）：游标回拨后增量拉到 102 商品 / 80 订单 / 76 客户变更，合并后总数仍为 331/372/373，
无重复；空变更时约 7 秒完成。
