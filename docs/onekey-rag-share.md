# OneKey RAG 服务分享稿

面向内部分享/对外介绍，涵盖当前实现、流程细节、参数与限制，并加入 Web3 行业的想象空间。

## 1. 项目全景
- 技术栈：FastAPI + LangChain(OpenAI 兼容)；SQLAlchemy + pgvector；前端 Vite/React Widget（同域 `/widget/*` 一行 script 接入）。
- 核心目录：API/任务 `onekey_rag_service/api/app.py`；爬取 `crawler/*`；索引 `indexing/*`；RAG `rag/*`；数据模型 `models.py`；后台队列 Worker `worker.py`。
- 部署：Docker Compose（postgres/pgvector + api + worker）；`.env` 配置模型与检索参数。

## 2. 端到端流程
### 离线：抓取 → 抽取 → 分块 → Embedding → 入库
1) 抓取（`crawler/pipeline.py`）：sitemap + 站内链接 BFS，域名白名单，include/exclude 过滤，静态资源过滤，重试。  
2) 抽取（`crawler/extract.py`）：readability 提取标题/正文/代码，转近似 Markdown。  
3) 存储：写入 `pages`（url/title/content_hash/http_status/last_crawled_at）。增量模式遇 hash 不变直接跳过。  
4) 分块（`indexing/chunking.py`）：按 h1/h2/h3 分段 + 长度切分（默认 2400 chars，overlap 200）。  
5) 向量化：按 chunk 批量 embed，写入 `chunks`（section_path/chunk_text/embedding/embedding_model/token_count/chunk_hash）。  
6) 索引：启动时自动修复 pgvector 维度、创建 HNSW/IVFFLAT、FTS(GIN)（`db.py`）。  
7) 触发：`POST /admin/api/workspaces/{workspace_id}/jobs/crawl`、`POST /admin/api/workspaces/{workspace_id}/jobs/index`（先 `POST /admin/api/auth/login` 拿 JWT）；JOBS_BACKEND=worker 时写 jobs 表，由 Worker 消费（持久化队列、重试、超时重入队）。
****
### 在线：问答 RAG
1) 请求：`POST /v1/chat/completions`（流/非流），OpenAI 兼容；附 `debug` 可返回检索信息。  
2) 预处理（`rag/conversation.py`）：提取最后一问；多轮时可 LLM 改写检索 query + 记忆摘要。  
3) 检索（`rag/pgvector_store.py`）：query embedding；默认 hybrid 向量 + BM25 FTS 归一化加权，或纯向量。  
4) 重排（可选，`rag/reranker.py`）：bge-reranker CrossEncoder 对 topK 重排。  
5) 上下文拼接（`rag/pipeline.py`）：取 topN（默认 8）生成 context，构建 inline sources（带 ref/url/title/snippet，锚点 slug）。  
6) 生成：系统提示“只基于文档片段且必须引用”，附用户 system 指令/摘要/历史摘录，Markdown 输出；校验引用编号越界，必要时追加“参考”。  
7) 响应：非流式一次性 content+sources；流式逐段 `chat.completion.chunk`，末尾 `chat.completion.sources`。  
8) 并发/超时：准备 25s，总 120s；信号量限制同时请求（默认 12）。无 ChatModel 时降级返回片段列表。

## 3. 关键参数与默认值（`.env.example`）
- Embeddings：默认 `sentence_transformers/paraphrase-multilingual-mpnet-base-v2`（768 维，CPU）；可选 fake/ollama/openai_compatible；Query embed 缓存 512 条/600s。  
- 检索：`RETRIEVAL_MODE=hybrid`，vector_k=30、bm25_k=30、权重 0.7/0.3；`RAG_TOP_K=30`、`RAG_TOP_N=8`、`RAG_MAX_SOURCES=3`、`RAG_SNIPPET_MAX_CHARS=360`。  
- 重排：`RERANK_PROVIDER=bge_reranker`（CPU，batch=16，max_candidates=30）。  
- 生成：`CHAT_BASE_URL` OpenAI 兼容，默认 `gpt-4o-mini`，temperature 0.2 / top_p 1 / max_tokens 1024；支持 `CHAT_MODEL_MAP_JSON` 暴露多模型；`CHAT_MODEL_PASSTHROUGH` 控制透传。  
- 对话增强：`QUERY_REWRITE_ENABLED`、`MEMORY_SUMMARY_ENABLED`；历史上限 12 条/6000 chars。  
- Chunk：2400 chars + 200 overlap。  
- 安全：`WIDGET_FRAME_ANCESTORS` 注入 CSP frame-ancestors；抓取限定同域。  
- 超时/并发：`RAG_PREPARE_TIMEOUT_S=25`、`RAG_TOTAL_TIMEOUT_S=120`、`MAX_CONCURRENT_CHAT_REQUESTS=12`。

## 4. 限制与风险
- 默认 `EMBEDDINGS_PROVIDER=fake` 仅用于链路验证，生产需换真实 embedding 并匹配维度。  
- Query rewrite/记忆压缩依赖上游模型，失败会回退原问题；会增加延迟。  
- Hybrid 需确保 FTS config 与 GIN 索引一致（`BM25_FTS_CONFIG`）。  
- 重排依赖 sentence-transformers 模型下载；未装会报错。  
- 抓取增量依赖 content_hash，缺少 ETag/Last-Modified 时可能重复抓取；`max_pages` 需按站点规模调优。  
- SSE 为 POST 流，客户端需自定义解析。

## 5. Web3 行业的拓展想象
1) **多链开发者中台**：抓取多链文档/SDK（EVM、Solana、Cosmos、Move），按链/版本/测试网分库，Widget 透传 `model` 选择链别，构建“全链一站式”问答。  
2) **智能合约安全 Copilot**：索引审计报告、已知漏洞库、链上事件模板，检索+重排定位风险模式，回答附引用到漏洞案例/OWASP/Trail of Bits 文章。  
3) **治理/DAO 法务助手**：抓取 DAO 章程、投票记录、提案讨论串，问答输出“结论+来源链接”，帮助快速理解治理上下文。  
4) **钱包/合规 KYC FAQ**：索引合规条款、隐私政策、KYB/KYC 流程，按地区/链路过滤，回答附法规来源，降低客服负担。  
5) **跨链桥故障排查台**：抓取运行手册、常见故障、状态页，结合当前页面 URL 作为 metadata 过滤链路，回答附具体步骤与来源。  
6) **链上数据探索教程馆**：索引 Dune/Flipside 教程、SQL 模板、GraphQL Schema，RAG 返回查询片段+引用，便于新人快速上手链上数据分析。  
7) **Tokenomics 研究助手**：收录白皮书/经济模型/分发曲线，问题改写 + 段落级引用，帮助研究员快速定位“解锁节奏/激励机制”原文。  
8) **节点运维自救台**：抓取节点部署文档/监控告警指南/常见错误，Hybrid 检索匹配错误码/日志片段，回答附命令示例与来源。  
9) **L2/rollup 对比工厂**：为 BD/产品提供多 L2 技术与费用对比，sources 指向官方规格/博文；支持“引用编号+摘要”便于 PPT 复用。  
10) **合规报告生成链**：将 RAG 输出接入自动化报告模板（例如月度链上活动/风险摘要），sources 支撑审计追溯。

## 6. 快速使用提示
- 启动：`cp .env.example .env` 填入 CHAT_API_KEY → `docker compose up -d --build`。  
- 初始化：登录拿 JWT → `POST /admin/api/workspaces/default/jobs/crawl`（可设 max_pages 5000+）→ `POST /admin/api/workspaces/default/jobs/index`。  
- 对话测试：`curl -s http://localhost:8000/v1/chat/completions -d '{"messages":[{"role":"user","content":"如何集成 OneKey Connect？"}]}'`。  
- Widget 嵌入：`<script src="https://你的域/widget/widget.js"></script>`，建议设置 `WIDGET_FRAME_ANCESTORS`。

## 7. 可演进方向
- 更强 rerank/段落级高亮、结果缓存与限流、离线评测集与自动回归。  
- 多源知识（内部 wiki/issue/日志）与多模型路由；权重调优面向场景（安全/合规/运维）。  
- 观测与运营：利用 `debug/timings` 接入 trace/metrics，建设“问题类型-引用命中-耗时”看板指导文档治理。
