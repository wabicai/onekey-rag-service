# OneKey RAG Service

本仓库用于构建 OneKey 开发者文档的 RAG（Retrieval-Augmented Generation）对话服务，目标对标 Inkeep 的“文档对话 + 可追溯引用”体验。

- 需求与技术方案文档：`docs/onekey-rag-service-spec.md`
- 前端接入需求与开发规格：`docs/onekey-rag-frontend-spec.md`

## 快速开始（本地 Docker）

1. 准备环境变量：
   - `cp .env.example .env`
   - 填写 `.env` 中的 `CHAT_API_KEY`（上游 OpenAI 兼容模型的 Key）
   - 如使用 DeepSeek：配置 `CHAT_BASE_URL`、`CHAT_MODEL`，并保持 `CHAT_MODEL_PROVIDER=openai`
   - 推荐 Embedding（无需 Ollama）：
     - `EMBEDDINGS_PROVIDER=sentence_transformers`
     - `SENTENCE_TRANSFORMERS_MODEL=sentence-transformers/paraphrase-multilingual-mpnet-base-v2`
     - `PGVECTOR_EMBEDDING_DIM=768`

2. 启动服务：
   - `docker compose up -d --build`
   - API 默认地址：`http://localhost:8000`
   - 健康检查：`GET http://localhost:8000/healthz`
   - 后台任务：默认启用 `worker`（见 `JOBS_BACKEND`），抓取/索引会入队由 Worker 消费

3. 初始化数据：抓取 + 建索引（首次建议 `full`，后续可用 `incremental`）
   - 先用 Admin 账号登录拿 JWT（账号密码来自 `.env` 的 `ADMIN_USERNAME/ADMIN_PASSWORD`）：
     - `POST http://localhost:8000/admin/api/auth/login`
   - 触发抓取（默认工作区/默认 KB/默认数据源分别为 `default`/`default`/`source_default`）：
     - `POST http://localhost:8000/admin/api/workspaces/default/jobs/crawl`
     - 示例（全站建议把 `max_pages` 调大，例如 5000 或更高；也可直接改 `.env` 的 `CRAWL_*`）：
       ```bash
       # 1) 登录拿 token（把响应里的 access_token 复制出来）
       curl -s http://localhost:8000/admin/api/auth/login \
         -H 'content-type: application/json' \
         -d '{"username":"admin","password":"<你的 ADMIN_PASSWORD>"}'

       # 2) 触发 crawl（把 <token> 替换为上一步的 access_token）
       curl -s http://localhost:8000/admin/api/workspaces/default/jobs/crawl \
         -H 'content-type: application/json' \
         -H "Authorization: Bearer <token>" \
         -d '{"kb_id":"default","source_id":"source_default","mode":"full","sitemap_url":"https://developer.onekey.so/sitemap.xml","seed_urls":["https://developer.onekey.so/"],"max_pages":5000}'
       ```
   - 触发建索引（chunk + embedding + pgvector 入库）：
     - `POST http://localhost:8000/admin/api/workspaces/default/jobs/index`
     - 示例：
       ```bash
       curl -s http://localhost:8000/admin/api/workspaces/default/jobs/index \
         -H 'content-type: application/json' \
         -H "Authorization: Bearer <token>" \
         -d '{"kb_id":"default","mode":"full"}'
       ```
   - 轮询任务状态（crawl/index 共用）：
     - `GET http://localhost:8000/admin/api/workspaces/default/jobs/<job_id>`
   - 说明：当 `JOBS_BACKEND=worker` 时，任务会先进入 `queued`，随后由 Worker 拉起为 `running` 并最终 `succeeded/failed`

4. 对话（OpenAI 兼容）：
   - `POST http://localhost:8000/v1/chat/completions`
   - 非流式示例：
     ```bash
     curl -s http://localhost:8000/v1/chat/completions \
       -H 'content-type: application/json' \
       -d '{"model":"onekey-docs","messages":[{"role":"user","content":"如何在项目里集成 OneKey Connect？"}],"stream":false}'
     ```
   - 流式（SSE）示例（会在结束前追加 `chat.completion.sources` 事件，最后 `data: [DONE]`）：
     ```bash
     curl -N http://localhost:8000/v1/chat/completions \
       -H 'content-type: application/json' \
       -d '{"model":"onekey-docs","messages":[{"role":"user","content":"WebUSB 权限需要注意什么？"}],"stream":true}'
     ```

5. 常用接口一览：
   - 模型列表：`GET http://localhost:8000/v1/models`
   - 反馈：`POST http://localhost:8000/v1/feedback`
   - 健康检查：`GET http://localhost:8000/healthz`
   - 前端 Widget（用于“一行 script”接入）：`GET http://localhost:8000/widget/widget.js`（iframe 页面为 `GET http://localhost:8000/widget/`）
   - 后台 Admin UI：`http://localhost:8000/admin/ui/#/login`（使用 JWT 登录，接口为 `/admin/api/*`）

## 后台管理（Admin）

本仓库内置一个轻量后台（面向企业化演进，多 RagApp/多 KB）：

- Admin UI：`/admin/ui/#/login`
- Admin API：`/admin/api/*`（Bearer JWT）

配置（见 `.env.example`）：

- `ADMIN_USERNAME`、`ADMIN_PASSWORD`
- `ADMIN_JWT_SECRET`、`ADMIN_JWT_EXPIRES_S`

## 前端 Widget（一行 script 接入）

本服务会同域提供：
- Loader 脚本：`/widget/widget.js`
- iframe 页面：`/widget/`

在 `https://developer.onekey.so/` 的站点代码中加入（示例）：
```html
<script
  src="https://你的-rag-域名/widget/widget.js"
  data-model="onekey-docs"
></script>
```

本地快速测试（模拟文档站引入一行 script）：
- 启动本地静态页：`python -m http.server 9000 --bind 127.0.0.1 --directory examples`
- 打开测试页：`http://127.0.0.1:9000/widget-host.html`

生产建议在 `.env` 配置 `WIDGET_FRAME_ANCESTORS` 限制可嵌入来源，例如：
- `WIDGET_FRAME_ANCESTORS="'self' https://developer.onekey.so"`（建议用双引号包住，内部保留 `'self'`）

## 配置说明（MVP）

- 向量库：`pgvector`（Postgres 容器：`pgvector/pgvector:pg16`）
- 对外接口：OpenAI 兼容（`/v1/chat/completions`），额外返回 `sources`
- Embedding：
  - 默认：`EMBEDDINGS_PROVIDER=fake`（仅用于链路跑通，不适合生产检索效果）
  - 推荐（本地 CPU，无需 Ollama）：`EMBEDDINGS_PROVIDER=sentence_transformers` 并配置 `SENTENCE_TRANSFORMERS_MODEL`
  - 可选（本地 Ollama）：`EMBEDDINGS_PROVIDER=ollama` 并配置 `OLLAMA_BASE_URL`、`OLLAMA_EMBEDDING_MODEL`

### 生成参数（默认值来自 env）

当客户端请求未显式传入时，服务会使用：
- `CHAT_DEFAULT_TEMPERATURE`
- `CHAT_DEFAULT_TOP_P`
- `CHAT_DEFAULT_MAX_TOKENS`

### 多 ChatModel（可选）

本服务通过 LangChain `init_chat_model` 初始化 ChatModel，并使用 OpenAI provider 的 `base_url` 适配 OpenAI-Compatible（DeepSeek 也属于该类），因此：
- 仅切换单一上游模型：改 `.env` 的 `CHAT_BASE_URL` + `CHAT_MODEL` 即可
- 同时暴露多个 `model` 给客户端选择：配置 `CHAT_MODEL_MAP_JSON`（请求的 `model` -> 上游模型名）

### 多轮对话（Query rewrite / 记忆压缩）

服务会基于 `messages` 的多轮历史，自动：
- 改写出“用于检索的独立 query”（降低多轮追问导致的召回偏移）
- 生成对话摘要（压缩记忆），用于回答时补充上下文

相关配置：`QUERY_REWRITE_ENABLED`、`MEMORY_SUMMARY_ENABLED`、`CONVERSATION_*`

### Inline citation（更像 Inkeep）

- 默认开启 `INLINE_CITATIONS_ENABLED=true`：回答正文会生成类似 `[1][2]` 的引用编号，并在 `sources[]` 中返回对应 `ref/url/snippet`。
- 若你的客户端只展示 `content`，可设置 `ANSWER_APPEND_SOURCES=true` 在正文末尾追加“参考”列表。

### 检索策略（Hybrid 默认开启）

- 默认：`RETRIEVAL_MODE=hybrid`（BM25/FTS + 向量），对代码/术语/精确匹配的召回更稳
- 启动时自动建索引：`AUTO_CREATE_INDEXES=true`（可通过 `PGVECTOR_INDEX_TYPE` 选择 `hnsw/ivfflat/none`）

### 使用本地 sentence-transformers Embeddings（推荐）

前提：无（不需要运行 Ollama）。

推荐使用 `sentence-transformers` 在本地 CPU 上跑 embedding（首次会自动下载模型到 HuggingFace 缓存）。

- `.env` 建议：
  - `EMBEDDINGS_PROVIDER=sentence_transformers`
  - `SENTENCE_TRANSFORMERS_MODEL=sentence-transformers/paraphrase-multilingual-mpnet-base-v2`
  - `PGVECTOR_EMBEDDING_DIM=768`（需与你的 embedding 模型输出维度一致）

可选：如果你不希望容器内联网下载模型，把模型文件预下载后挂载到容器并设置 `SENTENCE_TRANSFORMERS_MODEL=/models/...`。

### 使用 bge-reranker 做重排（推荐）

对标 Inkeep 的引用质量，建议开启本地 cross-encoder 重排（bge-reranker）。

- `.env` 示例：
  - `RERANK_PROVIDER=bge_reranker`
  - `BGE_RERANKER_MODEL=BAAI/bge-reranker-large`
  - `RERANK_DEVICE=cpu`

## TODO（对标 Inkeep 的产品化差距）

- 持久化任务队列/Worker（已实现 MVP）：`jobs` 表持久化队列 + `worker` 容器消费 + 重试（attempts）+ 超时重入队；后续补齐：心跳/断点续跑的细粒度进度、定时调度、并发配额与优先级队列。
- 可观测与评测回归（进行中）：已支持 `debug=true` 返回检索信息与 `timings_ms`；后续补齐：结构化 trace/metrics、离线评测集与自动回归（答案/引用相关性）。
- 容量与并发治理（进行中）：已支持并发上限 `MAX_CONCURRENT_CHAT_REQUESTS`、RAG 超时 `RAG_*_TIMEOUT_S`、query embedding 缓存；后续补齐：限流、结果缓存、熔断/降级与慢查询保护。
- 抽取与引用对齐（进行中）：已支持 inline citation + sources(ref/url)；并尝试基于标题生成 anchor（`url#anchor`）；后续补齐：段落级定位/高亮、snippet 更准确、去重合并策略。
