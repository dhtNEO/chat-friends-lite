# Chat Friends (v2.0)

Aplicação enxuta para chamadas de voz, chat em tempo real e compartilhamento de tela opt-in com visual estilo Discord, projetada para operar com baixo consumo de recursos (`e2-small` no GCP, ~120 MB de RAM).

## Arquitetura

- **Backend (`backend/`) — Rust + Axum + SQLx + SQLite (WAL):**
  - Autenticação com Argon2id e código de convite (`SERVER_INVITE_CODE`).
  - Chat persistente e eventos em tempo real via WebSocket (`/ws`).
  - Emissão de tokens JWT LiveKit (HS256, validade de 12h).
  - Atualização automática de IP no DuckDNS a cada 5 minutos e limpeza horária de sessões expiradas.

- **Frontend (`frontend/`) — Bun + SolidJS + LiveKit Client + Web Audio API:**
  - Compartilhamento de tela opt-in (`autoSubscribe: false` para vídeo) com presets `720p@30fps` e `1080p@60fps`.
  - Controle de volume independente por usuário (Voz 0–200%, Live 0–100%) com curva perceptual quadrática.
  - Ganho de microfone com limiter suave (-3 dB), VU Meter em tempo real e efeitos sonoros via Web Audio API.

- **Infraestrutura (`infra/`):**
  - 3 contêineres em produção (`infra/compose/compose.yml`): `caddy` (TLS DNS-01 DuckDNS), `app` (Rust + SPA estática) e `livekit` (SFU WebRTC).
  - Provisionamento GCP via Terraform (`infra/gcp/`) com Secret Manager e Artifact Registry.

## Documentação Completa de Configuração (Local e GCP)

Consulte o [**Guia Completo de Configuração Local e no GCP (`docs/SETUP.md`)**](./docs/SETUP.md) para instruções detalhadas sobre:
- Variáveis de ambiente e pré-requisitos;
- Execução local em 3 modos (Frontend c/ Mock, Backend Rust + Frontend, e Stack Completa com LiveKit SFU);
- Provisionamento de infraestrutura no GCP com Terraform (`e2-small`, VPC, Firewall, Artifact Registry, Secret Manager);
- Build/Push das imagens Docker, deploy na VM e configuração de CI/CD via GitHub Actions.

## Desenvolvimento Local (Resumo Rápido)

### 1. Apenas Frontend (com Mock Server integrado no Vite)
```bash
cd frontend
bun install
bun run dev
```

### 2. Backend Rust (SQLite) + Frontend com Proxy
```bash
# Terminal 1 — Backend Rust (porta 8080)
cd backend
DATABASE_URL="sqlite://chatfriends.db?mode=rwc" \
SERVER_INVITE_CODE="123456" \
LIVEKIT_API_KEY="devkey" \
LIVEKIT_API_SECRET="secret_de_desenvolvimento_com_32_bytes" \
LIVEKIT_URL="ws://localhost:7880" \
cargo run

# Terminal 2 — Frontend com Proxy para o Backend (porta 3000)
cd frontend
USE_BACKEND_PROXY=true bun run dev
```

## Build de Produção (Docker)

```bash
docker build -t chat-friends-app:latest .
docker build -t chat-friends-caddy:latest ./infra/caddy
```
