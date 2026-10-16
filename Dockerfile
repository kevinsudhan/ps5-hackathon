# The whole product in one image: FastAPI serves the API and the built frontend on one origin.
# Run it with the databases: docker compose --profile app up -d --build  ->  http://localhost:8080
# On start it loads the demo data if it is not there yet (~20 s the first time, then skipped).

FROM node:22-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app/backend
COPY backend/requirements.txt ./
RUN pip install -r requirements.txt
COPY backend/ ./
COPY --from=web /web/dist /app/frontend/dist
EXPOSE 8000
CMD ["sh", "-c", "python -m scripts.load --if-missing && exec uvicorn promisegraph.api:app --host 0.0.0.0 --port 8000"]
