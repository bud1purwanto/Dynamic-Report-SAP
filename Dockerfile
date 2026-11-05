# Multi-stage Dockerfile for Dynamic Report (Lumina) Production

# Stage 1: Build Frontend
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

# Stage 2: Build pyrfc (SAP NW RFC SDK diberikan lewat build context "nwrfcsdk", lihat docker-compose.yml)
FROM python:3.12-slim AS pyrfc-builder
RUN apt-get update && apt-get install -y --no-install-recommends build-essential && rm -rf /var/lib/apt/lists/*
COPY --from=nwrfcsdk / /usr/local/sap/nwrfcsdk
ENV SAPNWRFC_HOME=/usr/local/sap/nwrfcsdk
# pyrfc 3.3.1 ditandai "yanked" di PyPI sehingga wajib dipin eksplisit (sama seperti ABAP-Git).
RUN pip wheel --no-cache-dir --wheel-dir /wheels "pyrfc==3.3.1"

# Stage 3: Runtime Backend & App
FROM python:3.12-slim AS runner

WORKDIR /app

# Install system dependencies (curl for healthcheck, libpq etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install python dependencies
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r ./backend/requirements.txt

# Direct pyRFC: library SDK di-mount saat runtime (docker-compose.yml), modul pyrfc dari stage builder.
ENV SAPNWRFC_HOME=/usr/local/sap/nwrfcsdk
ENV LD_LIBRARY_PATH=/usr/local/sap/nwrfcsdk/lib
COPY --from=pyrfc-builder /wheels /tmp/wheels
RUN pip install --no-cache-dir /tmp/wheels/*.whl && rm -rf /tmp/wheels

# Copy backend application source
COPY backend/ ./backend/

# Copy built frontend assets from stage 1 to frontend/dist
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

# Copy entrypoint runner
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# Non-root user for security
RUN useradd -m -u 1000 appuser && \
    chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:8000/api/health || exit 1

ENTRYPOINT ["./docker-entrypoint.sh"]

