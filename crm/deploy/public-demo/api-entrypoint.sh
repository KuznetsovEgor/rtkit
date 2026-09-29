#!/bin/sh
set -eu

node api/dist/db/migrate.js
node api/dist/mock-cms.js &
cms_pid=$!
node api/dist/mock-lms.js &
lms_pid=$!
node api/dist/main.js &
api_pid=$!

shutdown() {
  kill -TERM "$api_pid" "$cms_pid" "$lms_pid" 2>/dev/null || true
  wait "$api_pid" "$cms_pid" "$lms_pid" 2>/dev/null || true
}
trap shutdown INT TERM
status=0
wait "$api_pid" || status=$?
shutdown
exit "$status"
