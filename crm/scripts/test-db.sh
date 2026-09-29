#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -f .env.local ]; then
  echo "Сначала запустите ./run-local.sh: он создаст базу и локальную конфигурацию." >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
. ./.env.local
set +a
node scripts/ensure-test-database.mjs
export DATABASE_URL="postgres://lctcrm:${POSTGRES_PASSWORD}@127.0.0.1:54329/lctcrm_integration"
export CRM_INTEGRATION=1
export NODE_ENV=test
test_storage_root="$(mktemp -d "${TMPDIR:-/tmp}/lct-crm-integration-XXXXXX")"
trap 'rm -rf -- "$test_storage_root"' EXIT
export CRM_IMPORT_STORAGE="$test_storage_root/imports"
export CRM_DOCUMENT_STORAGE="$test_storage_root/documents"
export CRM_REPORT_STORAGE="$test_storage_root/reports"
export CRM_MOCK_STATE_DIR="$test_storage_root/mock-state"
npm run db:migrate
node --import tsx --test api/test/*.integration.test.ts
