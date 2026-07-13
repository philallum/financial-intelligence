# =============================================================================
# ML Service — Python 3.11 / FastAPI / XGBoost
# =============================================================================
# Provides XGBoost-based directional probability predictions for the
# batch pipeline. Called via HTTP POST /predict during each 4H cycle.
#
# Build: docker build -f Dockerfile.ml -t fip-ml .
# Run:   docker run -p 5000:5000 -e SUPABASE_URL=... -e SUPABASE_SERVICE_ROLE_KEY=... fip-ml
# =============================================================================

FROM python:3.11-slim

WORKDIR /app

# Install system deps for XGBoost
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Install Python deps
COPY ml_service/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY ml_service/app ./app
COPY ml_service/tests ./tests

# Expose port
EXPOSE 5000

# Run with uvicorn — Cloud Run sets $PORT automatically
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-5000}"]
