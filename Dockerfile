FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

RUN useradd --create-home --uid 10001 quoteapp && mkdir -p /app/data && chown quoteapp:quoteapp /app/data

COPY --chown=quoteapp:quoteapp app ./app
COPY --chown=quoteapp:quoteapp tools ./tools
COPY --chown=quoteapp:quoteapp data/master_data_source.json ./data/

USER quoteapp

EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/api/health', timeout=3)"

CMD ["python", "app/server.py", "--host", "0.0.0.0", "--port", "8765"]
