FROM node:20-alpine AS frontend-build

WORKDIR /frontend

COPY frontend/package.json /frontend/package.json
RUN npm install --no-audit --no-fund

COPY frontend /frontend
RUN npm run build

WORKDIR /frontend-admin
COPY frontend-admin/package.json /frontend-admin/package.json
RUN npm install --no-audit --no-fund

COPY frontend-admin /frontend-admin
RUN npm run build


FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY src /app/src
COPY --from=frontend-build /frontend/dist /app/src/onekey_rag_service/static/widget
COPY --from=frontend-build /frontend-admin/dist /app/src/onekey_rag_service/static/admin

ENV PYTHONPATH=/app/src

EXPOSE 8000

CMD ["uvicorn", "onekey_rag_service.api.app:app", "--host", "0.0.0.0", "--port", "8000"]
