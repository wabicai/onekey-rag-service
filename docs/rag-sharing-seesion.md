> 本文基于 `docs/onekey-rag-share.md` 与仓库当前实现，整理一份“RAG 知识库”分享稿。  
> 目标：让你能在 10 分钟内讲清楚 —— 知识库是什么、能解决什么问题、以及本项目后端是怎么把它跑起来的。

# 什么是知识库？

“知识库”不是某一个产品名，也不是“把文档丢进 ChatGPT”这么简单。更准确的定义是：

> **知识库 = 可持续更新的数据集合 + 可检索的索引结构 + 面向业务的访问方式（接口/权限/可观测）**

在 RAG 场景下，知识库的核心价值是两点：**可追溯**与**可运营**。

## 1) 知识库 ≠ 大模型参数（为什么需要 RAG）

- **大模型参数**像“读过很多书的能力”，擅长推理与表达，但不擅长保证“某条事实一定来自你指定的文档”。
- **知识库**更像“随时可查的资料库”，重点是更新快、可控、可追溯。

因此，如果你的目标是“围绕官方文档/FAQ/制度条款回答，并且必须给出来源链接”，最通用的工程化路径就是 **RAG（Retrieval-Augmented Generation）**：

1. 先从知识库里 **检索** 出与问题最相关的片段（chunks）
2. 再把这些片段作为上下文交给模型 **生成** 回答
3. 最后把引用信息（URL/snippet/章节）一起返回，便于复核

## 2) 本项目里“知识库”长什么样

以本仓库 `onekey-rag-service` 为例（核心代码在 `src/onekey_rag_service/`），知识库不是单表，而是一组实体/表的组合：

| 概念 | 对应表 | 作用 |
| --- | --- | --- |
| 工作区（Workspace） | `workspaces` | 隔离不同项目/租户的数据与配置边界 |
| 知识库（KB） | `knowledge_bases` | 一组可检索的内容集合（可以有多个 KB） |
| 数据源（Source） | `data_sources` | 描述“怎么抓取/导入内容”（base_url/sitemap/规则等） |
| 文档页（Page） | `pages` | 存储抓取/导入后的“页面级内容”（Markdown、hash、状态码） |
| 文档块（Chunk） | `chunks` | 存储可检索的最小片段（section_path/text/embedding） |
| 应用（RagApp） | `rag_apps` | 对外暴露的“模型入口”（OpenAI Compatible 的 `model`） |
| 应用绑定 KB | `app_kbs` | 一个 App 可绑定多个 KB，并设置权重/优先级 |
| 任务队列（Job） | `jobs` | 抓取/索引任务的持久化队列（可由 Worker 消费） |

你可以把它理解为：

```text
数据源(DataSource)
  └─(crawl)→ pages（page 级原文/Markdown）
             └─(index)→ chunks（chunk 级片段 + embedding）
                         └─(retrieve)→ 作为上下文喂给 ChatModel 生成答案
```

## 3) 三个关键设计：可更新、可追溯、可扩展

### 可更新：增量抓取 + 增量索引
- 抓取阶段在 `src/onekey_rag_service/crawler/pipeline.py` 会对正文生成 `content_hash`，增量模式下 hash 不变则跳过重写。
- 索引阶段在 `src/onekey_rag_service/indexing/pipeline.py` 对比 `indexed_content_hash`，只对“内容变更”的页面重建 chunks/embedding。

### 可追溯：回答必须带引用
- RAG 组装上下文时为每个 chunk 编号（如 `[1]`），并在答案里输出 inline citations（`INLINE_CITATIONS_ENABLED`）。
- 返回的 `sources[]` 会包含 `ref/url/title/section_path/snippet`，前端可以直接渲染成“可点击的来源卡片”。
- 为避免“模型瞎编引用编号”，服务端会清洗越界引用（见 `src/onekey_rag_service/rag/pipeline.py`）。

### 可扩展：检索/模型/任务都是可插拔的
- 检索支持 `vector` / `hybrid`（BM25/FTS + 向量），实现位于 `src/onekey_rag_service/rag/pgvector_store.py`。
- Embedding 支持 `fake/sentence_transformers/ollama/openai_compatible`（`src/onekey_rag_service/rag/embeddings.py`）。
- 抓取/索引可走进程内 BackgroundTasks，也可走持久化队列 + 独立 Worker（`JOBS_BACKEND`）。

# 实用场景举例

下面用 4 个“能立刻落地”的场景来讲知识库的用法。每个场景都可以用同一套后端能力拼出来：**采集 → 索引 → 检索问答/生成**。

## 客服中心/文档对话

**目标**：把“搜索框 + FAQ”升级成“对话式自助客服”，并强制引用官方资料，减少幻觉与扯皮。

**知识来源**：
- 官方文档站（sitemap + 站内链接发现）
- FAQ/公告/条款（可作为独立 KB，便于单独更新与运营）

**推荐产品形态**（本仓库已实现同域 Widget）：
- 文档站引入一行 script：`/widget/widget.js` 自动注入右下角入口
- iframe 内同域调用 `/v1/chat/completions`，避免 CORS 复杂度

**关键配置建议**：
- 强制引用：`INLINE_CITATIONS_ENABLED=true`
- 控制引用数量：`RAG_MAX_SOURCES=3`（默认）
- 检索默认用 `hybrid`（术语/错误码/代码片段召回更稳）：`RETRIEVAL_MODE=hybrid`

## 新闻抓取，每日推送（尽量减少幻觉）

**目标**：每天自动抓取你关注的站点/公告，生成“可复核”的日报/周报。

**落地链路（最小闭环）**：
1. 新建一个 KB（例如 `news`），配置一个 Source：seed_urls/sitemap/include/exclude
2. 定时触发：
   - `POST /admin/api/workspaces/{workspace_id}/jobs/crawl`（建议 `mode=incremental`）
   - `POST /admin/api/workspaces/{workspace_id}/jobs/index`
3. 生成日报：调用 `/v1/chat/completions`，在 system prompt 中要求“只基于 sources 内容总结，并在每条要点后标注引用编号”

**“避免幻觉”的工程技巧**：
- 让模型“不能凭空发挥”：提示词里明确 **不得使用来源以外的信息**，否则输出“不确定”
- 让结果“可审计”：开启 inline citations，并在 UI 中展示 `sources.snippet`
- 让召回“更稳”：新闻标题/人名/机构名偏关键词，`hybrid` 通常比纯向量更稳

> 可选扩展（需要少量改造）：如果你希望按日期/栏目过滤，可把发布时间写入 `pages.meta`，并在检索 SQL 中增加 meta 条件过滤。

## 智能合约解析（避免盲签）

**目标**：当用户面对一笔“看不懂的签名/交易”时，给出“这笔交易在调用什么、可能意味着什么”的解释，并提供依据。

**知识来源**（建议拆成多个 KB）：
- 合约 ABI / 接口说明 / SDK 文档
- 审计报告、已知漏洞库、最佳实践
- 业务方的合约说明与风险提示

**推荐做法**：
- 交易解析本身（decode calldata、识别函数签名）通常要依赖链上数据/ABI，不建议完全交给 LLM；更稳的是：
  1) 先用确定性的 decoder 把交易结构化（method/params/to/value）
  2) 再把结构化结果 + 合约/协议文档喂给 RAG，生成“解释 + 风险点 + 引用”

**风险边界**：
- RAG 能显著降低“编造事实”，但无法保证“绝对安全”；产出应定位为**解释与提示**，不应替代安全审计。

## 作为教育知识平台的后台服务

**目标**：把课程/题库/讲义/FAQ 做成可检索的学习助手，同时支持多产品线与多组织隔离。

**映射到本项目的结构**：
- 一个组织/产品线一个 Workspace（或在当前单 Workspace 下按 KB 划分）
- 课程/学科一个 KB（便于独立更新、独立评测）
- 面向不同入口（App/小程序/官网）创建不同 RagApp，并按权重绑定多个 KB（例如“通用 FAQ” + “课程内容”）

**运营与迭代建议**：
- 用 `debug=true` 做“命中分析”：哪些问题召回为空？哪些引用不相关？
- 用 `feedback` 做闭环：把用户差评的对话与 sources 回收，反向改进文档与分块策略

# 本地搭建的成本、配置

本项目的本地部署目标是“尽量少的依赖 + 可复现 + 可运维”。默认用 Docker Compose 起三件套：`postgres(pgvector)` + `api` + `worker`。

## 1) 成本拆分：你主要在为哪三件事付费

1. **存储成本**：`pages` 原文 + `chunks` 片段 + 向量（`vector(n)`）。  
2. **计算成本（离线）**：抓取解析、chunking、embedding、（可选）rerank 模型下载与推理。  
3. **计算成本（在线）**：每次对话的检索（pgvector/FTS）+ 上游 ChatModel token（如果用外部模型）。

> 一个实用的估算方法：  
> `chunks 数 ≈ pages 数 × 平均每页 chunk 数`；向量体积近似 `chunks × dim × 4 bytes`（float32），再加上文本与索引开销。

## 2) 三档推荐配置（按“成本/效果/复杂度”取舍）

### A. 演示/开发档（先跑通链路）
- `EMBEDDINGS_PROVIDER=fake`
- `RERANK_PROVIDER=none`
- 适合：本地无模型/无网络时验证接口与流程  
- 风险：检索相关性很弱，不适合真实用户

### B. 标准档（性价比：本地 embedding + 可追溯引用）
- `EMBEDDINGS_PROVIDER=sentence_transformers`
- `SENTENCE_TRANSFORMERS_MODEL=sentence-transformers/paraphrase-multilingual-mpnet-base-v2`
- `RERANK_PROVIDER=bge_reranker`（CPU 可用，但会更吃资源）
- 适合：大多数“文档对话/客服”场景

### C. 生产档（可运维：队列 + 预下载模型 + 调优）
- `JOBS_BACKEND=worker`（推荐：抓取/索引与 API 解耦）
- 预下载/挂载模型文件，避免容器启动时在线拉取（见 `.env.example` 注释）
- 调优索引与超时：`PGVECTOR_INDEX_TYPE`、`RAG_*_TIMEOUT_S`、`MAX_CONCURRENT_CHAT_REQUESTS`

## 3) 本地启动步骤（Docker Compose）

1. 准备环境变量：
   - `cp .env.example .env`
   - 填写 `.env` 的 `CHAT_API_KEY`、`ADMIN_PASSWORD`、`ADMIN_JWT_SECRET`
2. 启动：
   - `docker compose up -d --build`
3. 初始化数据（抓取 + 索引）：
   - `POST /admin/api/auth/login` 拿 JWT
   - `POST /admin/api/workspaces/default/jobs/crawl`
   - `POST /admin/api/workspaces/default/jobs/index`
4. 体验对话：
   - `POST /v1/chat/completions`（OpenAI Compatible）
5. 验证 Widget/Admin：
   - Widget：`GET /widget/widget.js`（iframe 页面：`GET /widget/`）
   - Admin UI：`/admin/ui/#/login`

# 后端服务实现流程

这一节用“端到端链路”的方式，把代码结构与关键流程串起来，便于你读代码、做定制、或排障。

## 1) 项目结构速览（按职责分层）

- API 入口：`src/onekey_rag_service/api/app.py`（OpenAI 接口 + 静态资源挂载 + 启动初始化）
- Admin API：`src/onekey_rag_service/api/admin.py`（工作区/KB/App/Source/Job 管理）
- 任务 Worker：`src/onekey_rag_service/worker.py`（消费 `jobs` 表，执行 crawl/index）
- 抓取：`src/onekey_rag_service/crawler/*`
- 索引：`src/onekey_rag_service/indexing/*`
- RAG：`src/onekey_rag_service/rag/*`
- DB 初始化/索引：`src/onekey_rag_service/db.py`
- 数据模型：`src/onekey_rag_service/models.py`
- 配置：`src/onekey_rag_service/config.py`（全部环境变量入口）

## 2) 离线链路：抓取 → 抽取 → 入库（pages）

触发方式：
- 管理后台触发：`POST /admin/api/workspaces/{workspace_id}/jobs/crawl`
- 执行位置：Worker（`JOBS_BACKEND=worker`）或进程内（`background`）

核心流程（对应 `src/onekey_rag_service/crawler/pipeline.py`）：
1. URL 发现：优先读 sitemap，失败则降级为 seed_urls；并做同域校验与 include/exclude 过滤
2. 抓取 HTML：重试（tenacity 指数退避），过滤常见静态资源
3. 内容抽取：`extract_readable` 把 HTML 提取为“标题 + 近似 Markdown 正文”
4. 入库：写 `pages`，并计算 `content_hash`；增量模式下 hash 未变则只 touch 时间戳

## 3) 离线链路：分块 → Embedding → 入库（chunks）

触发方式：
- `POST /admin/api/workspaces/{workspace_id}/jobs/index`
- 执行位置：Worker 或进程内

核心流程（对应 `src/onekey_rag_service/indexing/pipeline.py`）：
1. 找到所有可索引页面（`http_status < 400`）
2. 增量跳过：`indexed_content_hash == content_hash` 则略过
3. 分块：`chunk_markdown_by_headers`（按 h1/h2/h3，再按长度切分；支持 overlap）
4. 向量化：由 `src/onekey_rag_service/rag/embeddings.py` 提供 embedding（可缓存 query embedding）
5. 写入 `chunks`：包括 `section_path/chunk_text/embedding/token_count/chunk_hash`
6. 启动时自动建索引：pgvector（HNSW/IVFFLAT）+ FTS(GIN)（见 `src/onekey_rag_service/db.py`）

## 4) 在线链路：问答 RAG（OpenAI Compatible）

入口：`POST /v1/chat/completions`（实现位于 `src/onekey_rag_service/api/app.py`）

核心流程（对应 `src/onekey_rag_service/rag/pipeline.py`）：
1. 选择模型/应用：
   - `req.model` 命中 `RagApp.public_model_id` 时，按 App 绑定的 KB 权重分配 top_k（`src/onekey_rag_service/rag/kb_allocation.py`）
   - 否则按 `CHAT_MODEL_MAP_JSON` 或 `CHAT_MODEL_PASSTHROUGH` 决定上游模型名
2. 会话增强（可选）：
   - Query Rewrite：把多轮追问改写为“更适合检索的 query”
   - Memory Summary：把历史压缩成摘要供回答使用  
   见 `src/onekey_rag_service/rag/conversation.py`
3. 检索：
   - `vector`：纯向量检索（pgvector cosine）
   - `hybrid`：向量 + FTS 排序归一化加权  
   见 `src/onekey_rag_service/rag/pgvector_store.py`
4. 重排（可选）：`bge-reranker` 对候选进行 cross-encoder 重排（`src/onekey_rag_service/rag/reranker.py`）
5. 上下文组装：控制 `RAG_CONTEXT_MAX_CHARS`，并生成 `sources[]`
6. 生成与返回：
   - 非流式：一次性返回 content + sources
   - 流式：SSE 输出 `chat.completion.chunk`，结束前追加 `chat.completion.sources`，最后 `[DONE]`

## 5) 运维与排障：你应该先看什么

- 依赖健康：`GET /healthz` 与 `GET /admin/api/workspaces/{workspace_id}/health`
- 任务队列：`GET /admin/api/workspaces/{workspace_id}/jobs/*`（排查 crawl/index 卡住/失败）
- “为什么回答不准”：优先开启 `debug=true` 看召回与重排；再调 `chunk`/`hybrid`/`rerank`
- “为什么引用对不上”：检查 `INLINE_CITATIONS_ENABLED` 与 `RAG_MAX_SOURCES`，以及模型输出是否被清洗

> 延伸阅读：  
> - 架构/参数/风险与演进：`docs/onekey-rag-share.md`  
> - 更完整的 MVP 规格：`docs/onekey-rag-service-spec.md`
