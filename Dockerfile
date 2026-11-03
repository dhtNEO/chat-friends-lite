FROM oven/bun:1.4-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package.json frontend/bun.lock* ./
RUN bun install --frozen-lockfile
COPY frontend/ ./
RUN bun run build

FROM rust:1.98-slim-trixie AS backend-builder
WORKDIR /app/backend
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev cmake clang && rm -rf /var/lib/apt/lists/*
COPY backend/Cargo.toml backend/Cargo.lock* ./
COPY backend/src ./src
COPY backend/migrations ./migrations
RUN cargo build --release

FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 10001 appuser
WORKDIR /app
COPY --from=backend-builder /app/backend/target/release/chat-friends-backend /app/server
COPY --from=frontend-builder /app/frontend/dist /app/static
RUN mkdir -p /data && chown -R appuser:appuser /data /app
USER appuser
ENV STATIC_DIR=/app/static
ENV DATABASE_URL=sqlite:///data/chatfriends.db?mode=rwc
EXPOSE 8080
CMD ["/app/server"]
