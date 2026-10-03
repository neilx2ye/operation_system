# EDM 模板设计、Klaviyo 与 OPS 用户页面整合方案（V2）

更新时间：2026-10-03  
项目根目录：`C:\Users\xunuo\Desktop\OPS`  
宿主：`web/`；参考源码：`edm/edm_manager/`  
状态：已按新范围修订方案；尚未实施业务代码迁移或调用真实 Klaviyo 账号。

> 本版替代上一版“搬迁完整 EDM 系统”的方案。当前只做三件事：复用模板设计能力、增加 Klaviyo 连接、与 OPS 现有用户分析页面联动。不连接原 EDM 数据库，也不提前选择整个 OPS 的数据库方案。
>
> 本文中的“用户页面”明确指 `/customers` 对应的客户/消费者页面，不是旧 EDM 的后台账号管理 `/users`。

## 1. 本期边界与结论

**采用：OPS 原生页面 + 可复用邮件设计器 + 服务端 Klaviyo 适配层 + 可替换的本地数据存储。**

| 本期纳入 | 本期不做 |
| --- | --- |
| 模板列表、新建、HTML 导入、编辑、预览、复制、导出 | 旧 PostgreSQL 连接、旧数据表/RLS/数据库迁移 |
| 图片替换、代码与画布定位、桌面/手机预览、轻量版本记录 | 旧项目/成员权限体系、旧登录、独立后台用户管理 |
| Klaviyo 账号连接检查、模板读取与推送、图片上传 | OAuth 多租户安装平台、旧 Agent API key 迁移 |
| 用户页查看 Klaviyo 匹配/订阅状态、选择人群、同步资料/名单 | 旧 WebSocket 网关、LISTEN/NOTIFY、Playwright 截图队列 |
| 保存“受众 + 模板版本”的本地邮件准备记录 | 创建/定时发送 Campaign、启动 Flow、群发、发送结果报表 |

数据库稍后统一接入；本期不引入 PostgreSQL、SQLite、Prisma 或 Drizzle 作为运行依赖。移出旧账号体系不等于允许匿名操作真实 Klaviyo，外部写入的访问保护见第 10 节。

## 2. 当前代码已核实的情况

以下结论来自本次源码读取，未验证线上服务、旧数据库内容或真实 Klaviyo 账号。

| 位置 | 现状及整合含义 |
| --- | --- |
| `web/components/CustomersView.tsx` | 已有邮箱、国家、渠道、分层、订单、LTV、标签、筛选、详情和 CSV 导出；以此页面为受众入口，不再复制一套客户管理 |
| `web/components/CustomerInsights.tsx` | 已有 R/F/M 分群和 `segmentOf`、`matchFilters`；应抽为前后端共用纯函数，避免服务端筛选与页面不一致 |
| `web/lib/mock.ts:567-582` | `CustomerRow.id` 为字符串；没有 Klaviyo Profile ID、订阅同意或抑制状态字段 |
| `web/lib/shopifySync.ts:124-145,237-245` | 当前订单/弃购查询未取得营销订阅状态；客户 ID 有 `c...` 和 `g...` 两种来源，缺失邮箱会显示“(无邮箱)”；不能直接把它们当 Klaviyo ID 或有效邮箱 |
| `web/lib/shopifySync.ts:199` | 唯一查到的 Klaviyo 提及是邮件渠道归类，不是 Klaviyo API 连接功能 |
| `edm/edm_manager/src/app/(dashboard)/templates/[templateId]/detail.tsx` | 已有 CodeMirror、HTML 美化、节点定位、图片/文字/链接编辑、diff、预览与版本交互；同时耦合旧 API、用户权限、项目/主题、WS、任务状态，不能只复制页面文件 |
| `edm/edm_manager/src/lib/client-api.ts` | 旧客户端依赖 `/api/projects`、`/api/templates`、`/api/images` 等；本期改用 OPS 新接口，不复制旧后端 |
| `edm/edm_manager/src/db/`、`src/auth/`、`src/ws/`、`src/instrumentation.ts` | 本期不迁入，不让它们出现在 `web/` 的运行时依赖链 |
| `web/components/Nav.tsx`、`web/app/layout.tsx` | 复用 OPS 导航和页面外壳；新增一个 EDM 入口 |

已搜索 EDM 的 74 个源码文件及顶层 Markdown 文档，未找到 Klaviyo 对接实现。因此本版明确区分：**模板设计是能力抽取复用；Klaviyo 是新增适配模块。** 如后续补充其他分支的 Klaviyo 代码，再按同一接口替换适配实现。

## 3. 页面组织与业务流程

### 3.1 页面落点

| 页面 | 内容 |
| --- | --- |
| `/customers` | 保留用户分析；增加“营销状态”“用于邮件设计”“同步客户资料”“加入 Klaviyo 名单”等操作 |
| `/edm` | 模板库：分类、名称搜索、新建、导入 HTML、从 Klaviyo 导入 CODE 模板副本 |
| `/edm/templates/[templateId]` | 邮件设计器：内容编辑、预览、素材、版本、受众摘要、同步到 Klaviyo |
| `/settings` 的 Klaviyo 卡片 | 显示账号、店铺绑定、密钥是否配置、测试连接、权限提示；与 Shopify/云途设置并列 |

设置页深链 `?integration=klaviyo` 为拟新增能力，需要同步实现高亮/定位，不把它当成当前已有功能。旧 `/users`、项目成员、API 工具和独立登录页不纳入导航。

### 3.2 从用户页面进入模板设计

```text
用户分析：按分层/标签/国家/渠道筛选
    → 明确选择“勾选用户”或“当前筛选结果”
    → 服务端生成受众快照并返回人数/排除原因
    → 选择已有模板或新建模板
    → 邮件设计器显示受众摘要，用示例数据预览
    → 保存模板及本地邮件准备记录
    → 分别确认“推送模板”和“同步名单”
    → 返回用户页面查看同步结果
```

**模板同步、客户资料同步、加入名单是三个独立操作，不把它们藏在一个按钮内一次完成。** 本期不展示“发送成功”等文案；远端保存成功只能称为“模板已同步”“资料已同步”或“名单已更新”。

### 3.3 从模板库反向选择用户

设计器中的“选择受众”打开复用用户筛选逻辑的选择器，或返回 `/customers` 完成选择。受众信息通过服务端生成的不透明 `audienceId` 关联，不把邮箱、完整客户资料或长串客户 ID 放进 URL。

模板与受众分离：同一模板可用于多个受众，同一受众可选择不同模板。保存的邮件准备记录包含模板版本、受众快照、主题/预览文字和同步映射；它不是 Klaviyo Campaign。

## 4. 用户页面的具体改动

### 4.1 列表、详情、批量选择

现有列表可增加“邮箱营销状态”“Klaviyo 匹配状态”“最近同步时间”列；详情侧栏增加营销卡片，显示 Profile ID、订阅同意、全局/目标名单抑制状态、所属名单及查询时间。

`selected` 当前用于打开单人详情，应继续保留。另加独立 `selectedIds: Set<string>` 负责复选框多选，不混用两个状态。`DataTable` 的选择能力采用可选参数，默认不改变产品、订单等页面。

批量操作必须显示作用范围与人数。“当前筛选结果”不能悄悄变成全体客户；更换筛选后应重新确认勾选范围。返回用户页要恢复筛选、排序和详情上下文；含邮箱的自由搜索不写入公开 URL 或日志。

### 4.2 受众快照

服务端基于当前数据源重新读取客户并计算筛选，生成：

- `id`、`storeKey`、`dataSource`、`sourceRevision`、创建时间及到期时间；
- 选择方式、客户 ID 集合、筛选条件摘要；
- 总人数、邮箱有效数、重复邮箱数、可用于营销数、待确认数、排除原因。

`sourceRevision` 应来自同步时间/内容指纹，不只依赖“Shopify”这个名字。推荐快照 24 小时过期，执行前仍须刷新订阅状态。数据源、店铺或 Klaviyo 账号变化时旧快照失效，不能把昨日的 Mock 选择误用于今日真实客户。

前后端共用筛选函数；服务端不接受浏览器声称的 LTV、标签、已订阅状态作为事实。对“勾选用户”也要逐个验证 ID 仍属于当前数据源。

### 4.3 身份匹配与字段映射

匹配键为 `(storeKey, klaviyoAccountId, opsCustomerId)`。先查已验证的 Profile 映射；没有映射再用清理首尾空白、按现有系统约定规范化的有效邮箱查找，冲突时交人工确认。不要做 Gmail 去点/去加号合并，也不跨店铺复用映射。

`source` 在当前客户行代表获客渠道，不代表 Mock/真实数据源。新增 `dataSource` 区分两者。`c...`、`g...` 是 OPS 本地客户标识，不直接覆盖 Klaviyo 的 `id` 或已有 Shopify 集成维护的 `external_id`。

仅在用户明确执行资料同步时写入白名单字段。建议将运营字段命名为 `ops_customer_ref`、`ops_segment`、`ops_tags`、`ops_orders`、`ops_ltv`、`ops_currency`、`ops_last_order_at`，避免覆盖 Klaviyo/Shopify 已维护的原生字段。货币单位无法核实时不推送裸 LTV 金额。

OPS 标签作为 Profile 自定义属性，不默认转换成 Klaviyo 资源标签。OPS 规则分层也不自动等同于 Klaviyo 动态 Segment；本期名单同步使用明确的人群快照。

### 4.4 订阅状态规则

读取 Klaviyo Profile 时显式请求 `additional-fields[profile]=subscriptions`，区分订阅同意、是否能够接收邮件、全局抑制和名单级抑制，保留原始值与查询时间。[K4][K7]

本期产品规则：只有取得明确订阅状态、且不受相关抑制影响的客户，才进入“营销名单同步”的合格集合；未订阅、已退订、被抑制、查询失败或未知者默认排除。此为 OPS 的保守业务规则，不宣称是所有地区法律或 Klaviyo 所有场景的唯一规则。

“客户资料同步”可以在合法业务权限与明确确认下独立执行，但不附带订阅操作。创建 Profile、更新属性、加入 List 都不应被 OPS 界面表述为“用户已同意营销”。本期不调用订阅、重新订阅或取消抑制接口。[K5][K6][K7]

## 5. 模板设计能力如何迁入

从旧 `detail.tsx` 抽取设计器组件和纯函数，不搬迁旧路由后端。目标拆分为 `TemplateEditor`、`HtmlCodeEditor`、`PreviewFrame`、`ElementInspector`、`AssetPicker`、`VersionPanel` 和 `KlaviyoSyncPanel`。

| 旧能力 | 本期处理 |
| --- | --- |
| HTML 源码/语法高亮/格式化/复制 | 复用交互；保留原始源码，格式化由用户触发 |
| 桌面/手机、缩放、选中节点定位源码 | 复用；编辑器按需加载，不影响用户分析首屏 |
| 修改文案、图片与链接 | 复用；保护嵌套标签、MSO 条件注释、Klaviyo 模板语法 |
| 图片库 | 改为本地轻量素材管理；发布时按需上传 Klaviyo |
| 保存版本、diff、回滚 | 使用本地快照；回滚生成新版本，不需要旧数据库 |
| 项目/主题上下文 | 收敛为本地分类和可选店铺标签，不迁移权限含义 |
| WS 实时刷新、AI Agent 推送 | 本期移除；编辑器即时预览不依赖服务器推送 |
| lint/截图任务 | 邮件 HTML 检查可调用无 DB 的检查器；自动截图不纳入首期 |

设计器通过新客户端接口读写，禁止引用 `@/db/*`、旧 `auth`、`useRealtime` 或旧 `client-api`。旧版独立站外壳和全局用户管理不复制。

## 6. 暂不接数据库时的数据方案

**不用数据库不等于不能保存。** 采用统一接口加文件适配器，默认服务端 JSON/HTML/图片文件；内存适配器只用于测试，不作为正式保存位置。浏览器 localStorage 仅存面板宽度等偏好，不存私钥或客户名单。

```text
web/data/edm/
  index.json                 # schemaVersion、模板/分类/素材索引
  templates/<id>.json       # 模板元数据、主题、预览文字、当前版本
  versions/<versionId>.json # 不可变 HTML 快照、版本时间、内容 hash
  assets/<assetId>.*        # 本地图片
  audiences/<id>.json      # 有时效的人群快照，尽量仅存 ID 和摘要
  preparations/<id>.json   # 模板版本与受众的组合，不是发送任务
  integrations.json        # 非敏感账号绑定、远端 ID 映射
  operations/<id>.json     # 同步执行记录、结果与重试进度，不记录密钥
```

运行数据加入 `web/.gitignore`；安全示例放入单独 fixtures。`OPS_DATA_DIR` 使用明确路径，不能因工作目录变化把数据写入旧 EDM 目录。所有写入校验 ID/路径，限制文件体积，防止任意文件访问。

文件写入需序列化、临时文件替换、乐观版本号校验及损坏恢复；同模板并发保存冲突返回 409。此方案仅支持单实例、有持久磁盘的受控部署，不声称支持多实例并发或无持久磁盘环境。

预留 `TemplateRepository`、`AssetRepository`、`AudienceRepository`、`PreparationRepository`、`IntegrationRepository`、`OperationRepository` 和只读 `CustomerSource` 接口。页面只依赖服务层，不直接访问文件。以后整个 OPS 接数据库时替换存储实现，并迁入文件数据；无需重写页面流程。数据库表结构、数据库供应商及旧 EDM 数据导入均留待后续统一设计。

## 7. Klaviyo 连接方案

### 7.1 连接方式与设置页

本期按自用 OPS 场景采用服务端 Private API Key，不搭建 OAuth 安装平台。请求由 OPS 服务端发出，浏览器只调用 `/api/integrations/klaviyo/*`。认证使用官方 Private Key 协议。[K8]

首期真实私钥由服务端环境变量 `KLAVIYO_PRIVATE_API_KEY` 提供；不放到 `NEXT_PUBLIC_*`、HTML、localStorage 或可下载 JSON。设置页显示“已配置/未配置”、脱敏提示、测试结果和当前账号。若后续增加网页录入私钥，必须先具备受保护的操作员身份和加密密钥存储，不能照搬当前通用配置的明文持久化方式。

非敏感设置包括账号标签、店铺绑定、API revision、默认目标名单和写入开关。环境变量与卡片状态属于待实现项，本次未创建或修改真实配置。

“测试连接”调用 `GET /api/accounts` 核对账号身份，再根据所需功能检查可读资源。账号检查成功不代表拥有所有写权限；无副作用读取不能证明 `templates:write` 等权限已配置，写权限应显示“待确认/首次操作验证”。[K1]

### 7.2 外部接口与最小权限

截至本次核查，所引用官方接口默认 revision 为 `2026-07-15`；拟通过 `KLAVIYO_API_REVISION` 显式固定，并在实现时重新核对，不使用未注明版本的请求。以下路径为 Klaviyo 外部接口，不是 OPS 路由。

| 功能 | Klaviyo 接口 | 最小 scope | 依据 |
| --- | --- | --- | --- |
| 账号核对 | `GET /api/accounts` | `accounts:read` | [K1] |
| 模板列表/详情 | `GET /api/templates`、`GET /api/templates/{id}` | `templates:read` | [K2] |
| 新增/更新模板 | `POST /api/templates`、`PATCH /api/templates/{id}` | `templates:write` | [K2][K3] |
| 远端变量预览 | `POST /api/template-render` | `templates:read` | [K9] |
| 图片文件上传 | `POST /api/image-upload` | `images:write` | [K10] |
| 匹配客户与读取状态 | `GET /api/profiles`，必要时读取 Profile 详情 | `profiles:read` | [K4] |
| 创建/更新客户资料 | `POST /api/profile-import` | `profiles:write` | [K5] |
| 名单选择 | `GET /api/lists` | `lists:read` | [K11] |
| 加入已确认目标名单 | `POST /api/lists/{id}/relationships/profiles` | `lists:write`、`profiles:write` | [K6] |

默认不申请 `subscriptions:write`、Campaign/Flow 发送权限；不因接入方便要求全权限私钥。缺少图片权限仍可设计模板，但含本地图片的发布应给出阻断提示。

## 8. 模板、图片和远端同步规则

### 8.1 模板类型与元数据

本期以 Klaviyo `CODE` HTML 模板为同步目标。官方当前也提供混合/原生拖拽模板类型，但它们不是本期的双向编辑范围；不能把原生拖拽模板作为普通 HTML 原地覆盖。[K2]

读取 Klaviyo 模板后先创建 OPS 本地副本。只有明确建立且确认的映射才允许更新远端。远端模板 ID 按字符串保存，并与 `klaviyoAccountId` 绑定。

本地 `subject`、`previewText` 和受众归属属于邮件准备记录；不假定模板 API 能同时创建带主题、收件人的 Campaign。当前同步成功仅指模板内容写入远端，正式活动配置和发送仍留在 Klaviyo 完成。[K2]

### 8.2 发布快照与冲突

编辑中源码、保存版本、实际推送 HTML 分开管理。同步时冻结一个版本，检查素材与模板语法，得到 `publishedHtml` 与 hash，再记录对应远端模板 ID、账号、时间及远端版本指纹。

默认创建 OPS 管理的独立模板；更新既有模板前核对远端是否被其他人修改，发生冲突则提供“另存为新模板”而非覆盖。历史版本不因图片 URL 替换或预览渲染而被改写。同步失败不丢本地草稿，也不把客户个性化后的预览 HTML 保存成全体用户通用模板。

保留 `{{ ... }}`、`{% ... %}` 及退订标签；首期营销模板检查器要求退订入口。Klaviyo 自定义 HTML 模板的官方说明明确要求退订标签。[K12] 浏览器样式预览不等于真实邮件客户端效果；远端 Render Template 可验证传入上下文的模板渲染，但也不是实际发送测试。[K9]

### 8.3 图片链路

本地图片先保存到文件适配器用于设计预览；点击同步时，由服务端将允许的图片上传 Klaviyo，使用返回的 `image_url` 生成发布快照。已有公开 HTTPS 图片可继续使用，但需检查是否长期可访问。

本期统一上传约束为 JPEG/PNG/GIF 且不超过 5 MB，与当前 Klaviyo 文件上传接口一致；旧 EDM 的 WebP/10 MB 规则不能直接沿用。暂不做静默格式转换，遇到不支持格式提示重新选择。[K10]

不能把本机路径、`localhost`、`blob:` URL、临时签名失效 URL 或需要 OPS 登录的图片链接直接推给邮件收件人。本地保存允许草稿含未发布素材；同步前必须解析并阻止未完成资产引用。外部图片检查使用受限请求策略，不允许通过图片 URL 访问内网/云元数据服务。

## 9. 客户资料与名单同步的执行规则

1. 操作前展示账号、店铺、目标名单、范围、将发送的字段、合格/排除人数及外部影响；由用户明确确认。
2. 使用受众快照中的稳定引用，在服务端重新解析真实客户。Mock、无邮箱、异常占位邮箱、跨账号映射全部禁止上传。
3. 优先匹配已有 Klaviyo Profile；没有匹配时，仅在单独确认“创建/更新资料”后建立资料，不自动订阅。现有字段缺失时省略，不用 `null` 清空远端。[K5]
4. 加入营销名单前刷新订阅/抑制状态；只提交本期规则允许的 Profile ID。接口每次最多 1000 条；OPS 自身采用更小的可配置批次与限流。[K6]
5. 明确“只增加成员”语义，不做删除远端多余成员的全量覆盖。单次名单快照不会自动变成持续运行的动态分群。
6. 分开记录匹配、资料写入、名单加入的成功、跳过、失败和结果不明；对已成功步骤不盲目重复执行。

**不调用发送 API 也不能保证远端绝不会发信。** 资料属性变化或名单成员变化可能影响 Klaviyo 已存在的分群/自动化；实际行为与入口方式和 Flow 配置有关。[K13] 因此默认仅在测试账号或已经确认不会触发现有自动化的范围内启用写入。生产资料/名单写入前必须确认影响；确认记录只覆盖对应账号、字段、名单与本次操作，不能用一次总确认永久放开。

## 10. 安全、异常和无数据库模式

### 10.1 访问与数据边界

不迁移旧 Auth.js，但新建 `requireOpsAccess`/`authorizeIntegrationAction` 接口。当前 OPS 源码未见可直接复用的完整操作员认证，不能把真实私钥后的写接口直接暴露在公网。受控本机开发可使用严格的本地访问策略；多人或公网使用须先接入 OPS 统一身份或可信访问网关，后端默认拒绝未验证操作员的真实写请求。

来自网关的身份头只能信任受限上游，不能信任浏览器自行传入的任意用户 ID。所有写请求校验身份、作用域、Origin/CSRF、输入及请求体大小；前端隐藏按钮不等于授权。私钥不进入响应、日志或客户端包。

默认 `KLAVIYO_ENABLE_WRITES=false`。未配置私钥、未验证访问或来源为 Mock 时，模板设计与模拟流程可用，真实客户写入不可用；服务端必须同样拦截，不能只禁用按钮。连接检查等无客户数据的只读动作可单独启用。

### 10.2 HTML 预览隔离

模板 HTML 不直接注入 OPS 主页面，继续通过 sandbox iframe 渲染；不能同时开放同源访问和不可信脚本执行。外部链接/表单/弹窗不得自动导航或提交；原模板脚本、事件属性等需要安全处理，预览 CSP 与素材加载策略单独限定。节点选中和编辑由可信宿主逻辑驱动，不把检查器脚本混入导出邮件。

使用测试数据作为默认预览上下文；打开真实客户预览需明确操作，不将客户列表附带给远端渲染。外部图片可能产生请求，不应在浏览客户时静默生成带个人数据的追踪请求。

### 10.3 限流、重试与恢复

统一服务端请求器处理超时、401、403、429、远端校验错误和分页。收到 429 按 `Retry-After` 等待，并限制重试次数/加入退避，不把它当作成功。[K14]

读取可以安全重试；创建模板/图片等写入若超时，结果可能不明，应先核对远端或交人工处理，不盲目重发造成重复。利用本地操作 ID、内容 hash、账号/目标映射和逐步结果记录实现应用级去重，不假定 Klaviyo 每个端点都支持通用幂等请求头。

本期不引入独立 Worker。长批量操作采用有限时间的请求分批执行并记录进度；连接中断后标为待恢复，页面明确点击继续。不能在 Route Handler 返回后启动不受管理的后台 Promise，并承诺它一定完成。文件存储的单实例限制同样适用于操作记录。

## 11. 拟新增目录与接口

```text
web/
  app/edm/page.tsx
  app/edm/templates/[templateId]/page.tsx
  app/api/edm/                         # 本地模板、素材、受众、准备记录、lint
  app/api/integrations/klaviyo/         # 连接、只读查询、预检、明确写入、结果
  components/edm/                      # 可复用设计器及同步面板
  components/customer-marketing/       # 用户详情营销卡片、受众操作、状态列
  lib/customer-segmentation.ts         # 从 CustomerInsights 抽出的纯筛选规则
  lib/edm/                            # 类型、校验、服务、存储契约
  lib/edm/repositories/                # file 与 memory；以后再加数据库适配器
  lib/integrations/klaviyo/             # 请求器、模板、图片、Profile、List 适配
  lib/customer-source.ts              # 读取现有 OPS 客户源并标记来源/店铺/版本
  data/edm/                           # 本地运行数据，gitignore
```

以下均为拟新增 OPS 接口，尚未实现：

| 接口 | 作用 |
| --- | --- |
| `/api/edm/templates`、`/api/edm/templates/[id]` | 本地模板 CRUD |
| `/api/edm/templates/[id]/versions` | 创建/读取版本；回滚生成新版本 |
| `/api/edm/assets`、`/api/edm/assets/[id]` | 本地素材上传/读取/删除，删除前检查引用 |
| `/api/edm/audiences/preview`、`/api/edm/audiences` | 受众计算与快照保存 |
| `/api/edm/preparations` | 关联模板版本、受众与本地主题等信息 |
| `/api/integrations/klaviyo/status`、`/test` | 脱敏状态、无副作用连接测试 |
| `/api/integrations/klaviyo/templates`、`/lists` | 读取远端模板/名单 |
| `/api/integrations/klaviyo/profiles/lookup` | 按已授权客户 ID 批量匹配并返回营销状态 |
| `/api/integrations/klaviyo/preflight` | 检查模板/素材/受众、生成确认摘要，不执行写入 |
| `/api/integrations/klaviyo/templates/sync` | 明确推送已冻结的本地模板版本及其素材 |
| `/api/integrations/klaviyo/profiles/sync` | 明确同步客户资料，不订阅、不加名单 |
| `/api/integrations/klaviyo/lists/sync` | 明确增加符合规则的名单成员 |
| `/api/integrations/klaviyo/operations/[id]` | 查询执行记录；恢复写入使用受保护的 POST 子操作 |

所有写入限定 POST/PATCH/DELETE，GET 不产生外部写副作用。列表查询先批量匹配、按账号缓存并限制并发，不给客户表格每一行发起一个独立外部请求。错误响应统一含 `code`、`message`、`retryable`、操作 ID，不回传私钥和完整远端敏感响应。

## 12. 文件级修改清单

| 文件/目录 | 计划动作 |
| --- | --- |
| `web/components/Nav.tsx` | 新增“EDM 邮件设计”入口，保留现有未提交改动 |
| `web/components/CustomersView.tsx` | 营销状态、独立多选状态、受众入口、同步结果；不破坏标签/详情/导出 |
| `web/components/CustomerInsights.tsx` | 引用抽出的共用分群函数；现有规则先保持一致 |
| `web/components/DataTable.tsx` | 可选受控多选接口，原有调用不变 |
| `web/components/SettingsView.tsx` | 增加 Klaviyo 配置展示/测试卡片和深链定位 |
| `web/lib/customer-source.ts` | 新增来源适配与店铺绑定；不引入旧 EDM 用户表 |
| `web/lib/mock.ts`、`web/lib/shopifySync.ts` | 首期尽量不改分析与同步算法；必要的身份/来源扩展向后兼容，不在本期附带重建数据源 |
| `web/app/globals.css`、模块 CSS | 限定 OPS 外壳选择器；EDM 使用 CSS Modules/模块命名，避免裸 `header/main/button/table` 规则相互污染 |
| `web/package.json`、lockfile | 仅补齐实际编辑器依赖，不复制旧 Next/React 版本或数据库依赖 |
| `web/.env.local.example`、`web/.gitignore` | 新增非真实配置示例、排除运行文件 |
| `web/smoke-test.mjs` 与新测试文件 | 保留原 OPS 冒烟；增加无数据库、无私钥、Mock 拦截和纯本地设计测试 |
| `edm/edm_manager/**` | 保留为参考，不删除、不启动，不迁移嵌套 `.git` |

编辑器可能需要 `@uiw/react-codemirror`、`@codemirror/lang-html`、直接使用的 `@codemirror/view`、`diff`、`js-beautify`，以及服务端校验/lint 的实际依赖。依赖版本以 OPS 当前兼容性验证为准。优先迁移必要样式到 CSS Modules，不将旧 Tailwind 全局入口/Preflight 整包注入 OPS。

## 13. 实施顺序与完成定义

| 阶段 | 交付物 | 进入下一阶段的条件 |
| --- | --- | --- |
| A：设计器独立化 | `/edm`、编辑器、本地素材与版本、文件存储适配 | 无 DB、无私钥环境可设计/保存/重启恢复/导出 |
| B：用户页联动 | 多选、共享筛选、受众快照、邮件准备记录 | 人数与用户页一致；源变化失效；Mock 仅模拟 |
| C：Klaviyo 只读连接 | 设置卡片、账号检查、模板/名单读取、Profile 状态 | 密钥不泄露；分页/限流/权限不足可解释 |
| D：受控写入 | 图片/模板推送、独立资料/名单同步、执行记录 | 先测试账号验证；访问保护、确认、状态过滤、结果不明处理均通过 |

本期验收不是“旧 EDM 可启动”，而是“一个 OPS 页面内可设计邮件，并从用户页选择真实受众，在明确确认后同步到正确 Klaviyo 账号”。资料/名单写入的真实验收需要受保护环境及测试账号；在未提供这些条件前，只能称模拟或契约测试通过，不能称已连通生产。

## 14. 验收、回归与回退

必须覆盖下列场景：

- 所有旧 `DATABASE_URL`/`EDM_*DATABASE_URL` 均不存在，OPS 仍能运行；本地模板刷新和重启后可恢复，损坏文件可诊断。
- HTML 导入、编辑、图片替换、桌面/手机预览、版本恢复正确；Klaviyo 标签和条件注释不被破坏；未保存离开有提示。
- 用户筛选、多选、当前筛选结果三者的范围明确；返回页面保留上下文；空邮箱/重复邮箱/访客 ID/店铺切换均有测试。
- Mock 客户不能从前端或直接 API 请求写进 Klaviyo；账号、来源和快照匹配由服务端验证。
- 订阅、抑制、名单成员三个概念不混淆；未知状态默认排除；未选择的客户不会被上传。
- 私钥不会出现在客户端 bundle、API 返回、HTML、日志、版本文件或 Git；未授权写请求被拒绝。
- Klaviyo 无配置、401、403、429、网络中断、远端修改冲突、图片不支持、部分失败均有明确结果；测试连接不创建任何资源。
- 预览不执行不可信脚本；图片 URL 的内网访问被拦截；推送的图片无登录依赖；个人预览内容不回写通用模板。
- 现有订单、产品、用户分析、标签、Shopify 同步、云途设置等保持原行为；测试不能触发真实发货、同步名单或营销发送。

实施时先记录 Git 工作区基线；当前有用户未提交修改和 `docs/PLAN.md` 删除状态，不执行 reset/clean，不恢复用户删除的文件。构建与 UI 测试使用隔离工作区/构建目录，避免覆盖运行服务的 `.next`。

回退先关闭 Klaviyo 写入，再隐藏 EDM 入口并恢复本次代码增量；保留本地模板与执行记录用于导出。回退 OPS 代码不会撤销已经上传的远端资源或恢复远端自动化影响，因此不要自动删除 Klaviyo Profile/名单成员来“回滚”。外部修复应依据执行记录另行确认。

## 15. 相比上一版的关键变化

删除“保留旧数据库 + 迁移 Auth.js + 运行 EDM 辅助进程”的实施前提；改为先迁移模板设计能力。删除旧项目权限、Agent 接口兼容及 WS/截图迁移任务。新增 Klaviyo 适配层、用户页人群选择、订阅状态边界、素材发布链路和可替换本地存储。将数据库建设留到整个 OPS 统一规划时开展。

**最终业务分工：OPS 用户页决定“面向谁”；EDM 设计器决定“内容是什么”；Klaviyo 负责接收模板和已确认的数据。实际活动与发送不在本期自动执行。**

## 16. 官方接口核查来源

核查日期：2026-10-03。以下只用于验证第三方接口语义，不表示已测试当前账号。落地时需以显式 revision 对照请求/响应 schema；官方文档示例中的历史版本号不能直接照抄。

- [K1] Get Accounts：`https://developers.klaviyo.com/en/reference/get_accounts`
- [K2] Templates API overview：`https://developers.klaviyo.com/en/reference/templates_api_overview`
- [K3] Create / Update Template：`https://developers.klaviyo.com/en/reference/create_template`；`https://developers.klaviyo.com/en/reference/update_template`
- [K4] Get Profiles：`https://developers.klaviyo.com/en/reference/get_profiles`
- [K5] Create or Update Profile：`https://developers.klaviyo.com/en/reference/create_or_update_profile`
- [K6] Add Profiles to List；Lists overview：`https://developers.klaviyo.com/en/reference/add_profiles_to_list`；`https://developers.klaviyo.com/en/reference/lists_api_overview`
- [K7] Understanding consent in profiles：`https://help.klaviyo.com/hc/en-us/articles/360037101072`
- [K8] Authenticate API requests：`https://developers.klaviyo.com/en/docs/authenticate_`
- [K9] Render Template：`https://developers.klaviyo.com/en/reference/render_template`
- [K10] Upload Image From File：`https://developers.klaviyo.com/en/reference/upload_image_from_file`
- [K11] Get Lists：`https://developers.klaviyo.com/en/reference/get_lists`
- [K12] Import a custom HTML template：`https://help.klaviyo.com/hc/en-us/articles/115005254068`
- [K13] List/segment-triggered flows；Troubleshooting：`https://help.klaviyo.com/hc/en-us/articles/360003040052`；`https://help.klaviyo.com/hc/en-us/articles/12414318812827`
- [K14] Rate limits, status codes, and errors：`https://developers.klaviyo.com/en/docs/rate_limits_and_error_handling`

本次实际操作范围：仅更新本根目录方案文件；未改业务代码、未安装依赖、未启动或重启服务、未访问旧数据库、未执行真实 Klaviyo 读写或发送。
