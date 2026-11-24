#!/usr/bin/env bash
# Runs all migrations + SQL tests against a throw-away local PostgreSQL cluster.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
WORK="$(mktemp -d)"
PORT="${PGPORT_TEST:-55432}"
cleanup() { "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

RUNAS=""
if [ "$(id -u)" = "0" ]; then
  chown -R postgres "$WORK"; RUNAS="sudo -u postgres"
  command -v sudo >/dev/null || RUNAS="su postgres -c"
fi
run() { if [ -n "$RUNAS" ]; then $RUNAS "$@"; else "$@"; fi; }

run "$PGBIN/initdb" -D "$WORK/data" -U postgres -A trust >/dev/null
run "$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses=''" -l "$WORK/log" start -w >/dev/null
PSQL=(psql -h "$WORK" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q -X)
"${PSQL[@]}" -c "create database app" >/dev/null
"${PSQL[@]}" -d app -f "$ROOT/supabase/tests/00_bootstrap.sql" >/dev/null
for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "migrate: $(basename "$f")"
  "${PSQL[@]}" -d app -f "$f" >/dev/null
done
"${PSQL[@]}" -d app -f "$ROOT/supabase/seed.sql" >/dev/null 2>&1 || true
for t in "$ROOT"/supabase/tests/[1-9]*.sql; do
  echo "test:    $(basename "$t")"
  "${PSQL[@]}" -d app -f "$t"
done
if [ -x "$ROOT/supabase/tests/concurrency.sh" ]; then
  echo "test:    concurrency.sh"
  PSQL_CMD="${PSQL[*]} -d app" bash "$ROOT/supabase/tests/concurrency.sh"
fi
echo "ALL DATABASE TESTS PASSED"
