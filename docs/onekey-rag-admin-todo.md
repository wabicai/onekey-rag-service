# OneKey RAG Admin 开发进度与待办（以 spec 为准）

> 本文件是“实现进度清单”，规格与页面/接口定义以 `docs/onekey-rag-admin-spec.md` 为准。  
> 约定：内部先用，但按 `workspace_id` 多租户边界设计；一个 RagApp 可绑定多个 KB（weight/priority/enabled）。

---

## 1. 当前可测试入口（本地 compose）

- Admin UI：`http://localhost:8000/admin/ui/#/login`
- Admin API：`http://localhost:8000/admin/api/*`
- 健康检查：`http://localhost:8000/healthz`

---

## 2. P0（内部可用：运维闭环）

### 2.1 Admin UI（对齐 spec 4.x）

- [x] 登录（`/admin/ui/#/login`）
- [x] 登录成功后自动跳转到 Dashboard（支持回跳到原目标页）
- [x] 总览（summary/health/settings/models）`/admin/ui/#/dashboard`
- [x] 质量看板（聚合指标/告警/成本）`/admin/ui/#/quality`
- [x] 清新主题与背景（浅色 + 渐变背景 + 主色调优化）
- [x] 系统资源卡片（CPU/内存/磁盘/进程 RSS/FD/uptime）
- [x] 数据库存储卡片（Postgres DB 体积 + 核心表/索引占用）
- [x] RagApp：列表/创建/编辑/绑定 KB（weight/priority/enabled）`/admin/ui/#/apps`
- [x] 知识库：列表/创建/编辑/删除（含 stats）`/admin/ui/#/kbs`
- [x] 数据源：crawler 配置 CRUD（JSON 编辑）在 KB 详情页
- [x] 任务中心：触发 crawl/index + 列表/详情/重入队/取消 `/admin/ui/#/jobs`
- [x] Pages：列表/筛选/详情 + 单页 recrawl/删除 `/admin/ui/#/pages`
- [x] 反馈：列表 + app/rating/reason 过滤 `/admin/ui/#/feedback`
- [x] 观测：Retrieval Events 列表/详情（仅元数据，不存原文）`/admin/ui/#/observability`
- [x] 设置：脱敏配置展示 ` /admin/ui/#/settings`
- [x] Page 详情补齐“关联 chunk 统计”（spec 4.2.C/5.8/5.9）
- [ ] Workspace 切换器（spec 4.1：当前仅展示 workspace_id，未做下拉切换）

### 2.2 Admin API（对齐 spec 5.x）

- [x] Auth：`POST /admin/api/auth/login`、`GET /admin/api/auth/me`
- [x] Workspace：`GET /admin/api/workspaces`、`GET /admin/api/workspaces/{workspace_id}`
- [x] Dashboard：`GET /admin/api/workspaces/{workspace_id}/summary`、`/health`、`/settings`
- [x] 系统资源：`GET /admin/api/workspaces/{workspace_id}/system`
- [x] 质量聚合：`GET /admin/api/workspaces/{workspace_id}/observability/summary`
- [x] 告警：`GET /admin/api/workspaces/{workspace_id}/alerts`
- [x] RagApp：`GET/POST/GET/PATCH /admin/api/workspaces/{workspace_id}/apps/*`
- [x] App↔KB：`GET/PUT /admin/api/workspaces/{workspace_id}/apps/{app_id}/kbs`（全量覆盖）
- [x] KB：`GET/POST/GET/PATCH/DELETE /admin/api/workspaces/{workspace_id}/kbs/*`
- [x] KB stats：`GET /admin/api/workspaces/{workspace_id}/kbs/{kb_id}/stats`
- [x] Sources：`GET/POST/PATCH/DELETE /admin/api/workspaces/{workspace_id}/kbs/{kb_id}/sources/*`
- [x] Jobs：`GET /jobs`、`GET /jobs/{job_id}`、`POST /jobs/{job_id}/requeue`、`POST /jobs/{job_id}/cancel`、`POST /jobs/crawl`、`POST /jobs/index`
- [x] Pages：`GET /pages`、`GET /pages/{page_id}`、`POST /pages/{page_id}/recrawl`、`DELETE /pages/{page_id}`
- [x] Feedback：`GET /feedback`
- [x] Retrieval Events：`GET /retrieval-events`、`GET /retrieval-events/{event_id}`
- [ ] Chunks（可选）：`GET /chunks`、`GET /chunks/{chunk_id}`（spec 5.9；用于排障/统计/对齐 page 详情能力）

---

## 3. P0 缺口（按 spec 为准，建议优先补齐）

### 3.1 统计与排障

- [x] Page 详情增加 chunk 统计（chunk_count/with_embedding 等），并在 UI 展示
- [x] Jobs 列表补齐更多过滤条件：`app_id/source_id/q/created_from/created_to`（spec 5.7）
- [x] Pages 列表补齐过滤：`source_id/indexed`（spec 5.8）
- [x] Feedback 增加 `date_range`（spec 5.10）
- [x] Retrieval Events（Observability）增加 `date_range`（spec 5.11）
- [ ] 观测数据“保留/清理”工具（按 workspace/时间窗清理 retrieval_events，避免库膨胀）

### 3.2 UI 体验（对齐 Dify/FastGPT 的后台交互）

- [ ] RagApp 详情页 Tab 化：设置/检索/模型/绑定 KB/调试台（常用字段表单化，JSON 编辑器作为“高级模式”）
- [ ] KB 详情页 Tab 化：概览/数据源/Pages/索引/自检（crawler 配置表单化，JSON 编辑器作为“高级模式”）
- [ ] 全局 Workspace/App 切换器（顶部下拉）+ 面包屑（减少迷路与回退成本）

---

## 4. P1（可运营 + 可观测 + 可治理）

### 4.1 认证与权限（spec 3.x）

- [ ] RBAC（Admin/Operator/Viewer）与最小权限
- [ ] `POST /admin/api/auth/refresh`、`POST /admin/api/auth/logout`（可选）
- [ ] 危险操作二次确认 + 审计（删除 KB/Page 等）

### 4.2 质量与可观测（企业化方向）

- [x] RetrievalEvent 入库（仅 debug 元数据，不存原文）
- [x] 检索事件元数据增强（timings_ms、上游模型信息、rerank 前后分数抽样等）
- [x] 聚合指标接口 + 质量页（按 app/kb 聚合：命中/错误码/topK/延迟/成本估算）
- [x] 告警接口 + Dashboard 告警卡片（规则：jobs_failed/retrieval_error_ratio/embedding_coverage_low）
- [ ] Debug 面板（App 详情“调试台”）：输入问题，展示检索 topK + sources + timings（spec 4.2.C）
- [ ] 指标（Prometheus）+ Trace（OpenTelemetry）+ 告警（按需，生产建议）

### 4.3 发布治理（spec 5.4）

- [ ] RagApp 发布/下线：`POST /apps/{app_id}/publish`、`/unpublish`（P1）

### 4.4 配置治理（企业化方向）

- [ ] RagApp 配置版本化：draft/publish、回滚、差异对比
- [ ] 变更审计：AuditLog（谁在什么时候改了什么）
- [ ] KB 分块/embedding 维度一致性校验与重建工具（不一致时可一键重建）
- [ ] 配置导入/导出（App/KB 配置 JSON 备份，便于交付与迁移）

### 4.5 权限与交付（企业化方向）

- [ ] 审计日志：`/admin/ui/#/audit`
- [ ] 成员与权限：`/admin/ui/#/access`
- [ ] API Key/配额：`/admin/ui/#/api-keys`、`/admin/ui/#/quotas`
- [ ] API Key 校验开关 + 配额/限流（服务侧）
- [ ] 安全基线：登录防爆破（限流/延迟）、JWT Secret 轮换策略、关键操作二次确认默认开启

### 4.6 评测回归（企业化方向）

- [ ] 评测集管理：`/admin/ui/#/evals`（导入/版本/标签）
- [ ] 离线回归：固定模型与配置跑全量评测，支持对比
- [ ] A/B 对比：按 app 配置分流，对比命中/延迟/反馈分布

### 4.7 运维与平台化（建议补充）

- [ ] 版本信息：`GET /admin/api/version`（git_sha/build_time/app_env），在 Dashboard/设置页展示
- [ ] 运行态日志：支持查看/下载 api/worker 日志（按 job_id/app_id 过滤）
- [ ] 数据库体检：表/索引大小、膨胀与 vacuum 建议（重点 chunks/retrieval_events）
- [ ] 监控对接：Prometheus `/metrics` + Grafana dashboard（与内置“系统资源卡片”互补）
- [ ] 告警通知：Webhook/飞书/Slack（当前仅 UI 展示告警）

---

## 5. P2（企业化：交付级多租户/治理/成本）

> 以 `docs/onekey-rag-admin-spec.md` 第 2/6 节的“实体模型与迁移路径”为准：Users/Workspaces/Memberships、IndexBatch、版本回滚、配额、成本看板等。
