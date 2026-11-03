# Guia de Configuração — Local e Google Cloud Platform (GCP)

Este documento detalha passo a passo como configurar e executar o **Chat Friends (v2.0)** em ambiente de desenvolvimento local e em produção no Google Cloud Platform (GCP).

---

## Sumário

1. [Visão Geral da Arquitetura](#1-visão-geral-da-arquitetura)
2. [Variáveis de Ambiente](#2-variáveis-de-ambiente)
3. [Configuração do Ambiente Local](#3-configuração-do-ambiente-local)
   - [Pré-requisitos Locais](#31-pré-requisitos-locais)
   - [Modo A: Apenas Frontend (Mock Server integrado)](#32-modo-a-apenas-frontend-mock-server-integrado)
   - [Modo B: Backend Rust + Frontend com Proxy](#33-modo-b-backend-rust--frontend-com-proxy)
   - [Modo C: Stack Completa Local (com LiveKit SFU para Voz/Tela)](#34-modo-c-stack-completa-local-com-livekit-sfu-para-voztela)
4. [Configuração e Deploy no GCP](#4-configuração-e-deploy-no-gcp)
   - [Pré-requisitos GCP e Domínio](#41-pré-requisitos-gcp-e-domínio)
   - [Passo 1: Provisionar Infraestrutura com Terraform](#42-passo-1-provisionar-infraestrutura-com-terraform)
   - [Passo 2: Preencher Segredos no GCP Secret Manager](#43-passo-2-preencher-segredos-no-gcp-secret-manager)
   - [Passo 3: Build e Push das Imagens Docker](#44-passo-3-build-e-push-das-imagens-docker)
   - [Passo 4: Subir os Serviços na VM (Compute Engine)](#45-passo-4-subir-os-serviços-na-vm-compute-engine)
   - [Passo 5 (Opcional): CI/CD com GitHub Actions e Workload Identity](#46-passo-5-opcional-cicd-com-github-actions-e-workload-identity)
5. [Operação, Logs e Troubleshooting](#5-operação-logs-e-troubleshooting)

---

## 1. Visão Geral da Arquitetura

O projeto foi desenhado para rodar com consumo mínimo de memória (~120 MB de RAM) em uma instância `e2-small` no GCP:

- **Frontend (`frontend/`)**: SPA em SolidJS + Vite + Web Audio API + LiveKit Client SDK.
- **Backend (`backend/`)**: Servidor Rust (Axum + Tokio + SQLx) com banco SQLite em modo WAL, autenticação via Argon2id, chat/presença por WebSocket (`/ws`), geração de tokens JWT do LiveKit e atualizador periódico de DNS dinâmico (DuckDNS).
- **Proxy Reverso (`infra/caddy/`)**: Caddy 2 compilado com módulo DNS do DuckDNS (`tls.dns.duckdns`) para emissão automática de certificados Let's Encrypt via desafio DNS-01 e roteamento HTTP/3 + WebSockets.
- **Mídia WebRTC (`infra/compose/livekit.yaml`)**: Servidor LiveKit SFU para chamadas de voz e compartilhamento de tela opt-in.

---

## 2. Variáveis de Ambiente

A referência de variáveis está no arquivo [`.env.example`](../.env.example). Abaixo está o papel de cada variável lida pelo backend ([`backend/src/config.rs`](../backend/src/config.rs)) e pelo Docker Compose ([`infra/compose/compose.yml`](../infra/compose/compose.yml)):

| Variável | Obrigatória | Padrão | Descrição |
| :--- | :---: | :--- | :--- |
| `PORT` | Não | `8080` | Porta HTTP onde o backend Rust escuta. |
| `DATABASE_URL` | Não | `sqlite:///data/chatfriends.db?mode=rwc` | URL de conexão do SQLite (cria o arquivo automaticamente com `?mode=rwc`). |
| `STATIC_DIR` | Não | `/app/static` | Diretório com o build estático do frontend servido pelo backend. |
| `SERVER_INVITE_CODE` | **Sim** | — | Código de convite exigido no cadastro de novos usuários. |
| `LIVEKIT_API_KEY` | **Sim** | — | Chave de API do servidor LiveKit (ex.: `devkey`). |
| `LIVEKIT_API_SECRET` | **Sim** | — | Segredo HMAC-SHA256 do LiveKit (mínimo recomendado: 32 bytes). |
| `LIVEKIT_URL` | **Sim** | — | URL WebSocket do LiveKit enviada ao cliente (ex.: `ws://localhost:7880` local ou `wss://seu-dominio.duckdns.org/rtc` em produção). |
| `DUCKDNS_DOMAIN` | Não | — | Subdomínio ou domínio DuckDNS (ex.: `amigos.duckdns.org`). Se definido junto com `DUCKDNS_TOKEN`, o backend atualiza o IP público a cada 5 minutos. |
| `DUCKDNS_TOKEN` | Não | — | Token da conta DuckDNS (usado pelo backend para atualizar o IP e pelo Caddy para o desafio TLS DNS-01). |
| `DOMAIN` | Prod | — | Domínio principal usado pelo Caddy e Docker Compose em produção. |
| `REGISTRY_PREFIX` | Prod | — | Prefixo do repositório no Artifact Registry (ex.: `southamerica-east1-docker.pkg.dev/projeto/chat-friends`). |

---

## 3. Configuração do Ambiente Local

### 3.1. Pré-requisitos Locais

- **Bun** `>= 1.1` (para o frontend em `frontend/`)
- **Rust & Cargo** (Toolchain estável compatível com Edition 2024 / Rust `>= 1.85`, mais dependências de sistema: `pkg-config`, `libssl-dev` / OpenSSL, `cmake`, `clang` para compilação do `aws-lc-rs`)
- **Docker & Docker Compose** *(opcional, necessário apenas para rodar o LiveKit localmente ou testar o build de produção)*

---

### 3.2. Modo A: Apenas Frontend (Mock Server integrado)

O [`frontend/vite.config.ts`](../frontend/vite.config.ts) possui um plugin de desenvolvimento (`devBackendPlugin`) que simula a API REST (`/api/*`) e o servidor WebSocket (`/ws`) em memória, com usuários e mensagens pré-carregados. É a forma mais rápida de desenvolver a interface:

```bash
cd frontend
bun install
bun run dev
```

- Acesse em: `http://localhost:3000`
- Qualquer nome de usuário/senha funciona no login ou registro neste modo.

---

### 3.3. Modo B: Backend Rust + Frontend com Proxy

Para testar o backend real em Rust (autenticação Argon2id, banco SQLite, migrações automáticas e WebSocket real):

**Terminal 1 — Iniciar o Backend Rust (porta `8080`):**

```bash
cd backend

DATABASE_URL="sqlite://chatfriends.db?mode=rwc" \
SERVER_INVITE_CODE="123456" \
LIVEKIT_API_KEY="devkey" \
LIVEKIT_API_SECRET="secret_de_desenvolvimento_com_32_bytes" \
LIVEKIT_URL="ws://localhost:7880" \
cargo run
```

> **Nota:** As migrações em [`backend/migrations/0001_initial.sql`](../backend/migrations/0001_initial.sql) são executadas automaticamente na inicialização do servidor.

**Terminal 2 — Iniciar o Frontend apontando para o Backend (porta `3000`):**

Quando `USE_BACKEND_PROXY=true` é informado, o Vite desativa o mock e faz proxy de `/api` e `/ws` para `http://localhost:8080`:

```bash
cd frontend
bun install
USE_BACKEND_PROXY=true bun run dev
```

- Acesse em: `http://localhost:3000`
- Crie uma conta usando o código de convite `123456` (definido em `SERVER_INVITE_CODE`).

---

### 3.4. Modo C: Stack Completa Local (com LiveKit SFU para Voz/Tela)

Para testar chamadas de voz e compartilhamento de tela localmente junto com o Modo B, suba uma instância local do LiveKit via Docker usando as mesmas chaves configuradas no backend:

```bash
docker run --rm -it \
  -p 7880:7880 \
  -p 7881:7881 \
  -p 50000-50100:50000-50100/udp \
  -e LIVEKIT_KEYS="devkey: secret_de_desenvolvimento_com_32_bytes" \
  livekit/livekit-server:v1.10 \
  --dev --bind 0.0.0.0
```

Com o contêiner do LiveKit rodando na porta `7880`, o Backend Rust (Terminal 1) e o Frontend (Terminal 2) do **Modo B** se conectarão automaticamente ao SFU local para áudio e vídeo.

---

## 4. Configuração e Deploy no GCP

A infraestrutura no Google Cloud Platform fica em [`infra/gcp/`](../infra/gcp/) e provisiona:
1. APIs necessárias (`Compute Engine`, `Artifact Registry`, `Secret Manager`, `IAM`).
2. Repositório Docker no **Artifact Registry** (mantendo as 3 versões mais recentes).
3. Três segredos no **Secret Manager** (`chat-friends-duckdns-token`, `chat-friends-invite-code`, `chat-friends-livekit-secret`).
4. **Service Account** dedicada para a VM com princípio de privilégio mínimo (`artifactregistry.reader` e `secretmanager.secretAccessor`).
5. Rede **VPC**, sub-rede, **IP Público Estático** e regras de **Firewall** (TCP `80`, `443`, `7881`; UDP `443`, `50000-50100`; e SSH restrito).
6. Instância **Compute Engine** (`e2-small` com Debian 13, 20 GB `pd-balanced`, Shielded VM e script de inicialização [`startup.sh`](../infra/gcp/startup.sh)).

### 4.1. Pré-requisitos GCP e Domínio

1. **Conta e Projeto no GCP** com faturamento (Billing) ativo.
2. **Domínio no [DuckDNS](https://www.duckdns.org/)**:
   - Crie um subdomínio (ex.: `amigos.duckdns.org`) e anote o seu **Token DuckDNS**.
3. Ferramentas instaladas na sua máquina:
   - [Google Cloud CLI (`gcloud`)](https://cloud.google.com/sdk/docs/install)
   - [Terraform](https://developer.hashicorp.com/terraform/install) `>= 1.11.0`
   - Docker (com suporte a `docker buildx` se sua máquina for ARM/Apple Silicon para gerar imagens `linux/amd64`)

Autentique o `gcloud` localmente:

```bash
gcloud auth login
gcloud auth application-default login
gcloud config set project SEU_PROJECT_ID
```

---

### 4.2. Passo 1: Provisionar Infraestrutura com Terraform

1. Entre no diretório do Terraform e crie seu arquivo `terraform.tfvars` a partir do exemplo:

```bash
cd infra/gcp
cp terraform.tfvars.example terraform.tfvars
```

2. Edite o arquivo `infra/gcp/terraform.tfvars` com os dados do seu ambiente:

```hcl
project_id          = "seu-projeto-gcp-12345"
region              = "southamerica-east1"
zone                = "southamerica-east1-a"
name                = "chat-friends"
machine_type        = "e2-small"
boot_disk_size_gb   = 20
ssh_diagnostic_cidr = "35.235.240.0/20" # CIDR do IAP do GCP (ou seu IP/32)
domain              = "amigos.duckdns.org"
```

3. Inicialize e aplique o plano do Terraform:

```bash
terraform init
terraform plan
terraform apply
```

4. Ao concluir, o Terraform exibirá os outputs:
   - `public_ip`: IP público estático da VM (você já pode apontar seu domínio no painel do DuckDNS para este IP, embora o próprio backend também o atualize automaticamente).
   - `artifact_registry_repository`: URL do repositório Docker (ex.: `southamerica-east1-docker.pkg.dev/seu-projeto-gcp-12345/chat-friends`).
   - `secrets_created`: Nomes dos segredos criados no Secret Manager.

---

### 4.3. Passo 2: Preencher Segredos no GCP Secret Manager

O Terraform cria a estrutura dos segredos no Secret Manager, mas **não grava os valores sensíveis** para evitar que fiquem salvos em texto puro no `terraform.tfstate`. Adicione a versão inicial de cada segredo via `gcloud`:

```bash
# 1. Token do DuckDNS
printf "SEU_TOKEN_DUCKDNS" | gcloud secrets versions add chat-friends-duckdns-token --data-file=-

# 2. Código de convite para novos cadastros no servidor
printf "SEU_CODIGO_DE_CONVITE" | gcloud secrets versions add chat-friends-invite-code --data-file=-

# 3. Segredo de 32+ bytes para assinar os tokens do LiveKit
openssl rand -hex 32 | tr -d '\n' | gcloud secrets versions add chat-friends-livekit-secret --data-file=-
```

---

### 4.4. Passo 3: Build e Push das Imagens Docker

Autentique o Docker no Artifact Registry da região escolhida (padrão `southamerica-east1`):

```bash
gcloud auth configure-docker southamerica-east1-docker.pkg.dev --quiet
```

Na raiz do projeto, defina a variável com o prefixo do seu repositório (obtido no output `artifact_registry_repository` do Terraform) e faça o build e push das imagens `app` e `caddy` para a arquitetura `linux/amd64` (usada pela VM `e2-small`):

```bash
cd /caminho/para/chat-friends

export REGISTRY_PREFIX="southamerica-east1-docker.pkg.dev/SEU_PROJECT_ID/chat-friends"

# Build e Push da aplicação (Frontend SolidJS + Backend Rust)
docker buildx build --platform linux/amd64 \
  -t "${REGISTRY_PREFIX}/app:latest" \
  -f ./Dockerfile \
  --push .

# Build e Push do Caddy com módulo DuckDNS
docker buildx build --platform linux/amd64 \
  -t "${REGISTRY_PREFIX}/caddy:latest" \
  -f ./infra/caddy/Dockerfile \
  --push ./infra/caddy
```

---

### 4.5. Passo 4: Subir os Serviços na VM (Compute Engine)

Quando a VM foi criada, o [`infra/gcp/startup.sh`](../infra/gcp/startup.sh) executou automaticamente:
- Criação de `2 GB` de Swap (`swappiness=10`).
- Instalação do Docker CE e Docker Compose Plugin.
- Criação do diretório `/opt/chat-friends` e pastas persistentes `/opt/chat-friends/data/sqlite` e `/opt/chat-friends/data/caddy`.

Agora, copie os arquivos de orquestração (`compose.yml` e `Caddyfile.duckdns`) para `/opt/chat-friends` na VM e execute novamente o script de inicialização (ou suba o Docker Compose) para carregar os segredos recém-adicionados no Passo 2:

```bash
# 1. Enviar compose.yml e Caddyfile.duckdns para /tmp na VM via IAP/SSH
gcloud compute scp \
  infra/compose/compose.yml \
  infra/compose/Caddyfile.duckdns \
  chat-friends:/tmp/ \
  --zone=southamerica-east1-a \
  --tunnel-through-iap

# 2. Acessar a VM via SSH
gcloud compute ssh chat-friends \
  --zone=southamerica-east1-a \
  --tunnel-through-iap
```

Dentro da VM, mova os arquivos para `/opt/chat-friends` e rode o script de startup para gerar o `.env` e `livekit.yaml` a partir do Secret Manager e iniciar os contêineres:

```bash
sudo mv /tmp/compose.yml /tmp/Caddyfile.duckdns /opt/chat-friends/
sudo chmod 600 /opt/chat-friends/compose.yml /opt/chat-friends/Caddyfile.duckdns

# Reexecuta o startup script para buscar os segredos do Secret Manager e subir o docker compose
sudo google_metadata_script_runner startup
```

Verifique se os 3 contêineres (`chat-friends-caddy`, `chat-friends-app`, `chat-friends-livekit`) estão em execução:

```bash
sudo docker ps
```

Acesse `https://SEU_DOMINIO.duckdns.org` no navegador. O Caddy emitirá automaticamente o certificado TLS Let's Encrypt via DNS-01 na primeira inicialização.

---

### 4.6. Passo 5 (Opcional): CI/CD com GitHub Actions e Workload Identity

O repositório já inclui o workflow [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml), que faz o build e push automático das imagens `app` e `caddy` para o Artifact Registry a cada push na branch `main`.

Para ativá-lo, configure o **Workload Identity Federation (WIF)** no GCP permitindo que uma Service Account de CI tenha o papel `roles/artifactregistry.writer` no repositório e cadastre os seguintes **Secrets** no seu repositório do GitHub (`Settings > Secrets and variables > Actions`):

| GitHub Secret | Exemplo de Valor | Descrição |
| :--- | :--- | :--- |
| `GCP_PROJECT_ID` | `seu-projeto-gcp-12345` | ID do projeto no GCP. |
| `GCP_WIF_PROVIDER` | `projects/123456789/locations/global/workloadIdentityPools/github-pool/providers/github-provider` | Identificador completo do Workload Identity Provider. |
| `GCP_WIF_SERVICE_ACCOUNT` | `github-ci@seu-projeto-gcp-12345.iam.gserviceaccount.com` | E-mail da Service Account com permissão de push no Artifact Registry. |

Para atualizar a VM após um novo build do CI/CD:

```bash
gcloud compute ssh chat-friends --zone=southamerica-east1-a --tunnel-through-iap \
  --command="cd /opt/chat-friends && sudo docker compose pull && sudo docker compose up -d --remove-orphans"
```

---

## 5. Operação, Logs e Troubleshooting

### Consultar logs na VM

```bash
cd /opt/chat-friends

# Todos os serviços
sudo docker compose logs -f --tail=100

# Apenas um serviço específico (app, caddy ou livekit)
sudo docker compose logs -f app
sudo docker compose logs -f caddy
sudo docker compose logs -f livekit
```

### Verificar logs do Startup Script da VM

Caso a inicialização automática tenha falhado durante o primeiro boot da VM:

```bash
sudo journalctl -u google-startup-scripts.service --no-pager
```

### Rotacionar Segredos (Código de Convite, Token DuckDNS ou Segredo LiveKit)

1. Adicione uma nova versão do segredo no GCP Secret Manager:
   ```bash
   printf "NOVO_CODIGO" | gcloud secrets versions add chat-friends-invite-code --data-file=-
   ```
2. Na VM, reexecute o script de inicialização (que recria o `.env` e `livekit.yaml` com a versão `latest` do Secret Manager e recria os contêineres alterados):
   ```bash
   sudo google_metadata_script_runner startup
   ```

### Backup do Banco de Dados SQLite

O banco de dados SQLite fica persistido no host da VM em `/opt/chat-friends/data/sqlite/chatfriends.db` (com modo WAL habilitado):

```bash
# Copiar backup da VM para sua máquina local
gcloud compute scp \
  chat-friends:/opt/chat-friends/data/sqlite/chatfriends.db \
  ./chatfriends-backup.db \
  --zone=southamerica-east1-a \
  --tunnel-through-iap
```

