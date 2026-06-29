#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."

OUTDIR=~/Documents/WGF/db-exports/$(date +%Y%m%d)
mkdir -p "$OUTDIR"
LOG="$OUTDIR/export.log"
: > "$LOG"

PROD_PW=$(grep '^PRODUCTION_DB_PASSWORD=' .env | cut -d= -f2-)
STAG_PW=$(grep '^STAGING_DB_PASSWORD=' .env | cut -d= -f2-)

DUMP_FLAGS="--ssl-mode=REQUIRED --single-transaction --quick --routines --triggers --events --set-gtid-purged=OFF --no-tablespaces --default-character-set=utf8mb4 --hex-blob"

log(){ echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

# args: <env> <port> <pw> <dbname> <outfile>
dump_db(){
  local env=$1 port=$2 pw=$3 db=$4 out=$5
  log "START $env/$db -> $(basename "$out")"
  MYSQL_PWD="$pw" mysqldump --host=127.0.0.1 --port="$port" --user=root \
    $DUMP_FLAGS --databases "$db" 2>"$out.err" | gzip > "$out"
  local rc=${PIPESTATUS[0]}
  if [ "$rc" -ne 0 ]; then log "FAIL $env/$db rc=$rc : $(cat "$out.err")"; return 1; fi
  if ! gunzip -t "$out" 2>/dev/null; then log "FAIL $env/$db gzip corrupt"; return 1; fi
  if ! gunzip -c "$out" | tail -5 | grep -q "Dump completed"; then log "FAIL $env/$db no Dump-completed trailer"; return 1; fi
  log "OK   $env/$db size=$(ls -lh "$out" | awk '{print $5}')"
  rm -f "$out.err"
}

dump_db production 23308 "$PROD_PW" strapi               "$OUTDIR/prod_strapi.sql.gz"
dump_db production 23308 "$PROD_PW" model_db             "$OUTDIR/prod_model_db.sql.gz"
dump_db staging    23307 "$STAG_PW" strapi               "$OUTDIR/staging_strapi.sql.gz"
dump_db staging    23307 "$STAG_PW" wegetfunded-staging  "$OUTDIR/staging_wegetfunded-staging.sql.gz"
dump_db staging    23307 "$STAG_PW" model_db             "$OUTDIR/staging_model_db.sql.gz"

log "ALL DONE"
echo "=== MANIFEST ===" | tee -a "$LOG"
ls -lh "$OUTDIR"/*.sql.gz | tee -a "$LOG"
