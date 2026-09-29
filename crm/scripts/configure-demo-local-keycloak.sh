#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env.local ]; then
  echo "Local .env.local is required. Run ./run-local.sh once to create local Keycloak credentials." >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
. ./.env.local
set +a
unset POSTGRES_PASSWORD KAM_ANNA_PASSWORD KAM_DMITRY_PASSWORD MANAGER_PASSWORD LOCAL_ADMIN_PASSWORD
exec node scripts/configure-local-demo-keycloak.mjs
