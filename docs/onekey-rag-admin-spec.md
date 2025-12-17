# OneKey RAG Admin（企业后台）规格说明（多租户 / 多 RagApp）

> 版本：v0.1（草案）  
> 适用阶段：内部先用，但按“可交付（多租户）”设计  
> 前端：React + shadcn/ui + TanStack Query/Table（Dashboard 模板做壳）  
> 后端：现有 FastAPI（`src/onekey_rag_service/api/app.py`）扩展 `/admin/api/*`  
> 实现进度：见 `docs/onekey-rag-admin-todo.md`（以本文为规格来源）

---

## 0. 目标与原则

### 0.1 目标（对齐 Dify/FastGPT 的 RAG 抽象）

在**同一套平台**里管理多个 RagApp（每个 RagApp 可绑定一个或多个知识库），并提供：

1. **可视化运营/运维**：抓取、索引、发布、质量反馈、告警/自检。
2. **可治理**：多租户隔离、RBAC、审计、配额（后续）。
3. **可扩展**：连接器（爬虫/文件/Notion/Confluence…）、索引版本、回滚、评测回归。

### 0.2 设计原则

- **租户优先**：所有数据必须归属到 `workspace_id`（当前阶段以 workspace 为唯一租户隔离边界）。
- **App 与 KB 解耦**：RagApp（应用）可以复用 KB；KB 可以被多个 App 绑定。
- **多 KB 绑定可控**：一个 RagApp 可绑定多个 KB，并配置“权重/优先级”（决定多 KB 检索的配比与排序策略）。
- **异步任务闭环**：采集/索引/发布统一用 Job 管控，支持重试/取消/审计。
- **统一入口**：后台能力统一走 `/admin/api/*`，前端通过 `/admin/ui/*` 提供。

### 0.3 已确认决策（本轮讨论）

- RagApp：允许绑定多个 KB，并配置权重/优先级
- 租户隔离：当前只需要 `workspace_id`
- 可观测：允许入库“检索 debug 元数据”，但**不存原文**（不存 chunk_text/页面正文/完整对话内容）
- 管理后台鉴权：单超管（环境变量）+ JWT（后续可扩展 refresh/RBAC/SSO）

---

## 1. 总体架构与路由约定

### 1.1 路由命名空间

- Admin UI（静态资源）：`/admin/ui/*`
- Admin API（管理接口）：`/admin/api/*`
- 对外 OpenAI 兼容接口：`/v1/*`
- Widget：`/widget/*`

> 说明：Admin UI 不直接占用 `/admin/*` 根路径，统一用 `/admin/ui/*` 承载静态资源。

### 1.2 多 RagApp 与对外 `model` 的关系（建议）

- 每个 RagApp 对外暴露一个 `public_model_id`（例如 `onekey-docs`、`wallet-support`）。
- 客户端调用 `/v1/chat/completions` 时使用 `model=public_model_id`。
- 服务端根据 `model` 路由到对应 RagApp 配置（检索范围、上游模型、重排策略等）。

---

## 2. 核心实体模型（建议）

> 字段为“建议最小集合”，可按实现逐步扩展。

### 2.1 组织与工作区

当前阶段：以 `workspace_id` 作为唯一租户隔离边界（内部使用先跑通闭环）。  
未来如确需“企业/客户（Org）→ Workspace”的两层结构，可在 `Workspace` 上补 `org_id` 与成员体系。

- `Workspace`（工作区）
  - `id`, `name`, `created_at`
- `User`（用户）
  - `id`, `email`, `name`, `status`
- `Membership`（成员关系）
  - `id`, `workspace_id`, `user_id`, `role`

### 2.2 RagApp（应用）

- `RagApp`
  - `id`, `workspace_id`, `name`, `public_model_id`, `status(draft/published)`, `created_at`, `updated_at`
  - `chat_config`（上游模型/温度/超时/重试…）
  - `retrieval_config`（vector/hybrid、topK、权重、filters…）
  - `rerank_config`（provider、max_candidates、device…）
  - `rate_limit_config`（可选）

> 对标：Dify 的 App / FastGPT 的应用与知识库绑定关系。

#### 2.2.1 RagApp ↔ KB 绑定（多选 + 权重/优先级）

- `RagAppKnowledgeBase`（建议表名：`app_kbs`）
  - `id`
  - `workspace_id`
  - `app_id`
  - `kb_id`
  - `priority`：整数，越小优先级越高（用于“先后顺序/兜底顺序/同分 tie-break”）
  - `weight`：浮点数（建议 0.0–1.0），用于“多 KB 检索配比”（例如每个 KB 分配 topK 配额或得分加权）
  - `enabled`：是否启用（便于临时下线某 KB）
  - `created_at`

多 KB 检索的落地策略（实现时二选一或组合）：

1. **分 KB 召回再合并（推荐）**：按权重计算每个 KB 的 `top_k_i`，分别召回后合并去重，再统一重排/截断。
2. **统一召回 + 权重调分**：一次性在多 KB 范围检索，但对不同 KB 的候选做 `score *= weight` 或加偏置。

> 优先推荐方案 1：可控、直观、便于解释与调参（也更贴近 Dify/FastGPT 的“多数据集检索合并”）。

### 2.3 KnowledgeBase（知识库/数据集）

> KB（Knowledge Base）在本项目里是一个“可复用的数据集/知识库”：由一个或多个数据源（crawler/file/…）采集出 Page，再分块为 Chunk，计算 embedding 写入向量索引。  
> RagApp 绑定 KB 决定“检索范围”，同一个 KB 可以被多个 RagApp 复用。

- `KnowledgeBase`
  - `id`, `workspace_id`, `name`, `description`, `status`
  - `chunking_config`（max_chars/overlap）
  - `embedding_config`（provider/model/dim）
  - `index_config`（pgvector index type/fts config）

### 2.4 数据源与文档

- `DataSource`（连接器）
  - `id`, `workspace_id`, `kb_id`, `type(crawler_site/file_upload/...)`, `config`, `schedule_config`, `status`
- `Document/Page`
  - `id`, `workspace_id`, `kb_id`, `source_id`, `url/title/http_status/content_hash/indexed_content_hash/last_crawled_at/meta`
- `Chunk/Segment`
  - `id`, `workspace_id`, `kb_id`, `page_id`, `chunk_index/section_path/chunk_text/embedding/embedding_model/...`

### 2.5 任务与版本

- `Job`（统一任务）
  - `id`, `workspace_id`, `type(crawl/index/publish/...)`, `scope(app_id/kb_id/source_id)`, `status`, `payload`, `progress`, `error`, `started_at`, `finished_at`
- `IndexBatch`（可选，建议 P1）
  - 记录每次索引构建的批次号、发布状态、可回滚点

### 2.6 反馈与审计（建议）

- `Feedback`：建议关联 `workspace_id`、`app_id`（来源于调用时的 `model`）
- `AuditLog`：记录“谁在什么时候做了什么”（参数摘要 + 结果）
- `RetrievalEvent`（检索事件，仅存元数据，不存原文）
  - `id`, `workspace_id`, `app_id`, `kb_ids[]`
  - `request_id`（服务端生成）、`conversation_id`、`message_id`（如前端传入）
  - `created_at`, `latency_ms`, `timings_ms`（JSON）
  - `retrieval`（JSON：candidate chunk_ids、scores、rerank_scores、topN 命中等）
  - `sources`（JSON：sources urls + ref + title/section_path 可选；不含 snippet 原文也可）
  - `token_usage`（JSON，可选）、`error_code`（可选）

> 约束：默认不存 `chunk_text/content_markdown`、不存完整对话内容；如确需“问题文本”用于排障，建议存 `query_hash` + `query_len` 等派生字段，并通过可配置开关控制是否存明文 query。

---

## 3. 权限与鉴权（JWT + RBAC）

### 3.1 为什么仍建议保留 Caddy

- **Caddy 的角色**：TLS 证书、反向代理、压缩、基础限流/黑白名单（可选）。
- **JWT 的角色**：应用层鉴权/授权/审计闭环。

> 即使使用 JWT，也需要一个入口层（Caddy/Ingress/云 LB）来提供 HTTPS 与流量治理。

### 3.2 JWT 方案建议（Admin 场景）

建议采用“短期 access_token + 可选 refresh_token”的标准实践：

- `access_token`：JWT，短 TTL（如 15–60 分钟），用于访问 `/admin/api/*`
- `refresh_token`：可选（建议），用于无感续期（可做成 httpOnly Cookie）

### 3.3 RBAC（最小可用）

角色建议（可与 TODO 文档保持一致）：

- `Owner/Admin`：全权限（含成员/安全/密钥/删除）
- `Operator`：任务/索引/数据维护
- `Viewer`：只读（看板/详情/日志）

---

## 4. Admin UI 页面信息架构（路由 + 数据 + 动作）

> 以“Dashboard 模板壳 + TanStack Table”为前提，优先满足 P0（运维台）闭环。

### 4.1 全局能力

- Workspace/App 切换器：全局顶部下拉（决定后续所有请求的 scope）
- 时间范围选择器：默认最近 24h/7d（聚合接口支持）
- 统一空态/错误态：鉴权失败跳转登录；网络错误提示重试

### 4.2 页面清单（P0 优先）

#### A. 登录
- 路由：`/admin/ui/login`
- 依赖接口：`POST /admin/api/auth/login`、`GET /admin/api/auth/me`

#### B. 总览仪表盘
- 路由：`/admin/ui/dashboard`
- 目标：一屏看到“数据规模/任务状态/健康与告警”
- 依赖接口：
  - `GET /admin/api/workspaces/{workspace_id}/summary`
  - `GET /admin/api/workspaces/{workspace_id}/health`

#### C. RagApp 管理

1) App 列表
- 路由：`/admin/ui/apps`
- 列：name、public_model_id、绑定 KB 数、状态、最近请求量（P1）、更新时间
- 动作：新建/编辑/发布/下线/复制配置（P1）
- 依赖接口：`GET/POST /admin/api/workspaces/{workspace_id}/apps`

2) App 详情（多 Tab）
- 路由：`/admin/ui/apps/:appId`
- Tab 建议：
  - `设置`：基础信息 + 对外 model_id
  - `检索配置`：topK/权重/过滤器/重排开关
  - `模型配置`：上游 provider/base_url/model/超时
  - `绑定知识库`：选择 KB（可多选）+ 配置 `weight/priority`（支持拖拽排序、启用/禁用）
  - `调试台`（P1）：输入问题，展示检索 topK + sources + timings
- 依赖接口：`GET/PATCH /admin/api/workspaces/{workspace_id}/apps/{app_id}` 等

#### D. 知识库（KB）管理

1) KB 列表
- 路由：`/admin/ui/kbs`
- 列：name、数据源数、pages/chunks 规模、embedding 覆盖率、最近索引批次（P1）
- 动作：新建/编辑/触发抓取/触发索引/删除（需二次确认）
- 依赖接口：`GET/POST /admin/api/workspaces/{workspace_id}/kbs`

2) KB 详情
- 路由：`/admin/ui/kbs/:kbId`
- Tab 建议：
  - `概览`：pages/chunks、覆盖率、维度、索引存在性
  - `数据源`：crawler 配置（sitemap/seed/include/exclude/max_pages）
  - `页面`：pages 列表/详情（可重新抓取、删除）
  - `分块`（可选）：chunks 列表/检索预览
  - `索引批次`（P1）：构建/发布/回滚
- 依赖接口：`/kbs/{kb_id}/*`

#### E. 任务中心
- 路由：`/admin/ui/jobs`
- 能力：按类型/状态/时间过滤；展示进度与错误；支持重试/取消
- 依赖接口：
  - `GET /admin/api/workspaces/{workspace_id}/jobs`
  - `GET /admin/api/workspaces/{workspace_id}/jobs/{job_id}`
  - `POST /admin/api/workspaces/{workspace_id}/jobs/{job_id}/requeue`
  - `POST /admin/api/workspaces/{workspace_id}/jobs/{job_id}/cancel`

#### F. 反馈与质量
- 路由：`/admin/ui/feedback`
- 列：rating/reason/app_id/created_at/message_id/sources
- 动作：标注（P1）、导出（P2）
- 依赖接口：`GET /admin/api/workspaces/{workspace_id}/feedback`

### 4.3 页面清单（P1/P2）

- 质量看板：`/admin/ui/quality`（按 app/kb 聚合检索命中、topK 分布、rerank 效果、延迟分解、错误码、token/成本、告警）
- 请求日志/检索日志：`/admin/ui/observability`（需要后端结构化埋点）
- 审计日志：`/admin/ui/audit`
- 成员与权限：`/admin/ui/access`
- API Key/配额：`/admin/ui/api-keys`、`/admin/ui/quotas`
- 评测集与回归：`/admin/ui/evals`

---

## 5. Admin API 接口清单（建议）

> 说明：为降低前端复杂度，建议接口“面向页面”提供聚合字段，而不是只提供细粒度 CRUD。

### 5.1 Auth

- `POST /admin/api/auth/login`
  - 入参：`{ username, password }`
  - 出参：`{ access_token, token_type: "bearer", expires_in }`（refresh 可选）
- `POST /admin/api/auth/refresh`（可选）
- `POST /admin/api/auth/logout`（可选）
- `GET /admin/api/auth/me`

### 5.2 Workspace 与上下文

- `GET /admin/api/workspaces`：列出当前用户可访问的 workspaces
- `GET /admin/api/workspaces/{workspace_id}`：workspace 详情

### 5.3 仪表盘与健康自检

- `GET /admin/api/workspaces/{workspace_id}/summary`
  - 返回：pages/chunks/jobs/feedback 规模、24h 增量、失败抓取数、embedding 覆盖率、索引存在性、告警项（维度不一致等）
- `GET /admin/api/workspaces/{workspace_id}/health`
  - 返回：DB/pgvector/索引自检 + 基础运行信息
- `GET /admin/api/workspaces/{workspace_id}/settings`
  - 返回：**脱敏**的运行时配置（用于 UI 展示/排障）
- `GET /admin/api/workspaces/{workspace_id}/system`
  - 用途：展示“运行态资源”（容器视角 CPU/内存/磁盘/进程 RSS/FD/uptime），用于 Dashboard 运维卡片
  - 说明：CPU 使用率基于“上次采样 delta”，首次调用可能返回 `null`，前端应做占位展示
- `GET /admin/api/workspaces/{workspace_id}/storage`
  - 用途：展示“容量/成本”更相关的指标：Postgres 数据库体积 + 核心表/索引占用（chunks/retrieval_events/pages…）
  - 说明：建议低频刷新（例如 30s/手动），避免频繁执行 pg_*size 查询

### 5.4 RagApp

- `GET /admin/api/workspaces/{workspace_id}/apps`
- `POST /admin/api/workspaces/{workspace_id}/apps`
- `GET /admin/api/workspaces/{workspace_id}/apps/{app_id}`
- `PATCH /admin/api/workspaces/{workspace_id}/apps/{app_id}`
- `GET /admin/api/workspaces/{workspace_id}/apps/{app_id}/kbs`
- `PUT /admin/api/workspaces/{workspace_id}/apps/{app_id}/kbs`
  - 入参：`{ bindings: [{ kb_id, weight, priority, enabled }] }`
  - 语义：全量覆盖（便于前端拖拽排序后一次提交）
- `POST /admin/api/workspaces/{workspace_id}/apps/{app_id}/publish`（P1）
- `POST /admin/api/workspaces/{workspace_id}/apps/{app_id}/unpublish`（P1）

### 5.5 KnowledgeBase（KB）

- `GET /admin/api/workspaces/{workspace_id}/kbs`
- `POST /admin/api/workspaces/{workspace_id}/kbs`
- `GET /admin/api/workspaces/{workspace_id}/kbs/{kb_id}`
- `PATCH /admin/api/workspaces/{workspace_id}/kbs/{kb_id}`
- `DELETE /admin/api/workspaces/{workspace_id}/kbs/{kb_id}`（危险操作：二次确认 + 审计）
- `GET /admin/api/workspaces/{workspace_id}/kbs/{kb_id}/stats`
  - embedding 覆盖率、维度一致性、索引存在性、最近索引任务

### 5.6 数据源（以 crawler 为 P0 起点）

- `GET /admin/api/workspaces/{workspace_id}/kbs/{kb_id}/sources`
- `POST /admin/api/workspaces/{workspace_id}/kbs/{kb_id}/sources`
- `PATCH /admin/api/workspaces/{workspace_id}/kbs/{kb_id}/sources/{source_id}`
- `DELETE /admin/api/workspaces/{workspace_id}/kbs/{kb_id}/sources/{source_id}`

### 5.7 任务（Jobs）

- `GET /admin/api/workspaces/{workspace_id}/jobs`
  - query：`type/status/kb_id/app_id/source_id/q/created_from/created_to/page/page_size`
- `GET /admin/api/workspaces/{workspace_id}/jobs/{job_id}`
- `POST /admin/api/workspaces/{workspace_id}/jobs/{job_id}/requeue`
- `POST /admin/api/workspaces/{workspace_id}/jobs/{job_id}/cancel`（需要 worker 支持“可取消”语义）

触发任务（建议统一）：
- `POST /admin/api/workspaces/{workspace_id}/jobs/crawl`
  - 入参：`{ kb_id, source_id, mode, sitemap_url, seed_urls, include_patterns, exclude_patterns, max_pages }`
- `POST /admin/api/workspaces/{workspace_id}/jobs/index`
  - 入参：`{ kb_id, mode }`

### 5.8 Pages（文档页/页面）

- `GET /admin/api/workspaces/{workspace_id}/pages`
  - query：`kb_id/source_id/http_status/q/changed/indexed/page/page_size`
- `GET /admin/api/workspaces/{workspace_id}/pages/{page_id}`
  - 返回：page 详情 + `chunk_stats`（total/with_embedding/embedding_coverage/embedding_models）
- `POST /admin/api/workspaces/{workspace_id}/pages/{page_id}/recrawl`
- `DELETE /admin/api/workspaces/{workspace_id}/pages/{page_id}`（危险操作：二次确认 + 审计）

### 5.9 Chunks（可选，P0 可以只做统计 + 详情里展示）

- `GET /admin/api/workspaces/{workspace_id}/chunks`
  - query：`kb_id/page_id/q/has_embedding/page/page_size`
- `GET /admin/api/workspaces/{workspace_id}/chunks/{chunk_id}`

### 5.10 Feedback

- `GET /admin/api/workspaces/{workspace_id}/feedback`
  - query：`app_id/rating/reason/q/date_range/page/page_size`

### 5.11 Observability（检索事件 / 调试元数据）

- `GET /admin/api/workspaces/{workspace_id}/retrieval-events`
  - query：`app_id/kb_id/conversation_id/request_id/has_error/date_range/page/page_size`
- `GET /admin/api/workspaces/{workspace_id}/retrieval-events/{event_id}`

### 5.12 质量聚合与告警（P1）

- `GET /admin/api/workspaces/{workspace_id}/observability/summary`
  - query：`date_range=24h|7d|30d`
  - 返回（建议最小集合）：
    - overall：请求量、错误率、平均/分位延迟（prepare/chat/total）
    - by_app / by_app_kb：检索命中、topK 分布、embedding 覆盖率、错误码
    - rerank_effect：抽样对比（pre/post top_scores）
    - tokens_by_model：按上游模型聚合 token；如配置计价则返回成本估算
- `GET /admin/api/workspaces/{workspace_id}/alerts`
  - query：`date_range=24h|7d|30d`
  - 返回：告警列表（规则示例：jobs_failed、retrieval_error_ratio、embedding_coverage_low）

> 成本估算可通过环境变量 `MODEL_PRICING_JSON` 配置计价（用于内部观测，非强一致计费）。

---

## 6. 兼容与迁移建议（从现有表到多租户）

当前实现：`pages/chunks/jobs/feedback` 均为单库单租户。

建议演进路径（避免一次性大迁移）：

1. **引入默认 workspace/kb/app**：先在逻辑层固定 `default_workspace_id/default_kb_id`（P0 UI 即可跑通）
2. **表字段补齐**：在 `pages/chunks/jobs/feedback` 增加 `workspace_id`，并逐步增加 `kb_id/app_id/source_id`
3. **新增绑定表**：增加 `app_kbs`（app ↔ kb + weight/priority）
4. **新增事件表**：增加 `retrieval_events`（仅存检索调试元数据，不存原文）
5. **请求路由改造**：`/v1/chat/completions` 基于 `model(public_model_id)` 选择 app + kb 范围（多 KB 按 weight/priority 合并）
6. **数据隔离强制**：所有查询必须带 `workspace_id`

---

## 7. 部署与入口层（Caddy）

- 继续采用 `docs/deploy-vps.md` 的“Compose + Caddy”作为默认生产模板。
- JWT 上线后，`BasicAuth` 可：
  - 关闭（仅依赖 JWT）
  - 或作为“额外一层门禁”保留（例如只开放给内网/办公网/VPN）
- 建议：BasicAuth 仅用于保护 legacy 接口（如 `/admin/index`、`/admin/crawl*`）；新后台 `/admin/ui/*` 与 `/admin/api/*` 走 JWT，以免“二次门禁”影响登录与脚本调用。

> 注意：如果 BasicAuth 覆盖 `/admin/*`，Admin UI 与 `/admin/api/auth/login` 也会被二次门禁；这通常是预期行为（只给内部人员访问），但要注意前端与脚本都需要带 BasicAuth。

---

## 8. 参考与借鉴（开源 / LangChain 生态）

> 结论：LangChain 生态里“可直接拿来当企业级 RAG 平台”的项目不多，但有不少组件/平台适合借鉴（编排、调试、Serve、流程化）。

- LangServe：把 LangChain 的 chain/tool 直接以 FastAPI 方式对外提供 API；适合做“调试台/内部实验 API”，但不含多租户/版本治理/运维后台。
- LangGraph：适合把 RAG 做成可控工作流（query rewrite → retrieve → rerank → answer），利于复杂链路可观测与可回放；可作为本项目后续“调试台/评测回归/A-B 分流”的编排内核。
- Langflow：可视化编排（偏原型/实验）；适合产品/算法同学快速试链路，再把稳定配置落回到 RagApp 的“发布配置”里。
- Flowise：LangChainJS 生态的可视化编排；优势是上手快、连接器多；劣势是生产治理（多租户/RBAC/审计/版本/回滚）需要较多二次开发。
- Dify / FastGPT：更适合作为“后台信息架构与交互范式”的参考（App/KB/数据源/任务/观测），与本项目的目标一致。
