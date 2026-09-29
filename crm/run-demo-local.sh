#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env.local ]; then
  echo "Local .env.local is required. Run ./run-local.sh once to create local PostgreSQL and Keycloak credentials." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env.local
set +a
if [ -z "${POSTGRES_PASSWORD:-}" ]; then
  echo "POSTGRES_PASSWORD is missing from local .env.local." >&2
  exit 1
fi

export CRM_DEMO_MODE=1
export DATABASE_URL="postgres://lctcrm:${POSTGRES_PASSWORD}@127.0.0.1:54329/lctcrm_demo"
export OIDC_ISSUER="http://localhost:18080/realms/lct"
export OIDC_JWKS_URL="http://localhost:18080/realms/lct/protocol/openid-connect/certs"
export API_PORT=3003
export API_HOST=127.0.0.1
export WEB_PORT=5174
export WEB_ORIGIN="http://localhost:5174"
export VITE_API_URL="http://localhost:3003"
export VITE_KEYCLOAK_URL="http://localhost:18080"
export CRM_EXCHANGE_CMS_URL="http://127.0.0.1:3103"
export CRM_EXCHANGE_LMS_URL="http://127.0.0.1:3104"
export CMS_MOCK_PORT=3103
export LMS_MOCK_PORT=3104
export CRM_MOCK_STATE_DIR="./.local-storage/demo/mock-state"
export CRM_DOCUMENT_STORAGE="./.local-storage/demo/documents"
export CRM_IMPORT_STORAGE="./.local-storage/demo/imports"
export CRM_REPORT_STORAGE="./.local-storage/demo/reports"

unset KC_ADMIN_USER KC_ADMIN_PASSWORD KAM_ANNA_PASSWORD KAM_DMITRY_PASSWORD MANAGER_PASSWORD LOCAL_ADMIN_PASSWORD
node scripts/check-demo-local-ports.mjs
printf '\nSynthetic demo: http://localhost:5174\nDemo API:      http://localhost:3003/docs\nDemo mocks:    http://localhost:3103 and http://localhost:3104\n\nStop this instance with Ctrl+C. The existing app on 5173/3001 is not stopped.\n\n'
exec npm run dev:demo
