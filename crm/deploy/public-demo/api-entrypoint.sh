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
trap 'shutdown; exit 0' INT TERM
# Docker restarts exited containers, not processes in an unhealthy container.
# Observe all three children; preserve the failing child's exit status.
while :; do
  for pid in "$api_pid" "$cms_pid" "$lms_pid"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      status=0
      wait "$pid" || status=$?
      shutdown
      # These services must not exit on their own, even with a zero status.
      [ "$status" -ne 0 ] || status=1
      exit "$status"
    fi
  done
  sleep 1
done
