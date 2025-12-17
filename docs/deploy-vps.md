# VPS 部署指南（Docker Compose 生产建议）

本文把本仓库的 `docker-compose` RAG Service 部署到远程 VPS（推荐：Ubuntu 22.04/24.04）并对外提供 `https://你的域名/` 访问的完整操作命令记录下来。

> 约定：文档中的 `YOUR_DOMAIN` / `YOUR_VPS_IP` / `YOUR_EMAIL` / `YOUR_CHAT_API_KEY` 等均为占位符，按你的实际值替换即可。

---

## 0. 你将得到什么

- 对外入口：`https://exwxyzi.cn`
- 服务端口：VPS 只对公网开放 `22/80/443`
- 反向代理：Caddy 自动申请/续期 HTTPS 证书
- 安全加固（可选）：限制 `/admin/*` 仅内网/办公网/VPN 访问（或额外加 BasicAuth 门禁）
- 容器编排：`postgres(pgvector) + api + worker + caddy`

---

## 1. 准备信息（部署前先确定）

请准备并记录：

- `YOUR_VPS_IP`：VPS 公网 IP
- `YOUR_DOMAIN`：域名（A 记录指向 `YOUR_VPS_IP`）
- `YOUR_EMAIL`：用于 HTTPS 证书申请的邮箱
- `YOUR_CHAT_API_KEY`：上游 OpenAI-Compatible（OpenAI/DeepSeek 等）的 Key

建议你在本地终端先导出这些变量（方便复制命令）：

```bash
export VPS_IP="YOUR_VPS_IP"
export DOMAIN="exwxyzi.cn"
export EMAIL="YOUR_EMAIL"
```

---

## 2. 本地电脑：SSH 密钥登录（推荐）

如果你已经能用 SSH Key 登录，可跳过本节。

```bash
ssh-keygen -t ed25519 -C "rag-vps" -f ~/.ssh/id_ed25519_rag_vps
ssh-copy-id -i ~/.ssh/id_ed25519_rag_vps.pub root@"$VPS_IP"
ssh -i ~/.ssh/id_ed25519_rag_vps root@"$VPS_IP"
```

---

## 3. VPS：系统初始化 + 安装 Docker/Compose

以下命令在 VPS 上执行（以 Ubuntu 为例）。

### 3.1 更新系统与基础工具

```bash
sudo apt-get update -y
sudo apt-get upgrade -y
sudo apt-get install -y git ca-certificates curl ufw
```

### 3.2 安装 Docker Engine + Compose（官方仓库方式）

```bash
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo \"$VERSION_CODENAME\") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update -y
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

sudo systemctl enable --now docker

docker --version
docker compose version
```

### 3.3（可选但推荐）创建非 root 用户运行部署

```bash
sudo adduser rag --disabled-password --gecos ""
sudo usermod -aG docker rag
sudo usermod -aG sudo rag

sudo -iu rag
docker ps
```

> 后续如果你切换到 `rag` 用户执行，所有路径和命令保持一致即可。

---

## 4. VPS：防火墙（只开 22/80/443）

> 注意：Docker 发布端口可能绕过部分防火墙规则，生产更推荐“不要发布数据库端口到宿主机”，本指南会通过 Compose 配置避免对外暴露 Postgres。

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
sudo ufw status verbose
```

---

## 5. VPS：拉取代码与准备配置文件

### 5.1 拉取仓库

```bash
sudo mkdir -p /opt/onekey-rag-service
sudo chown -R "$USER":"$USER" /opt/onekey-rag-service

cd /opt/onekey-rag-service
git clone git@github.com:wabicai/onekey-rag-service.git .
git rev-parse --short HEAD
```

如果 VPS 没有配置 GitHub SSH Key，也可以用 HTTPS：

```bash
cd /opt/onekey-rag-service
git clone https://github.com/wabicai/onekey-rag-service.git .
```

### 5.2 配置 `.env`

```bash
cd /opt/onekey-rag-service
cp .env.example .env
```

编辑 `.env`（示例用 `nano`，你也可以用 `vim`）：

```bash
nano .env
```

至少需要填写：

- `CHAT_API_KEY=YOUR_CHAT_API_KEY`
- （推荐）`WIDGET_FRAME_ANCESTORS="'self' https://developer.onekey.so"`
- 后台登录与 JWT（生产必填）：
  - `ADMIN_PASSWORD=强密码`
  - `ADMIN_JWT_SECRET=强随机密钥`（用于签发/校验 JWT）

（强烈建议）修改 Postgres 默认口令（并同步更新 `DATABASE_URL`）：

```bash
nano .env
```

在 `.env` 里新增/修改（示例）：

```bash
POSTGRES_PASSWORD=请替换为强密码
DATABASE_URL=postgresql+psycopg2://postgres:请替换为强密码@postgres:5432/onekey_rag
```

> 说明：`.env.example` 默认启用 `sentence_transformers` embedding + `bge-reranker`，首次启动会下载模型（耗时/耗流量）。如果你的 VPS 不方便联网下载模型，可把 `EMBEDDINGS_PROVIDER` 临时改成 `fake` 先跑通链路，或把模型文件预下载后挂载进容器再切回本地模型。

---

## 6. VPS：生产用 Compose + Caddy（推荐）

本仓库默认的 `docker-compose.yml` 更偏“本地一键启动”。生产推荐使用专用 Compose：`docker-compose.vps.yml`（不对外暴露 Postgres，只对公网开放 80/443）。

后台管理说明：

- Admin UI：`https://YOUR_DOMAIN/admin/ui/#/login`（使用应用层 JWT 登录）
- Admin API：`/admin/api/*`（需要 `Authorization: Bearer <token>`）

### 6.1 写入 `deploy/Caddyfile`

```bash
cd /opt/onekey-rag-service
mkdir -p deploy

 cat > deploy/Caddyfile <<'CADDYFILE'
{
  email YOUR_EMAIL
}

exwxyzi.cn {
  encode zstd gzip

  reverse_proxy api:8000
}
CADDYFILE
```

替换 `deploy/Caddyfile` 中的：

- `YOUR_EMAIL` → 你的邮箱

### 6.2 写入 `docker-compose.vps.yml`

```bash
cd /opt/onekey-rag-service

cat > docker-compose.vps.yml <<'YAML'
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-postgres}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-postgres}
      POSTGRES_DB: ${POSTGRES_DB:-onekey_rag}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-postgres} -d ${POSTGRES_DB:-onekey_rag}"]
      interval: 5s
      timeout: 3s
      retries: 20
    restart: unless-stopped

  api:
    build:
      context: .
      dockerfile: Dockerfile
    environment:
      APP_ENV: ${APP_ENV:-prod}
      LOG_LEVEL: ${LOG_LEVEL:-INFO}
      DATABASE_URL: ${DATABASE_URL:-postgresql+psycopg2://postgres:postgres@postgres:5432/onekey_rag}
      PGVECTOR_EMBEDDING_DIM: ${PGVECTOR_EMBEDDING_DIM:-768}
      JOBS_BACKEND: ${JOBS_BACKEND:-worker}

      CRAWL_BASE_URL: ${CRAWL_BASE_URL:-https://developer.onekey.so/}
      CRAWL_SITEMAP_URL: ${CRAWL_SITEMAP_URL:-https://developer.onekey.so/sitemap.xml}
      CRAWL_MAX_PAGES: ${CRAWL_MAX_PAGES:-2000}

      EMBEDDINGS_PROVIDER: ${EMBEDDINGS_PROVIDER:-fake}
      SENTENCE_TRANSFORMERS_MODEL: ${SENTENCE_TRANSFORMERS_MODEL:-}
      OLLAMA_BASE_URL: ${OLLAMA_BASE_URL:-http://host.docker.internal:11434}
      OLLAMA_EMBEDDING_MODEL: ${OLLAMA_EMBEDDING_MODEL:-nomic-embed-text}

      RERANK_PROVIDER: ${RERANK_PROVIDER:-none}
      BGE_RERANKER_MODEL: ${BGE_RERANKER_MODEL:-BAAI/bge-reranker-large}
      RERANK_DEVICE: ${RERANK_DEVICE:-cpu}
      RERANK_BATCH_SIZE: ${RERANK_BATCH_SIZE:-16}
      RERANK_MAX_CANDIDATES: ${RERANK_MAX_CANDIDATES:-30}
      RERANK_MAX_CHARS: ${RERANK_MAX_CHARS:-1200}

      CHAT_PROVIDER: ${CHAT_PROVIDER:-langchain}
      CHAT_MODEL_PROVIDER: ${CHAT_MODEL_PROVIDER:-openai}
      CHAT_BASE_URL: ${CHAT_BASE_URL:-https://api.openai.com/v1}
      CHAT_MODEL: ${CHAT_MODEL:-gpt-4o-mini}
      CHAT_TIMEOUT_S: ${CHAT_TIMEOUT_S:-60}
      CHAT_MAX_RETRIES: ${CHAT_MAX_RETRIES:-2}

      QUERY_REWRITE_ENABLED: ${QUERY_REWRITE_ENABLED:-true}
      MEMORY_SUMMARY_ENABLED: ${MEMORY_SUMMARY_ENABLED:-true}
      CONVERSATION_COMPACTION_MAX_TOKENS: ${CONVERSATION_COMPACTION_MAX_TOKENS:-384}
      CONVERSATION_HISTORY_MAX_MESSAGES: ${CONVERSATION_HISTORY_MAX_MESSAGES:-12}
      CONVERSATION_HISTORY_MAX_CHARS: ${CONVERSATION_HISTORY_MAX_CHARS:-6000}

      INLINE_CITATIONS_ENABLED: ${INLINE_CITATIONS_ENABLED:-true}
      ANSWER_APPEND_SOURCES: ${ANSWER_APPEND_SOURCES:-false}
      RAG_PREPARE_TIMEOUT_S: ${RAG_PREPARE_TIMEOUT_S:-25}
      RAG_TOTAL_TIMEOUT_S: ${RAG_TOTAL_TIMEOUT_S:-120}

      WIDGET_FRAME_ANCESTORS: ${WIDGET_FRAME_ANCESTORS:-}

      RETRIEVAL_MODE: ${RETRIEVAL_MODE:-hybrid}
      BM25_FTS_CONFIG: ${BM25_FTS_CONFIG:-simple}
      HYBRID_VECTOR_K: ${HYBRID_VECTOR_K:-30}
      HYBRID_BM25_K: ${HYBRID_BM25_K:-30}
      HYBRID_VECTOR_WEIGHT: ${HYBRID_VECTOR_WEIGHT:-0.7}
      HYBRID_BM25_WEIGHT: ${HYBRID_BM25_WEIGHT:-0.3}

      AUTO_CREATE_INDEXES: ${AUTO_CREATE_INDEXES:-true}
      PGVECTOR_INDEX_TYPE: ${PGVECTOR_INDEX_TYPE:-hnsw}
      PGVECTOR_HNSW_M: ${PGVECTOR_HNSW_M:-16}
      PGVECTOR_HNSW_EF_CONSTRUCTION: ${PGVECTOR_HNSW_EF_CONSTRUCTION:-64}
      PGVECTOR_IVFFLAT_LISTS: ${PGVECTOR_IVFFLAT_LISTS:-100}
    env_file:
      - .env
    volumes:
      - hf_cache:/root/.cache/huggingface
    extra_hosts:
      - "host.docker.internal:host-gateway"
    depends_on:
      postgres:
        condition: service_healthy
    restart: unless-stopped

  worker:
    build:
      context: .
      dockerfile: Dockerfile
    command: ["python", "-m", "onekey_rag_service.worker"]
    environment:
      APP_ENV: ${APP_ENV:-prod}
      LOG_LEVEL: ${LOG_LEVEL:-INFO}
      DATABASE_URL: ${DATABASE_URL:-postgresql+psycopg2://postgres:postgres@postgres:5432/onekey_rag}
      PGVECTOR_EMBEDDING_DIM: ${PGVECTOR_EMBEDDING_DIM:-768}
      JOBS_BACKEND: ${JOBS_BACKEND:-worker}

      CRAWL_BASE_URL: ${CRAWL_BASE_URL:-https://developer.onekey.so/}
      CRAWL_SITEMAP_URL: ${CRAWL_SITEMAP_URL:-https://developer.onekey.so/sitemap.xml}
      CRAWL_MAX_PAGES: ${CRAWL_MAX_PAGES:-2000}

      EMBEDDINGS_PROVIDER: ${EMBEDDINGS_PROVIDER:-fake}
      SENTENCE_TRANSFORMERS_MODEL: ${SENTENCE_TRANSFORMERS_MODEL:-}
      OLLAMA_BASE_URL: ${OLLAMA_BASE_URL:-http://host.docker.internal:11434}
      OLLAMA_EMBEDDING_MODEL: ${OLLAMA_EMBEDDING_MODEL:-nomic-embed-text}

      RERANK_PROVIDER: ${RERANK_PROVIDER:-none}
      BGE_RERANKER_MODEL: ${BGE_RERANKER_MODEL:-BAAI/bge-reranker-large}
      RERANK_DEVICE: ${RERANK_DEVICE:-cpu}
      RERANK_BATCH_SIZE: ${RERANK_BATCH_SIZE:-16}
      RERANK_MAX_CANDIDATES: ${RERANK_MAX_CANDIDATES:-30}
      RERANK_MAX_CHARS: ${RERANK_MAX_CHARS:-1200}

      AUTO_CREATE_INDEXES: ${AUTO_CREATE_INDEXES:-true}
      PGVECTOR_INDEX_TYPE: ${PGVECTOR_INDEX_TYPE:-hnsw}
      PGVECTOR_HNSW_M: ${PGVECTOR_HNSW_M:-16}
      PGVECTOR_HNSW_EF_CONSTRUCTION: ${PGVECTOR_HNSW_EF_CONSTRUCTION:-64}
      PGVECTOR_IVFFLAT_LISTS: ${PGVECTOR_IVFFLAT_LISTS:-100}

      WORKER_POLL_INTERVAL_S: ${WORKER_POLL_INTERVAL_S:-1}
      WORKER_STALE_AFTER_S: ${WORKER_STALE_AFTER_S:-3600}
      WORKER_MAX_ATTEMPTS: ${WORKER_MAX_ATTEMPTS:-3}
    env_file:
      - .env
    volumes:
      - hf_cache:/root/.cache/huggingface
    extra_hosts:
      - "host.docker.internal:host-gateway"
    depends_on:
      postgres:
        condition: service_healthy
    restart: unless-stopped

  caddy:
    image: caddy:2
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./deploy/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - api
    restart: unless-stopped

volumes:
  pgdata:
  hf_cache:
  caddy_data:
  caddy_config:
YAML
```

> 安全建议：把 `postgres` 的 `POSTGRES_PASSWORD` 与 `DATABASE_URL` 改成强密码组合（并同步更新 `.env`），避免默认口令长期存在。

---

## 7. 启动与自检

### 7.1 启动

```bash
cd /opt/onekey-rag-service
docker compose -f docker-compose.vps.yml up -d --build
docker compose -f docker-compose.vps.yml ps
```

### 7.2 查看日志

```bash
cd /opt/onekey-rag-service
docker compose -f docker-compose.vps.yml logs -f --tail=200
```

### 7.3 健康检查（在 VPS 上执行）

```bash
curl -sS -H "Host: exwxyzi.cn" http://127.0.0.1/healthz
```

如果你已完成域名解析与 HTTPS：

```bash
curl -sS https://exwxyzi.cn/healthz
```

---

## 8. 初始化数据：抓取 + 建索引（首次必做）

> 本节建议在 VPS 上执行；如你不想把后台（`/admin/*`）暴露公网，可用 SSH 隧道或仅开放内网/办公网/VPN（见后文）。

### 8.1 抓取（crawl）

```bash
# 1) 登录拿 token（把响应里的 access_token 复制出来）
curl -sS https://exwxyzi.cn/admin/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"你的 ADMIN_PASSWORD 明文"}'

# 2) 触发 crawl（把 <token> 替换为上一步的 access_token）
curl -sS https://exwxyzi.cn/admin/api/workspaces/default/jobs/crawl \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer <token>" \
  -d '{"kb_id":"default","source_id":"source_default","mode":"full","sitemap_url":"https://developer.onekey.so/sitemap.xml","seed_urls":["https://developer.onekey.so/"],"max_pages":5000}'
```

返回形如：

```json
{"job_id":"crawl_xxxxxxxxxxxx"}
```

轮询状态：

```bash
curl -sS https://exwxyzi.cn/admin/api/workspaces/default/jobs/<job_id> -H "Authorization: Bearer <token>"
```

### 8.2 建索引（index）

```bash
curl -sS https://exwxyzi.cn/admin/api/workspaces/default/jobs/index \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer <token>" \
  -d '{"kb_id":"default","mode":"full"}'
```

轮询状态：

```bash
curl -sS https://exwxyzi.cn/admin/api/workspaces/default/jobs/<job_id> -H "Authorization: Bearer <token>"
```

---

## 9. 对外联调：OpenAI-Compatible API + Widget

### 9.1 模型列表

```bash
curl -sS https://exwxyzi.cn/v1/models
```

### 9.2 对话（非流式）

```bash
curl -sS https://exwxyzi.cn/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"onekey-docs","messages":[{"role":"user","content":"如何在项目里集成 OneKey Connect？"}],"stream":false}'
```

### 9.3 Widget（同域一行 script）

```bash
curl -I https://exwxyzi.cn/widget/widget.js
```

---

## 10. 日常运维命令（更新/重启/回滚/备份）

### 10.1 更新代码并重启（最常用）

```bash
cd /opt/onekey-rag-service
git pull
docker compose -f docker-compose.vps.yml up -d --build
docker compose -f docker-compose.vps.yml logs -f --tail=200
```

### 10.2 重启/停止

```bash
cd /opt/onekey-rag-service
docker compose -f docker-compose.vps.yml restart
docker compose -f docker-compose.vps.yml stop
docker compose -f docker-compose.vps.yml up -d
```

### 10.3 快速定位问题

```bash
cd /opt/onekey-rag-service
docker compose -f docker-compose.vps.yml ps
docker compose -f docker-compose.vps.yml logs api --tail=200
docker compose -f docker-compose.vps.yml logs worker --tail=200
docker compose -f docker-compose.vps.yml logs postgres --tail=200
docker compose -f docker-compose.vps.yml logs caddy --tail=200
```

### 10.4 回滚到某个版本（git）

```bash
cd /opt/onekey-rag-service
git fetch --all --prune
git checkout <commit_sha_or_tag>
docker compose -f docker-compose.vps.yml up -d --build
```

### 10.5 备份（重点：pgdata）

先找到实际 volume 名称：

```bash
docker volume ls | grep pgdata
```

备份到 `/opt/backup/`（示例：把 volume 名替换成你机器上的实际名字）：

```bash
sudo mkdir -p /opt/backup
sudo chown -R "$USER":"$USER" /opt/backup

export PGDATA_VOLUME="onekey-rag-service_pgdata"
docker run --rm -v "$PGDATA_VOLUME":/var/lib/postgresql/data -v /opt/backup:/backup alpine \
  sh -c 'cd /var/lib/postgresql/data && tar -czf /backup/pgdata-$(date +%F-%H%M%S).tar.gz .'
```

---

## 11.（可选）更安全的 Admin 调用方式：SSH 隧道

如果你不想让后台（`/admin/*`）走公网，可以在本地通过 SSH 隧道把 VPS 的 443/80 或容器端口转发到本地。

示例：把 VPS 上的 `127.0.0.1:8000` 映射到本地 `127.0.0.1:8000`（需要你把 `api` 端口暴露到宿主机，本指南的推荐方案默认不暴露；如确需此方式，可在 `docker-compose.vps.yml` 给 `api` 加上 `ports: ["127.0.0.1:8000:8000"]`）。

```bash
ssh -N -L 8000:127.0.0.1:8000 rag@"$VPS_IP"
curl -sS http://127.0.0.1:8000/healthz
```
