#!/usr/bin/env bash
# Docker가 없는 환경용 로컬 PostgreSQL.
# examples/testbed/.pgdata/ 에 클러스터를 만들고 포트 5432로 띄운다.
#
#   bash scripts/db-local.sh init    # 클러스터 생성 + postgres/postgres 사용자 + testbed DB
#   bash scripts/db-local.sh start   # 서버 시작 (초기화 안 됐으면 init 먼저)
#   bash scripts/db-local.sh stop    # 서버 중지
#   bash scripts/db-local.sh status  # 상태
#
# 소켓 디렉토리는 .pgdata/run (기본 /var/run/postgresql 은 권한 문제가 난다).
# root로 실행하면 initdb·postgres가 거부하므로 비루트 사용자로 전환을 시도한다.
set -euo pipefail

TESTBED_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGDATA="${PGDATA:-$TESTBED_DIR/.pgdata}"
PGSOCK="$PGDATA/run"
PGPORT="${PGPORT:-5432}"
PGUSER_NAME="postgres"
PGPASS="postgres"
PGDB="testbed"
LOGFILE="$PGDATA/server.log"

# --- PostgreSQL 바이너리 탐색 -------------------------------------------------
find_pgbin() {
  if [ -n "${PGBIN:-}" ] && [ -x "$PGBIN/pg_ctl" ]; then
    echo "$PGBIN"
    return
  fi
  if [ -x /usr/lib/postgresql/16/bin/pg_ctl ]; then
    echo /usr/lib/postgresql/16/bin
    return
  fi
  local candidate
  candidate="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | tail -1 || true)"
  if [ -n "$candidate" ] && [ -x "$candidate/pg_ctl" ]; then
    echo "$candidate"
    return
  fi
  if command -v pg_ctl >/dev/null 2>&1; then
    dirname "$(command -v pg_ctl)"
    return
  fi
  echo "db-local: PostgreSQL 바이너리를 찾지 못했다 (/usr/lib/postgresql/*/bin 또는 PATH의 pg_ctl)." >&2
  echo "          apt install postgresql-16 또는 PGBIN=/path/to/bin 으로 지정한다." >&2
  exit 1
}

PGBIN="$(find_pgbin)"

# --- root 회피 ------------------------------------------------------------------
# initdb·postgres는 root 실행을 거부한다. root면 비루트 사용자로 자기 자신을 다시 실행한다.
#   1) 시스템에 postgres 사용자가 있고 su가 있으면 그 사용자로
#   2) 아니면 명확히 실패하고 안내한다
reexec_as_nonroot() {
  if [ "$(id -u)" -ne 0 ]; then
    return
  fi
  if [ -n "${DB_LOCAL_REEXEC:-}" ]; then
    echo "db-local: 비루트 전환 후에도 root다. 중단한다." >&2
    exit 1
  fi
  local target_user=""
  if id -u postgres >/dev/null 2>&1; then
    target_user="postgres"
  elif [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
    target_user="$SUDO_USER"
  fi
  if [ -z "$target_user" ] || ! command -v su >/dev/null 2>&1; then
    cat >&2 <<EOF
db-local: root로 실행 중이다. PostgreSQL의 initdb/postgres는 root 실행을 거부한다.
          전환할 비루트 사용자(postgres 또는 \$SUDO_USER)를 찾지 못했다.
          해결: 비루트 사용자로 실행하거나, 'useradd -m pg' 뒤 'su pg -c "bash $0 $*"' 로 실행한다.
EOF
    exit 1
  fi
  echo "db-local: root다 → '$target_user' 사용자로 전환해 다시 실행한다."
  mkdir -p "$PGDATA"
  chown -R "$target_user" "$PGDATA"
  # 작업 디렉토리(worktree)가 다른 사용자 소유여도 스크립트 자체는 읽기만 하면 된다
  exec su "$target_user" -s /bin/bash -c \
    "DB_LOCAL_REEXEC=1 PGDATA='$PGDATA' PGPORT='$PGPORT' PGBIN='$PGBIN' bash '${BASH_SOURCE[0]}' $*"
}

# --- 명령 ------------------------------------------------------------------------
is_initialized() { [ -f "$PGDATA/PG_VERSION" ]; }

is_running() {
  "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1
}

cmd_init() {
  if is_initialized; then
    echo "db-local: 이미 초기화돼 있다 ($PGDATA)."
    return
  fi
  echo "db-local: initdb → $PGDATA"
  # initdb는 비어 있지 않은 디렉토리를 거부하므로 로그는 임시 파일에 받았다가 옮긴다
  mkdir -p "$PGDATA"
  local initdb_log
  initdb_log="$(mktemp)"
  "$PGBIN/initdb" -D "$PGDATA" -U "$PGUSER_NAME" --auth=trust --encoding=UTF8 --no-locale >"$initdb_log" 2>&1 \
    || { tail -20 "$initdb_log" >&2; rm -f "$initdb_log"; exit 1; }
  mv "$initdb_log" "$PGDATA/initdb.log"
  mkdir -p "$PGSOCK"
  {
    echo "port = $PGPORT"
    echo "unix_socket_directories = '$PGSOCK'"
    echo "listen_addresses = 'localhost'"
  } >>"$PGDATA/postgresql.conf"

  # 비밀번호 설정 + DB 생성은 서버를 잠깐 띄워서 한다
  "$PGBIN/pg_ctl" -D "$PGDATA" -l "$LOGFILE" -w start
  "$PGBIN/psql" -h "$PGSOCK" -p "$PGPORT" -U "$PGUSER_NAME" -d postgres -v ON_ERROR_STOP=1 -q \
    -c "ALTER USER $PGUSER_NAME WITH PASSWORD '$PGPASS';"
  if ! "$PGBIN/psql" -h "$PGSOCK" -p "$PGPORT" -U "$PGUSER_NAME" -d postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname = '$PGDB'" | grep -q 1; then
    "$PGBIN/createdb" -h "$PGSOCK" -p "$PGPORT" -U "$PGUSER_NAME" "$PGDB"
  fi
  "$PGBIN/pg_ctl" -D "$PGDATA" -w stop
  echo "db-local: 완료. DATABASE_URL=postgresql://$PGUSER_NAME:$PGPASS@localhost:$PGPORT/$PGDB"
}

cmd_start() {
  is_initialized || cmd_init
  if is_running; then
    echo "db-local: 이미 실행 중이다."
    return
  fi
  mkdir -p "$PGSOCK"
  "$PGBIN/pg_ctl" -D "$PGDATA" -l "$LOGFILE" -w start
  echo "db-local: 시작했다. 포트 $PGPORT, 로그 $LOGFILE"
}

cmd_stop() {
  if ! is_running; then
    echo "db-local: 실행 중이 아니다."
    return
  fi
  "$PGBIN/pg_ctl" -D "$PGDATA" -w stop
  echo "db-local: 중지했다."
}

cmd_status() {
  echo "db-local: PGBIN=$PGBIN PGDATA=$PGDATA port=$PGPORT"
  if ! is_initialized; then
    echo "db-local: 초기화 안 됨 (init 필요)."
    return 3
  fi
  "$PGBIN/pg_ctl" -D "$PGDATA" status
}

usage() {
  echo "사용법: bash scripts/db-local.sh init|start|stop|status" >&2
  exit 2
}

[ $# -ge 1 ] || usage
case "$1" in
  init|start|stop) reexec_as_nonroot "$@"; "cmd_$1" ;;
  status) if [ "$(id -u)" -eq 0 ] && [ -d "$PGDATA" ]; then reexec_as_nonroot "$@"; fi; cmd_status ;;
  *) usage ;;
esac
