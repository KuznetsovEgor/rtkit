#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v docker-compose >/dev/null 2>&1 && ! docker compose version >/dev/null 2>&1; then
  echo "Нужен Docker Compose. Установите Compose plugin или docker-compose и повторите ./run-local.sh." >&2
  exit 1
fi

if [ ! -f .env.local ]; then
  random_secret() { openssl rand -hex 24; }
  cat > .env.local <<EOF
POSTGRES_PASSWORD=$(random_secret)
KC_ADMIN_USER=local-admin
KC_ADMIN_PASSWORD=$(random_secret)
KAM_ANNA_PASSWORD=$(random_secret)
KAM_DMITRY_PASSWORD=$(random_secret)
MANAGER_PASSWORD=$(random_secret)
LOCAL_ADMIN_PASSWORD=$(random_secret)
EOF
  chmod 600 .env.local
fi
chmod 600 .env.local
set -a
# shellcheck disable=SC1091
. ./.env.local
set +a
export DATABASE_URL="postgres://lctcrm:${POSTGRES_PASSWORD}@127.0.0.1:54329/lctcrm"
export OIDC_ISSUER="http://localhost:18080/realms/lct"
export OIDC_JWKS_URL="http://localhost:18080/realms/lct/protocol/openid-connect/certs"
export KEYCLOAK_URL="http://localhost:18080"
export VITE_API_URL="http://localhost:3001"
export VITE_KEYCLOAK_URL="http://localhost:18080"
export CRM_EXCHANGE_CMS_URL="http://127.0.0.1:3101"
export CRM_EXCHANGE_LMS_URL="http://127.0.0.1:3102"
export WEB_ORIGIN="http://localhost:5173"
export API_PORT=3001
export API_HOST=127.0.0.1
export CMS_MOCK_PORT=3101
export LMS_MOCK_PORT=3102

# Vite switches to the next free port by default, which would make the printed
# address and Keycloak redirect URI incorrect. Fail before starting duplicates.
node scripts/check-local-ports.mjs

if command -v docker-compose >/dev/null 2>&1; then
  docker-compose -f infra/docker-compose.yml up -d
else
  docker compose -f infra/docker-compose.yml up -d
fi

npm install
npm run db:migrate
node scripts/provision-keycloak.mjs
node scripts/configure-keycloak-theme.mjs
unset KC_ADMIN_USER KC_ADMIN_PASSWORD KAM_ANNA_PASSWORD KAM_DMITRY_PASSWORD MANAGER_PASSWORD LOCAL_ADMIN_PASSWORD
printf '\nCRM:       http://localhost:5173\nAPI:       http://localhost:3001/docs\nKeycloak:  http://localhost:18080\n\nЛокальные учётные записи: kam.anna, kam.dmitry, manager, admin.\nПароли сохранены только в crm/.env.local (права доступа: владелец файла).\nОстановить приложение: Ctrl+C; контейнеры сохраняют данные при перезапуске.\n\n'
npm run dev
