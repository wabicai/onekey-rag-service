# Langfuse 部署与 Langchain 对接指南

为加速 observability 平台，建议直接使用官方 Docker 镜像部署 [langfuse](https://github.com/langfuse/langfuse)，在 `docker-compose.yml` 中与现有 `postgres`/`redis` 一键启动，并在 Langchain 中统一回调上报。以下文档分为部署准备、部署流程与 Langchain 对接三部分。

---

## 一、部署准备

1. **镜像与版本管理**：使用官方镜像 `langfuse/langfuse:<tag>`，默认可先用 `latest` 拉起，确认可用 tag 后再固定到具体版本并更新 `docs/langfuse-version.md`（记录 tag/拉取日期/维护人）。升级前阅读官方 `CHANGELOG` 评估迁移影响。若需 UI/认证定制，可基于官方镜像构建 `langfuse-custom:<tag>`，并在版本记录中注明补丁与回滚 tag。
2. **依赖服务**：Langfuse 依赖 PostgreSQL、Redis、ClickHouse（v3 必需）、Meilisearch/Elasticsearch（可选），以及对象存储（S3、MinIO）。优先复用现有集群，但使用独立数据库/用户/schema 或 Redis db index/prefix。
3. **网络与安全**：部署在内网，暴露端口（默认 3000）由 nginx 反向代理；配置 TLS/认证。为便于 Langchain 服务调用，在 same VPC 内开放 API 访问。
4. **预先准备环境变量**：在主仓库 `.env`（或 Secret Manager）中至少设置（已同步到 `.env.example`）：
   ```env
   LANGFUSE_VERSION=latest   # v3 需要 ClickHouse；确认可用 tag 后再锁定（如 v3.x），并更新 docs/langfuse-version.md
   LANGFUSE_BASE_URL=http://localhost:3000
   LANGFUSE_DATABASE_URL=postgresql://postgres:postgres@postgres:5432/langfuse           # 默认用 Postgres 超管，首次启动会创建 langfuse DB；生产请改强密码/独立用户
   LANGFUSE_REDIS_URL=redis://langfuse-redis:6379/0                               # 默认用内置 redis，如需复用外部 Redis 则修改
   CLICKHOUSE_URL=clickhouse://default:@clickhouse:9000/langfuse                 # Langfuse v3 必需（native 协议，无密码）
   CLICKHOUSE_MIGRATION_URL=clickhouse://default:@clickhouse:9000/langfuse       # 迁移必需，通常与 CLICKHOUSE_URL 相同
   CLICKHOUSE_USER=default
   CLICKHOUSE_PASSWORD=                                                          # 若设密码请同步 compose 与 URL
   LANGFUSE_PUBLIC_KEY=
   LANGFUSE_SECRET_KEY=
   LANGFUSE_SECRET_KEY_BASE=xxx
   LANGFUSE_API_KEY=随机长字符串
   LANGFUSE_NEXTAUTH_SECRET=xxx

   # 如需 OpenSearch/Meilisearch
   LANGFUSE_SEARCH_BACKEND=none
   LANGFUSE_MSEARCH_URL=http://meilisearch:7700

   # 如需对象存储（S3/MinIO）
   LANGFUSE_STORAGE_BACKEND=
   LANGFUSE_STORAGE_ENDPOINT=
   LANGFUSE_STORAGE_ACCESS_KEY_ID=
   LANGFUSE_STORAGE_SECRET_ACCESS_KEY=

   # Langchain Tracer 默认 project/dataset
   LANGFUSE_PROJECT_NAME=onekey-rag
   LANGFUSE_DATASET_NAME=rag-llm
   ```
   其他配置可参考官方 `docker-compose` 中的 `.env.example`，敏感值建议走 Secret Manager。
5. **资源监控**：建议为 langfuse 单元添加 Prometheus 指标（已内置），日志输出到集中平台，便于后续排查数据上报问题。

## 二、部署流程

1. **使用主 `docker-compose.yml`（已内置 Langfuse）**：本仓的 compose 默认包含 `langfuse`、`langfuse-redis`、`clickhouse` 服务，可一键启动。
   ```yaml
   services:
     langfuse:
       image: langfuse/langfuse:${LANGFUSE_VERSION:-latest}
       env_file:
         - .env
       environment:
         DATABASE_URL: ${LANGFUSE_DATABASE_URL:-postgresql://langfuse:langfuse@postgres:5432/langfuse}
         REDIS_URL: ${LANGFUSE_REDIS_URL:-redis://langfuse-redis:6379/0}
         CLICKHOUSE_URL: ${CLICKHOUSE_URL:-http://clickhouse:8123}
         SECRET_KEY_BASE: ${LANGFUSE_SECRET_KEY_BASE:-changeme}
         LANGFUSE_API_KEY: ${LANGFUSE_API_KEY:-changeme}
         LANGFUSE_PUBLIC_KEY: ${LANGFUSE_PUBLIC_KEY:-}
         LANGFUSE_SECRET_KEY: ${LANGFUSE_SECRET_KEY:-}
         NEXTAUTH_SECRET: ${LANGFUSE_NEXTAUTH_SECRET:-changeme}
         NEXT_PUBLIC_LANGFUSE_BASE_URL: ${LANGFUSE_BASE_URL:-http://localhost:3000}
         SEARCH_BACKEND: ${LANGFUSE_SEARCH_BACKEND:-none}
         MSEARCH_URL: ${LANGFUSE_MSEARCH_URL:-}
         STORAGE_BACKEND: ${LANGFUSE_STORAGE_BACKEND:-}
         STORAGE_ENDPOINT: ${LANGFUSE_STORAGE_ENDPOINT:-}
         STORAGE_ACCESS_KEY_ID: ${LANGFUSE_STORAGE_ACCESS_KEY_ID:-}
         STORAGE_SECRET_ACCESS_KEY: ${LANGFUSE_STORAGE_SECRET_ACCESS_KEY:-}
       ports:
         - "3000:3000"
       depends_on:
         postgres:
           condition: service_healthy
         langfuse-redis:
           condition: service_started
         clickhouse:
            condition: service_started

   langfuse-redis:
     image: redis:7
     command: ["redis-server", "--appendonly", "yes"]  # 开启 AOF 持久化
     volumes:
       - langfuse-redis:/data
     restart: unless-stopped

   clickhouse:
     image: clickhouse/clickhouse-server:24.3
     environment:
       CLICKHOUSE_DB: langfuse
     volumes:
       - clickhouse-data:/var/lib/clickhouse
     restart: unless-stopped
   ```
   根据环境需要再添加对象存储、Search 后端的 env。
2. **数据库与缓存**：确保 `LANGFUSE_DATABASE_URL` 指向可访问的 PostgreSQL 实例（推荐独立 DB/用户），内置 Redis 默认 AOF 持久化；如需外部 Redis，修改 `LANGFUSE_REDIS_URL`。
   - 本仓提供 `deploy/init-langfuse.sql`，首次启动 Postgres 容器会自动创建 `langfuse` 数据库与用户/密码（默认弱口令 `langfuse`，生产请修改脚本或 `.env` 为强密码后再首次启动）。
3. **启动**：在根目录执行：
   ```bash
   docker compose up -d
   ```
   仅启动 Langfuse 时可运行 `docker compose up -d langfuse langfuse-redis clickhouse postgres`。
4. **自定义扩展**：若需要插件/认证扩展，可自建镜像（Dockerfile）并替换 `image`；或通过 `LANGFUSE_PLUGIN_IMPORT_PATHS` 挂载自定义包。
5. **数据备份**：定期备份 PostgreSQL 和对象存储（用于事件数据、查询历史）；可通过 crontab 调度备份脚本。
6. **外部访问**：完成部署后，访问 `http://localhost:3000` 验证 UI；将 `LANGFUSE_API_KEY` 作为服务调用凭据，并与主系统共享用于校验来源。

## 三、Langchain 对接流程

### 3.1 目标与原则

- 目标：将 Langchain 中的每一次 LLM 调用、Chain/Agent 运行、Retriever 执行、工具调用等信息上传到 langfuse，以获取可视化 trace、异常告警与指标。
- 原则：优先使用 langfuse 官方提供的回调处理器；在关键链路加入自定义标签/元数据；确保敏感信息（如明文 prompt）按公司策略脱敏或只上传 hash；通过 `LANGFUSE_API_KEY` 进行识别与权限控制。

### 3.2 安装客户端

在 Langchain 服务中安装依赖：
```bash
pip install langfuse langchain
```

### 3.3 回调配置示例

以我们的主 Langchain 服务为例（假设在 `src/`），可以在创建 LLMS、Chain 时引入 Langfuse 回调：

```python
from langchain.callbacks import LangfuseTracer
from langchain.chat_models import ChatOpenAI
from langchain.chains import RetrievalQA
from langchain.vectorstores import FAISS
from langchain.embeddings import OpenAIEmbeddings

tracer = LangfuseTracer(
    project_name="onekey-rag",
    dataset_name="rag-llm",
    api_key=os.getenv("LANGFUSE_API_KEY"),
    tags={"env": "prod", "team": "rag"},
)

llm = ChatOpenAI(temperature=0, callbacks=[tracer])
retriever = FAISS.from_documents(docs, OpenAIEmbeddings())
qa = RetrievalQA.from_chain_type(
    llm=llm,
    retriever=retriever,
    callbacks=[tracer],
)
```

如需对 Agent、Tool、Retriever 等细粒度事件打点，可将 `callbacks=[tracer]` 传入所有链路构造函数；Tracer 会自动收集输入、output、tokens、errors 等并发送到 langfuse。

### 3.4 自定义元数据与 tags

为了支持业务分析，可通过 `LangfuseTracer` 的 `tags` 或 `metadata` 定义：

```python
tracer = LangfuseTracer(
    project_name="onekey-rag",
    dataset_name="rag-llm",
    tags={
        "product": "knowledge-base",
        "instance_id": os.getenv("HOSTNAME"),
    },
)
```

也可以在链路中手动发送自定义事件：

```python
tracer.log_event(
    name="retriever_search",
    payload={
        "source": "pinecone",
        "query": query,
        "hit_count": len(results),
    },
)
```

### 3.5 客户端与 Langfuse 的网络配置

- `LangfuseTracer` 默认向 `https://api.langfuse.com` 上报；如果自托管则通过 `base_url` 指定：
  ```python
  tracer = LangfuseTracer(base_url="http://langfuse.local:3000/api", ...)
  ```
- 如果 Langchain 服务与 langfuse 部署在不同网络，需在部署层面做出路由/代理配置，并确保 `LANGFUSE_API_KEY` 在 header `Authorization: Bearer ...` 中被识别。

### 3.6 故障排查建议

1. **请求未到达**：检查 Langchain 服务日志，确认 callback 中 `log_event` 成功；使用 `tcpdump` 或 `curl` 直接访问 langfuse `health` 接口。
2. **数据缺失**：确认 `project_name` 与 `dataset_name` 已预先在 Langfuse UI 中创建（或允许自动创建）；查看 PostgreSQL 中 `runs` 表是否有新记录。
3. **性能影响**：Tracer 默认异步上报，若遇延迟可限制 `max_concurrent_runs` 或将 `send_interval_seconds` 调大。

### 3.7 本项目的内置接入方式

- 只要配置了 `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY`（可选 `LANGFUSE_BASE_URL`），`/v1/chat/completions` 会自动为上游 ChatModel 构建 Langfuse CallbackHandler（无需手动传 callbacks）。
- 默认 tags：`env:<APP_ENV>`、`service:onekey-rag`、`ws:<workspace>`、`app:<app_id>`；metadata 附带 `request_id`、`workspace_id`、`app_id`、`langfuse_project/dataset` 以及请求元数据（仅标量字段）。
- 若 `req.metadata` 中包含用户标识，可传入 `user_id` 字段，代码会自动 hash 为 `user_id_hash` 避免明文。
- 未配置密钥或导入失败时自动跳过回调，不影响主流程。
- Admin “模型自测”接口也接入了 Langfuse 回调（以 `admin-test-*` request_id 标记），方便验证链路。

## 四、验证与监控

### 4.1 敏感数据与脱敏策略

- 默认不上传用户输入原文到 Langfuse：`req.metadata` 建议只带业务无关的标量字段。用户标识请传 `user_id`，服务会自动 hash 成 `user_id_hash`（不存明文）。如需更多上下文，先脱敏或哈希。
- 不上传完整 prompt/响应：如需审计，可在 Langfuse UI/SDK 中配置 sampling 或在回调中只写摘要。
- 业务敏感字段（邮箱/手机号/订单号等）一律 hash 后再上传；文件内容、token、密钥不应出现在 metadata。

### 4.2 验证脚本与预期指标

- 运行本仓示例脚本发送 sanity trace：
  ```bash
  LANGFUSE_PUBLIC_KEY=... LANGFUSE_SECRET_KEY=... LANGFUSE_BASE_URL=http://localhost:3000 \
  python examples/langfuse-verify.py
  ```
  预期：Langfuse UI 中能看到 `langfuse-sanity-check` trace，含 tags `env:<APP_ENV>`、`service:onekey-rag`。
- 聊天链路验证：请求 `/v1/chat/completions`，并在 Langfuse UI 检查 trace 是否包含 retriever/LLM 分段与 tokens。

### 4.3 监控、告警与安全

- Prometheus：Langfuse 镜像提供 metrics（参考官方文档，通常通过反向代理暴露 `/metrics`），请将 endpoint 加入现有 Prom 抓取列表并加上 job 标签（env/instance）。
- 告警：根据 Langfuse metrics 或 UI 配置接口错误率/队列长度/请求延迟等规则；上游可接企业微信/Slack/Webhook。
- 访问控制：在反向代理层（Caddy/Nginx/API Gateway）给 `/langfuse` 加 IP 白名单和 TLS，`NEXTAUTH_SECRET` 必填；按环境拆分不同 `LANGFUSE_API_KEY` 并限制只注入后台服务。

### 4.4 备份与回滚

- 数据：Postgres（Langfuse 专用库）与对象存储桶纳入现有备份策略；Redis 仅作缓存可不备份。
- 回滚：镜像 tag 写入 `docs/langfuse-version.md`；升级前在预发验证迁移，若生产异常直接回滚到前一个 tag 并执行 `docker compose ... up -d langfuse`，同时恢复数据库快照（如涉及向后不兼容迁移）。

## 五、典型对接场景建议

1. **知识问答链路**：在所有 RetrievalQA、ConversationalRetrievalChain 中加入 Tracer；将检索 source、结果 score 当作 metadata 上报，便于回溯失败案例。
2. **Agent 监控**：每个 Agent 启动前生成 `LangfuseTracer`，将 `agent_id`、`tool_name`、`user_id` 作为 tags；配合 `log_event` 记录 tool 调用 args。
3. **Embedding 构建**：在 batch embedding 任务中手工调用 `tracer.log_event` 记录进度与耗时，便于性能分析。

## 六、后续建议

1. 将 Langfuse 与现有 admin 的告警/指标体系打通，实现上下游视图共享。   
2. 结合 Langfuse API，按需自动化生成失败报警或用户行为分析报告。  
3. 将部署和配置写入 CI/CD（若使用 infra 目录，可改写为 Terraform 或 Helm）；确保 Langfuse 与 onekey-rag-service 同步上线时变更可控。

如需我进一步帮忙整理部署脚本、callback 工具包装或对接测试用例，请指明具体方向。

## 七、与 onekey-rag-service 协同部署

1. **版本兼容性**：Langfuse 的 API/数据库 schema 会演进，生产环境应固定官方 release tag（如 `v2.50.x`），切换前阅读 `CHANGELOG` 评估迁移影响。
2. **共享数据库与缓存**：
   - 可以将 Langfuse 的 `DATABASE_URL` 指向与 onekey-rag-service 同一 PostgreSQL 集群的单独数据库（如 `postgresql://user:pwd@db-host/langfuse`），只要使用不同 schema/用户即可避免冲突。
   - Redis 也可复用现有实例，但建议使用独立 `db` index 或 key-prefix 保证指标数据隔离，例如 `REDIS_URL=redis://redis-host:6379/1`.
3. **Docker Compose 统一调度**：主 `docker-compose.yml` 已包含 Langfuse + 内置 Redis，默认与 api/worker/postgres 一起启动（也可单独启动 Langfuse）。
   - 一键启动：`docker compose up -d`
   - 仅启 Langfuse：`docker compose up -d langfuse langfuse-redis postgres`
4. **与后端服务的集成**：
   - 主 Langchain 后端需将 `LANGFUSE_API_KEY`、`LANGFUSE_BASE_URL` 等来源自环境变量中注入 `LangfuseTracer`。
   - 后端也可在业务流程中通过 `langfuse-sdk`（Python/TS）手动上传自定义事件，例如 `tracer.log_event`、`tracer.log_metric`，以捕获对接状态、用户上下文等。
   - 可通过反向代理在 `/langfuse` 暴露 UI，或在现有 admin 中 iframe 嵌入，统一运维视图。
5. **数据库复用与权限**：在数据库层面为 Langfuse 创建专用用户与 schema，避免与主服务互相篡改数据；若需要跨服务查询，可通过 API gate 抽象统一权限。
6. **配置同步**：将 Langfuse 所需的 env（`PROJECT_NAME`、`DATASET_NAME`、`LANGFUSE_API_KEY` 等）纳入主仓库的配置管理（如 `.env.example`、Vault、参数化部署剧本），确保在多环境下一致。
