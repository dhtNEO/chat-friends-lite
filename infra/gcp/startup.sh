#!/usr/bin/env bash
set -euo pipefail

echo "========================================="
echo "==> Iniciando Startup Script Chat Friends v2"
echo "========================================="

# 1. Configurar 2 GB de Swap com swappiness = 10 para estabilidade na e2-small
if [ ! -f /swapfile ]; then
    echo "==> Criando swapfile de 2 GB..."
    fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo "/swapfile swap swap defaults 0 0" >> /etc/fstab
    sysctl vm.swappiness=10
    echo "vm.swappiness=10" >> /etc/sysctl.d/99-swap.conf
    echo "==> Swap de 2 GB configurado com sucesso."
fi

# 1.1. Otimizar buffers UDP do Kernel Linux para tráfego WebRTC / LiveKit de baixa latência (60 FPS)
cat <<EOF > /etc/sysctl.d/99-webrtc-udp.conf
net.core.rmem_max=26214400
net.core.wmem_max=26214400
net.core.rmem_default=4194304
net.core.wmem_default=4194304
EOF
sysctl --system || true

# 2. Instalação do Docker e Docker Compose Plugin
if ! command -v docker &> /dev/null; then
    echo "==> Instalando Docker CE..."
    apt-get update -y
    apt-get install -y ca-certificates curl

    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc

    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian \
      $(. /etc/os-release && echo "${VERSION_CODENAME}") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null

    apt-get update -y
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    systemctl enable docker
    systemctl start docker
    echo "==> Docker instalado com sucesso."
fi

# 3. Metadados da Instância e Autenticação no Artifact Registry
REGION=$(curl -s -H "Metadata-Flavor: Google" "http://metadata.google.internal/computeMetadata/v1/instance/zone" | awk -F/ '{print $4}' | sed 's/-[a-z]$//')
DOMAIN=$(curl -s -H "Metadata-Flavor: Google" "http://metadata.google.internal/computeMetadata/v1/instance/attributes/domain" || echo "")
REGISTRY_PREFIX=$(curl -s -H "Metadata-Flavor: Google" "http://metadata.google.internal/computeMetadata/v1/instance/attributes/registry_prefix" || echo "${REGION}-docker.pkg.dev")

echo "==> Autenticando Docker no Google Artifact Registry (${REGION}-docker.pkg.dev)..."
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

# 4. Diretórios de Trabalho e Dados
APP_DIR="/opt/chat-friends"
mkdir -p "${APP_DIR}/data/sqlite" "${APP_DIR}/data/caddy"
chown -R 10001:10001 "${APP_DIR}/data/sqlite"
chmod 700 "${APP_DIR}"

# 5. Consulta aos Segredos no Google Cloud Secret Manager
echo "==> Consultando segredos no GCP Secret Manager..."
DUCKDNS_TOKEN=$(gcloud secrets versions access latest --secret="chat-friends-duckdns-token" 2>/dev/null || echo "")
SERVER_INVITE_CODE=$(gcloud secrets versions access latest --secret="chat-friends-invite-code" 2>/dev/null || echo "")
LIVEKIT_SECRET=$(gcloud secrets versions access latest --secret="chat-friends-livekit-secret" 2>/dev/null || echo "")

LIVEKIT_KEY="devkey"

# 6. Gerar arquivo .env protegido (chmod 600)
cat <<EOF > "${APP_DIR}/.env"
DOMAIN=${DOMAIN}
DUCKDNS_TOKEN=${DUCKDNS_TOKEN}
SERVER_INVITE_CODE=${SERVER_INVITE_CODE}
LIVEKIT_API_KEY=${LIVEKIT_KEY}
LIVEKIT_API_SECRET=${LIVEKIT_SECRET}
REGISTRY_PREFIX=${REGISTRY_PREFIX}
EOF
chmod 600 "${APP_DIR}/.env"

# 7. Gerar arquivo de configuração do LiveKit
cat <<EOF > "${APP_DIR}/livekit.yaml"
port: 7880
bind_addresses:
  - ""

rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 50100
  use_external_ip: true

keys:
  ${LIVEKIT_KEY}: "${LIVEKIT_SECRET}"

logging:
  json: true
  level: info
EOF
chmod 600 "${APP_DIR}/livekit.yaml"

echo "==> Configurações e credenciais gravadas em ${APP_DIR}."

# 8. Inicializar os contêineres caso o compose.yml esteja presente
if [ -f "${APP_DIR}/compose.yml" ]; then
    echo "==> Atualizando e subindo serviços com Docker Compose..."
    cd "${APP_DIR}"
    docker compose pull || true
    docker compose up -d --remove-orphans
    echo "==> Serviços iniciados com sucesso."
fi

echo "==> Startup Script concluído com sucesso."
