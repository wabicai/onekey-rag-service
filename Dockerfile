# ==================== Stage 1: Build Widget ====================
FROM node:22.23.4-alpine AS widget-builder

WORKDIR /build

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY frontend-chat/package.json frontend-chat/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY frontend-chat/ ./
RUN pnpm build

# ==================== Stage 2: Build Admin UI ====================
FROM node:22.23.4-alpine AS admin-builder

WORKDIR /build

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY frontend-admin/package.json frontend-admin/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY frontend-admin/ ./
RUN pnpm build

# ==================== Stage 3: Python Backend ====================
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HOME=/root/.cache/huggingface

ARG SENTENCE_TRANSFORMERS_MODEL=sentence-transformers/paraphrase-multilingual-mpnet-base-v2
ENV SENTENCE_TRANSFORMERS_MODEL=${SENTENCE_TRANSFORMERS_MODEL}

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY onekey_rag_service /app/onekey_rag_service

# 从构建阶段复制前端产物到静态目录
COPY --from=widget-builder /build/dist /app/onekey_rag_service/static/widget
COPY --from=admin-builder /build/dist /app/onekey_rag_service/static/admin

ENV PYTHONPATH=/app

EXPOSE 8000

CMD ["uvicorn", "onekey_rag_service.api.app:app", "--host", "0.0.0.0", "--port", "8000"]
