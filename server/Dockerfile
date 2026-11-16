FROM python:3.11-slim

WORKDIR /app

COPY server/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY server/ /app/server/

ENV TAIS_CONFIG=/app/config.yaml \
    TAIS_DATABASE_PATH=/app/data/ingest.db

CMD ["python", "-m", "server.main"]
