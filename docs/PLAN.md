# OPS 电商管理操作系统 规划文档

版本: v0.1 草案  日期: 2026-10-01

## 1. 目标

构建内部使用的电商运营管理系统,核心是用表格快速查看:

- 每个产品的历史表现(销量、收入、退款、毛利、广告花费、趋势)
- 每个用户的历史行为(订单、浏览/加购、退款、客服沟通)
- 用户与产品的关联(谁买了什么、组合购买、复购)

非目标(v1 不做): 前台商城、支付、库存采购、多租户。

## 2. 用户与场景

单一运营者(后续可扩展到小团队)。典型场景:

1. 筛出近 30 天退款率高于 10% 的产品,导出 CSV。
2. 查看某客户的完整时间线,处理售后邮件前先了解其历史。
3. 找出购买过产品 A 但未购买产品 B 的客户,用于再营销。
4. 对比各产品的广告花费与毛利,判断是否加预算。

## 3. 运行环境

- 开发环境: Windows 10 x64, Node v24, 沙箱 C:\Users\xunuo\Desktop\OPS
- 生产环境(后期): Ubuntu VPS + PostgreSQL/Supabase

## 4. 技术选型

| 层 | 选择 | 理由 |
|---|---|---|
| 数据库 | SQLite(better-sqlite3),表结构按 PostgreSQL 风格 | 零配置,后期可迁移 |
| 后端 | Node + Fastify + Zod | 轻量,校验清晰 |
| 前端 | Vite + React + TanStack Table + 图表库 | 表格能力强(排序/筛选/分组/虚拟滚动) |
| 界面语言 | 中文 | 使用者为中文用户 |
| 导入 | CSV + Shopify Admin API | 先 CSV 验证,再接 API |

## 5. 数据模型

- products: id, shopify_id, title, sku, category, cost, price, status
- variants: id, product_id, sku, price, cost
- customers: id, shopify_id, email, name, country, source, first_order_at, tags
- orders: id, customer_id, placed_at, total, discount, shipping, status, channel
- order_items: id, order_id, product_id, variant_id, qty, price, cost
- refunds: id, order_id, amount, reason, created_at
- events: id, customer_id, product_id, type(view/cart/order/refund/support), occurred_at, payload
- ad_spend_daily: date, platform, campaign, product_id, spend, clicks, impressions, conversions

汇总视图:

- product_daily_metrics: 产品×日 的销量/收入/退款/毛利/广告花费
- customer_metrics: 订单数, LTV, 最近下单, 平均复购间隔, 退款次数
- customer_product_matrix: 客户×产品 的购买次数与金额

## 6. 功能模块

### 6.1 产品表
列: 产品, SKU, 销量, 收入, 毛利, 毛利率, 退款率, 广告花费, ROAS, 近 7/30/90 天趋势。
详情抽屉: 历史曲线、购买者列表、常见搭配产品。

### 6.2 用户表
列: 邮箱, 国家, 渠道, 订单数, LTV, 最近购买, 退款次数, 标签。
详情抽屉: 行为时间线、购买过的产品、客服记录。

### 6.3 关联分析
- 客户×产品矩阵
- 共同购买(买了 A 又买 B)
- 某产品的客户画像(国家/渠道/复购率)

### 6.4 通用表格能力
保存视图、列显隐、多条件筛选、分组、日期范围、导出 CSV。

### 6.5 数据导入与同步
CSV 上传(带映射和校验)、Shopify 同步任务、广告花费导入。

## 7. API 草案

- GET /api/products, GET /api/products/:id/history
- GET /api/customers, GET /api/customers/:id/timeline
- GET /api/relations/co-purchase?productId=
- POST /api/import/csv, POST /api/sync/shopify

## 8. 目录结构草案

OPS/
- docs/PLAN.md
- server/ (Fastify API, db, importers)
- web/ (React 前端)
- data/ (SQLite 文件, 导入样例, 已 gitignore)

## 9. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| M0 | 项目初始化, 表结构, 示例数据 | 能启动并查询示例数据 |
| M1 | 产品表 + 用户表 + 详情 | 可筛选/排序/导出 |
| M2 | 关联分析 | 共同购买与客户×产品可查 |
| M3 | Shopify 同步 + 广告花费 | 数据自动更新 |
| M4 | 登录/权限/备份/部署 | VPS 上稳定运行 |

## 10. 风险与约束

- 客户个人信息(邮箱等)需限制访问并避免写入日志。
- Shopify API 有频率限制, 同步需增量并重试。
- 广告数据与订单的归因口径需先统一(按日、按产品)。
- 沙箱单文件上限 5MB, exec 超时 30 秒, 长任务需后台运行。
- SQLite 数据量大后可能迁移 PostgreSQL, 保持 SQL 通用写法。

## 11. 待确认问题

1. 首批数据来源: Shopify 同步还是 CSV?
2. 是否需要多店铺/多币种?
3. 毛利口径: 是否计入运费、手续费、广告花费?
4. 用户行为(浏览/加购)是否已有埋点来源?
5. 是否需要多人登录与角色权限?

## 12. 开发与热重载

- 开发用 `npm run dev`(Next.js dev + Turbopack),代码改动由 Fast Refresh 即时生效。
- 数据层文件(web/lib、web/data)变化时,服务端通过 `/api/hot-reload`(SSE,仅开发模式)通知浏览器,
  页面自动重新取数,筛选/排序/选中的行保持不变;顶栏会显示「热重载已连接」。
- 生产构建 `npm run build && npm start` 不启用该通道,`npm run smoke` 校验生产行为。
- `npm run test:hot-reload` 单独拉起开发服务器,校验改动数据层文件能收到热重载事件。
