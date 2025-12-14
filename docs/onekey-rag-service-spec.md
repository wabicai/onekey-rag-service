# OneKey 开发者文档 RAG 服务 —— 需求与技术方案（Spec）

> 版本：v0.1（MVP 规格）  
> 文档域名：`https://developer.onekey.so/`（静态站点，GitHub Pages 托管）  
> 对外接口：OpenAI 兼容（`/v1/chat/completions`）  
> 技术约束：使用 `langchain==1.1.0`；尽可能本地部署；向量库优先 `pgvector`  

---

## 0. 概述

### 0.1 背景
OneKey 开发者文档覆盖 SDK/API/集成指南/故障排查等内容。为了提升开发者自助效率并降低支持成本，需要构建一个面向开发者的 AI 对话服务，能够围绕官方文档进行问答，并在答案中提供可追溯的引用与原始网页链接（source URLs），体验对标 Inkeep。

### 0.2 核心原则
1. **可追溯**：每次回答必须返回引用来源（URL），并尽可能提供引用片段（snippet）与章节路径（section_path）。
2. **可信**：不得编造不存在的 API/参数/行为；当文档未明确说明时，需提示不确定性并给出可点击的文档入口。
3. **可持续更新**：支持增量爬取与增量入库，减少全量重建成本。
4. **本地优先**：爬虫、解析、索引、向量检索、重排尽可能本地部署；ChatModel 允许外部 API（可插拔）。

### 0.3 范围（Scope）
**MVP 包含：**
- 文档爬取（sitemap + 站内链接发现，域名限制为 `developer.onekey.so`）
- HTML 清洗与结构化抽取（标题层级、代码块、正文）
- 文档分块（chunking）与元数据生成（URL、标题、章节路径）
- 向量化（本地 Embedding）+ `pgvector` 存储
- 在线检索增强生成（RAG）：召回 +（可选）重排 + 上下文拼接 + 引用输出
- OpenAI 兼容对话接口（支持 SSE 流式输出）
- 基础可观测：请求/检索命中/引用/耗时日志；用户反馈接口

**后续扩展（非 MVP）：**
- Hybrid 检索（BM25 + 向量）、更强 rerank、语义缓存、权限/配额、管理后台、离线评测与自动回归

---

## 1. 目标与成功指标（KPI）

### 1.1 业务目标
- 为 OneKey 开发者提供“可引用”的文档问答体验，降低文档检索成本与支持工单量。

### 1.2 体验目标（对标 Inkeep）
- 答案结构清晰、步骤化、带代码示例（如文档存在）
- 末尾提供来源链接列表（可点击），必要时对齐到章节
- 支持多轮对话（会话内理解上下文）

### 1.3 建议指标（可运营）
- 引用覆盖率：≥ 95% 的回答至少包含 1 条来源 URL
- 引用相关性（抽检）：≥ 85% 引用与问题强相关
- 首轮解决率：≥ 60%（按用户反馈与对话终止统计）
- 延迟：P50 < 2.5s（不含外部模型），P95 < 6s（含外部模型）
- 增量更新时效：站点变更后 30min 内完成增量抓取与入库（随规模调整）

---

## 2. 用户与场景

### 2.1 目标用户
- OneKey SDK/插件/接口调用的外部开发者
- OneKey 内部支持/运营/研发（用于快速定位依据）

### 2.2 典型问题
- “如何在 React 项目里集成 OneKey xxx？”
- “这个 API 的参数/返回值是什么？有没有示例？”
- “某个错误码/报错怎么排查？”
- “有没有最佳实践/注意事项？”

---

## 3. 系统架构（分层）

### 3.1 逻辑分层
1. **采集层（Crawler）**：发现 URL、抓取 HTML、失败重试、增量策略
2. **抽取层（Extractor）**：正文清洗、代码块保留、标题层级解析、结构化输出
3. **索引层（Indexing）**：chunking、embedding、本地存储、向量索引、版本管理（可选）
4. **检索层（Retrieval）**：向量召回、过滤、去重、可选重排
5. **生成层（Generation）**：上下文构建、ChatModel 调用、答案格式化与引用组装
6. **服务层（API）**：OpenAI 兼容接口、管理接口、反馈接口、可观测与审计

### 3.2 组件建议（MVP）
- `rag-api`：FastAPI（SSE）+ LangChain v1.1.0
- `postgres`：PostgreSQL + `pgvector`
- （可选）`redis`：队列/缓存（若引入 Celery/RQ）
- （可选）`worker`：执行 crawl/index 异步任务

---

## 4. 数据流与链路（端到端）

### 4.1 离线链路：抓取 → 清洗 → 入库 → 建索引
1. Scheduler 触发（定时/手动）
2. URL 发现：
   - 优先读取 `sitemap.xml`（若存在）
   - 站内链接发现（限定域名 `developer.onekey.so`；可配置 include/exclude 规则）
3. 抓取 HTML（带速率限制、重试、断点续爬）
4. 抽取正文与结构（标题层级 h1-h3、代码块、正文）
5. 分块（chunking）+ 生成 chunk 元数据
6. Embedding（本地）生成向量
7. 写入 Postgres：
   - 文档页表（page）
   - chunk 表
   - 向量列（pgvector）
8. （可选）索引版本号/批次号（便于回滚与统计）

### 4.2 在线链路：Query → 检索 →（重排）→ 生成 → 引用输出
1. API 接收 `messages`（含历史）
2. Query 预处理（可选）：
   - 多轮压缩/问题改写（将会话上下文折叠成单轮 query）
   - 关键词提取（用于日志与运营）
3. Retriever：向量召回 topK（如 30）
4. （可选）Reranker：对 topK 重排，选 topN（如 8）
5. Context Builder：
   - 以 `section_path`/URL 分组去重
   - 控制 token 预算（避免上下文过长挤压回答）
6. ChatModel：调用外部 API（可插拔）生成回答
7. Citation Assembler：
   - 从 topN 中选择引用（覆盖答案要点）
   - 输出 `sources[]`（URL、标题、章节、snippet）
8. 返回：
   - 非流式：一次性返回 `answer` + `sources`
   - 流式：SSE 输出 delta，结束事件附带 `sources`

---

## 5. 功能需求（详细）

### 5.1 采集层（Crawler）

#### 5.1.1 URL 发现与范围控制
- 仅允许抓取：
  - `https://developer.onekey.so/**`
- 支持配置：
  - `seed_urls[]`
  - `sitemap_url`
  - `include_patterns[]`（正则或 glob）
  - `exclude_patterns[]`
  - `max_pages`

#### 5.1.2 抓取策略
- 速率限制（避免对 GitHub Pages 造成压力）
- 重试策略：指数退避 + 最大重试次数
- 失败记录：失败 URL、HTTP 状态、错误原因、最后一次重试时间
- 增量抓取策略（推荐顺序）：
  1) HTTP `ETag` / `Last-Modified`（若可用）
  2) 内容哈希（对抽取后的主内容计算 `content_hash`）

#### 5.1.3 抽取与清洗要求
- 输出需保留：
  - `url`（引用返回必须用）
  - `title`
  - `section hierarchy`（h1/h2/h3 路径）
  - `code blocks`（保留语言/格式）
  - `plain text`（去掉导航、页脚、无关链接区）
- 建议输出格式：Markdown（便于 chunking 与显示 snippet）

---

### 5.2 索引构建层（Indexing）

#### 5.2.1 Chunking 规则
- 结构优先：按标题层级切分（h1/h2/h3）
- 长度控制：每块目标 400–900 tokens
- overlap：50–120 tokens（避免断章）
- 代码块与说明尽量同块（避免“只检索到代码无解释/只检索到解释无代码”）

#### 5.2.2 Embedding（本地）
- 要求：
  - 可离线运行
  - 可批处理（提升索引效率）
  - 维度固定、与向量库匹配
- 备注：Embedding 模型可配置替换，避免锁死单一模型。

#### 5.2.3 向量存储：pgvector（优先）
- 使用 Postgres + `pgvector` 存储向量并执行相似度检索
- 支持按字段过滤（如将来加入 `locale`、`product` 等）

---

### 5.3 在线问答层（RAG Chat）

#### 5.3.1 召回与引用
- 向量召回 topK（如 30），最终使用 topN（如 8）作为上下文
- 返回 sources：
  - 至少 1 条 URL（除非明确无命中并提示原因）
  - 建议 3–8 条，避免堆砌

#### 5.3.2 答案输出规范（建议）
- 建议结构：
  - 结论/摘要（1–3 句）
  - 操作步骤（分点）
  - 代码示例（如有）
  - 注意事项/常见坑（如有）
  - 来源（sources）

#### 5.3.3 失败兜底
- 检索命中不足：
  - 明确提示“文档中未检索到直接相关内容”
  - 给出 1–3 个可能相关的入口 URL（基于近似命中或站点导航页）
- 模型调用失败：
  - 返回标准化错误码
  - 支持重试（建议前端退避）

---

### 5.4 可观测与运营闭环
- 每次请求记录：
  - query、retrieved chunk_ids、scores、最终 sources URLs
  - 模型耗时、token（如可获取）、总耗时
- 反馈：
  - thumbs up/down + 原因（引用不相关/过时/不完整/表达差等）
- 运营报表（可选）：
  - 高频 query
  - 高频无命中
  - 高频差评来源 URL（定位文档问题）

---

## 6. API 规范（OpenAI 兼容 + 管理接口）

> 说明：对外主接口对齐 OpenAI Chat Completions，便于复用现有前端/网关；内部管理接口可独立命名空间 `/_admin/*` 或 `/admin/*`。

### 6.1 统一约定
- `Content-Type: application/json`
- 统一返回字段：
  - 成功：HTTP 200
  - 失败：HTTP 4xx/5xx + `{ error: { code, message, details? } }`
- `sources` 为本服务扩展字段（OpenAI 标准未定义），建议放在：
  - 非流式：顶层字段 `sources`
  - 流式：在结束事件（`[DONE]` 之前或替代）带上 `sources`

---

### 6.2 健康检查
#### `GET /healthz`
- 响应（示例）：
```json
{
  "status": "ok",
  "dependencies": {
    "postgres": "ok",
    "pgvector": "ok"
  }
}
```

---

### 6.3 文档抓取（管理接口）
#### `POST /admin/crawl`
- 用途：创建抓取任务（全量/增量）
- 请求体：
```json
{
  "mode": "full",
  "sitemap_url": "https://developer.onekey.so/sitemap.xml",
  "seed_urls": ["https://developer.onekey.so/"],
  "include_patterns": ["^https://developer\\.onekey\\.so/.*$"],
  "exclude_patterns": ["^https://developer\\.onekey\\.so/404.*$"],
  "max_pages": 5000
}
```
- 响应：
```json
{ "job_id": "crawl_2025-12-14_000001" }
```

#### `GET /admin/crawl/{job_id}`
- 响应（示例）：
```json
{
  "job_id": "crawl_2025-12-14_000001",
  "status": "running",
  "progress": { "discovered": 1200, "fetched": 800, "succeeded": 760, "failed": 40 },
  "started_at": "2025-12-14T05:00:00Z",
  "updated_at": "2025-12-14T05:10:00Z"
}
```

---

### 6.4 建索引（管理接口）
#### `POST /admin/index`
- 用途：对已抓取的页面执行抽取/分块/embedding/入库
- 请求体：
```json
{ "mode": "incremental" }
```
- 响应：
```json
{ "job_id": "index_2025-12-14_000001" }
```

#### `GET /admin/index/{job_id}`
- 响应（示例）：
```json
{
  "job_id": "index_2025-12-14_000001",
  "status": "succeeded",
  "progress": { "pages": 760, "chunks": 8200, "embedded": 8200, "upserted": 8200 },
  "started_at": "2025-12-14T05:11:00Z",
  "finished_at": "2025-12-14T05:18:00Z"
}
```

---

### 6.5 对话（对外核心，OpenAI 兼容）

#### `POST /v1/chat/completions`
- 用途：对话问答（支持流式）
- 请求体（最小示例）：
```json
{
  "model": "onekey-docs",
  "messages": [
    { "role": "system", "content": "你是 OneKey 开发者文档助手，回答必须给出来源链接。" },
    { "role": "user", "content": "如何在 Next.js 里集成 OneKey 登录？" }
  ],
  "stream": false
}
```

##### 非流式响应（建议结构）
```json
{
  "id": "chatcmpl_xxx",
  "object": "chat.completion",
  "created": 1734150000,
  "model": "onekey-docs",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "（回答正文）"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 },
  "sources": [
    {
      "url": "https://developer.onekey.so/xxx",
      "title": "（页面标题）",
      "section_path": "Getting Started > Auth",
      "snippet": "（与回答强相关的原文片段，建议 200-400 字）"
    }
  ]
}
```

##### 流式响应（SSE）约定（建议）
- `Content-Type: text/event-stream`
- 分片格式参考 OpenAI：
  - `data: { ...delta... }\n\n`
  - 结束使用 `data: [DONE]\n\n`
- 约定：在结束前追加一个事件，携带 `sources`（扩展字段）
```text
data: {"id":"chatcmpl_xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"第一段"},"finish_reason":null}]}

data: {"id":"chatcmpl_xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"第二段"},"finish_reason":null}]}

data: {"id":"chatcmpl_xxx","object":"chat.completion.sources","sources":[{"url":"https://developer.onekey.so/xxx","title":"...","section_path":"...","snippet":"..."}]}

data: [DONE]
```

#### 推荐扩展入参（可选）
- `temperature`、`top_p`、`max_tokens`：透传给 ChatModel
- `metadata`：用于 trace（如 `conversation_id`）
- `debug`：返回检索命中与分数（仅内部或受控开启）

---

### 6.6 反馈（对外/内部皆可）
#### `POST /v1/feedback`
- 请求体：
```json
{
  "conversation_id": "conv_xxx",
  "message_id": "msg_xxx",
  "rating": "down",
  "reason": "sources_irrelevant",
  "comment": "引用的页面不是我想要的 SDK。",
  "sources": ["https://developer.onekey.so/xxx"]
}
```
- 响应：
```json
{ "status": "ok" }
```

---

## 7. 数据模型（建议表结构）

> 说明：以下为建议字段，实际可根据实现微调；MVP 可先用最小字段集。

### 7.1 `pages`（文档页面）
- `id`：UUID / bigserial
- `url`：text UNIQUE（引用必须）
- `title`：text
- `content_markdown`：text（清洗后内容）
- `content_hash`：text（用于增量）
- `http_status`：int
- `last_crawled_at`：timestamptz
- `meta`：jsonb（可选：面包屑、站点分类等）

### 7.2 `chunks`（分块）
- `id`：UUID / bigserial
- `page_id`：FK -> pages.id
- `chunk_index`：int（页内顺序）
- `section_path`：text（如 `A > B > C`）
- `chunk_text`：text
- `chunk_hash`：text
- `token_count`：int（可选）

### 7.3 `chunk_embeddings`（向量）
- `chunk_id`：FK UNIQUE -> chunks.id
- `embedding`：vector(n)（pgvector）
- `embedding_model`：text（便于迁移/重建）
- 索引：`ivfflat` 或 `hnsw`（按 pgvector 支持版本与规模选择）

### 7.4 `jobs`（任务）
- `id`：text（如 `crawl_...`）
- `type`：text（crawl/index）
- `status`：text（pending/running/succeeded/failed）
- `payload`：jsonb（入参）
- `progress`：jsonb（计数器）
- `error`：text（可选）
- `started_at` / `finished_at`：timestamptz

### 7.5 `feedback`（用户反馈）
- `id`：UUID
- `conversation_id`：text
- `message_id`：text
- `rating`：text（up/down）
- `reason`：text
- `comment`：text
- `sources`：jsonb
- `created_at`：timestamptz

---

## 8. 模型与算法选型（可插拔）

### 8.1 Embedding（本地优先）
- 要求：离线可用、批处理、效果稳定
- 建议：优先选择通用多语种/代码友好 embedding（具体型号在实现阶段落定并可配置）

### 8.2 Rerank（可选但建议）
- 作用：显著提升引用相关性（对标 Inkeep 关键项之一）
- MVP 可先不做，或作为可开关能力引入（以便先跑通链路）

### 8.3 ChatModel（可外部 API）
- 关键要求：统一适配层（provider 可替换）、可观测、失败降级
- 备注：后续可切本地 LLM（取决于成本与性能）

---

## 9. 本地部署方案（Docker Compose 建议）

### 9.1 MVP 目标
- 一条命令启动：API + Postgres(pgvector)
- 索引任务可先同步执行；规模上来后再拆 worker/queue

### 9.2 环境变量建议
- `DATABASE_URL`：Postgres 连接串
- `EMBEDDING_MODEL`：embedding 模型名/路径
- `CHAT_PROVIDER`：openai/anthropic/xxx
- `CHAT_API_KEY`：外部模型 key（如使用外部）
- `CRAWL_RATE_LIMIT`：抓取速率

---

## 10. 风险与对策

1) **引用不准/答非所问**
- 对策：结构化 chunking +（可选）rerank + 上下文预算控制 + 强制 sources 输出

2) **站点结构变化导致爬虫漏抓**
- 对策：sitemap 优先；发现策略可配置；失败队列与告警

3) **静态站点的导航/模板内容污染检索**
- 对策：Extractor 需要强清洗（仅保留 main content）；对重复模板片段做去重/过滤

4) **外部 ChatModel 不稳定**
- 对策：重试/熔断；降级到“仅返回检索结果与链接”的模式（最小可用）

---

## 11. MVP 里程碑（建议）
1. 跑通离线链路：爬取 → 抽取 → chunk → embedding → pgvector 入库
2. 跑通在线链路：检索 → 生成 → 返回 sources（非流式）
3. 增加 SSE 流式输出
4. 增量抓取与增量索引
5. 引入 rerank（提升引用质量）
6. 反馈闭环与基础报表

