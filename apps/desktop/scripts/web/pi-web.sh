#!/bin/sh
# Pi Web 실행 명령 (설계 §5.10, §5.11). 설치 스크립트(install-termux.sh)가 $PREFIX/bin/pi-web에서 이 파일을 부른다.
#
#   pi-web [앱] [명령]
#
# 앱:   (없음)  Pi Desktop  — Pi 관리·로그인·채팅 (포트 8787)
#       agent   Pi Desktop Agent — 승인·지식베이스·스킬·예약 작업 (포트 8788)
#       mate    Pi Desktop Mate — 임무 시간표·인박스·텔레그램 (포트 8789)
#       all     세 앱 모두 (start·stop·restart·status)
# 명령: start(기본: 켜고 브라우저를 연다) | run(앞에서 실행) | stop | restart | status | url | open | log
#       update | uninstall | version (앱과 상관없이 묶음 전체)
#
# 환경 변수: PI_WEB_PORT(앱마다 기본값), PI_WEB_HOST(기본 127.0.0.1), PI_WEB_HOME(기본 ~/.pi-web), PI_WEB_NO_OPEN=1
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PI_WEB_HOME=${PI_WEB_HOME:-$HOME/.pi-web}
export PI_WEB_HOME

# 앱을 고른다: 서버 폴더, 데이터 폴더, 포트, 이름
use_app() {
  case "$1" in
    desktop)
      APP_DIR=$ROOT
      DATA_DIR=$PI_WEB_HOME/data
      DEFAULT_PORT=8787
      NAME="Pi Web"
      ;;
    agent)
      APP_DIR=$ROOT/agent
      DATA_DIR=$PI_WEB_HOME/agent
      DEFAULT_PORT=8788
      NAME="Pi Agent Web"
      ;;
    mate)
      APP_DIR=$ROOT/mate
      DATA_DIR=$PI_WEB_HOME/mate
      DEFAULT_PORT=8789
      NAME="Pi Mate Web"
      ;;
  esac
  APP=$1
  PORT=${PI_WEB_PORT:-$DEFAULT_PORT}
  LOG=$DATA_DIR/server.log
  PID_FILE=$DATA_DIR/server.pid
  URL_FILE=$DATA_DIR/url
}

running() {
  [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

any_running() {
  for a in desktop agent mate; do
    use_app "$a"
    if running; then return 0; fi
  done
  return 1
}

# Termux가 화면이 꺼진 뒤에도 서버를 멈추지 않게 한다 (Termux:API 앱 없이도 된다)
wake_lock() {
  if command -v termux-wake-lock >/dev/null 2>&1; then termux-wake-lock || true; fi
}

wake_unlock() {
  if command -v termux-wake-unlock >/dev/null 2>&1; then termux-wake-unlock || true; fi
}

open_url() {
  [ -n "${PI_WEB_NO_OPEN:-}" ] && return 0
  [ -f "$URL_FILE" ] || return 0
  url=$(cat "$URL_FILE")
  if command -v termux-open-url >/dev/null 2>&1; then
    termux-open-url "$url" || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 || true
  fi
}

show_url() {
  if [ -f "$URL_FILE" ]; then
    echo "$NAME 주소: $(cat "$URL_FILE")"
  else
    if [ "$APP" = desktop ]; then hint="pi-web start"; else hint="pi-web $APP start"; fi
    echo "$NAME: 아직 주소가 없습니다. $hint로 켜세요."
  fi
}

start() {
  if [ ! -f "$APP_DIR/server.mjs" ]; then
    echo "$NAME이(가) 이 묶음에 없습니다. pi-web update로 업데이트하세요." >&2
    exit 1
  fi
  if running; then
    echo "$NAME: 이미 실행 중입니다 (pid $(cat "$PID_FILE"))."
    show_url
    open_url
    return 0
  fi
  mkdir -p "$DATA_DIR"
  rm -f "$URL_FILE"
  wake_lock
  PI_WEB_DATA="$DATA_DIR" nohup node "$APP_DIR/server.mjs" --port "$PORT" ${PI_WEB_HOST:+--host "$PI_WEB_HOST"} "$@" >>"$LOG" 2>&1 &
  echo $! >"$PID_FILE"
  # 서버가 주소 파일을 쓰면 뜬 것이다
  i=0
  while [ ! -f "$URL_FILE" ]; do
    i=$((i + 1))
    if [ "$i" -gt 150 ] || ! running; then
      echo "$NAME을(를) 켜지 못했습니다. 기록($LOG)의 끝:" >&2
      tail -n 20 "$LOG" >&2 || true
      rm -f "$PID_FILE"
      exit 1
    fi
    sleep 0.2
  done
  echo "$NAME을(를) 켰습니다 (pid $(cat "$PID_FILE"))."
  show_url
  open_url
}

stop() {
  if running; then
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
    case "$APP" in
      mate) echo "$NAME을(를) 껐습니다. Mate 실행기는 계속 돌며 임무 시간표를 지킵니다." ;;
      *) echo "$NAME을(를) 껐습니다. 실행 중이던 Pi 세션은 데몬에서 계속 돕니다." ;;
    esac
  else
    echo "$NAME: 실행 중이 아닙니다."
  fi
  rm -f "$PID_FILE"
  any_running || wake_unlock
}

status() {
  if running; then
    echo "$NAME: 실행 중 (pid $(cat "$PID_FILE"))"
    show_url
  else
    echo "$NAME: 꺼져 있습니다."
  fi
}

# 앱 이름이 먼저 오면 그 앱. 없으면 Pi Desktop
target=desktop
case "${1:-}" in
  agent | mate | all | desktop)
    target=$1
    shift
    ;;
esac
cmd=${1:-start}
[ $# -gt 0 ] && shift

if [ "$target" = all ]; then
  case "$cmd" in
    start | stop | restart | status | url)
      for a in desktop agent mate; do
        # 브라우저는 Pi Desktop 하나만 연다
        if [ "$a" = desktop ]; then sh "$0" "$a" "$cmd" "$@"; else PI_WEB_NO_OPEN=1 sh "$0" "$a" "$cmd" "$@"; fi
      done
      exit 0
      ;;
    *)
      echo "all과 함께 쓰는 명령은 start·stop·restart·status·url입니다." >&2
      exit 1
      ;;
  esac
fi

use_app "$target"

case "$cmd" in
  start) start "$@" ;;
  run)
    mkdir -p "$DATA_DIR"
    wake_lock
    PI_WEB_DATA="$DATA_DIR" exec node "$APP_DIR/server.mjs" --port "$PORT" ${PI_WEB_HOST:+--host "$PI_WEB_HOST"} "$@"
    ;;
  stop) stop ;;
  restart)
    stop
    start "$@"
    ;;
  status) status ;;
  url) show_url ;;
  open) open_url ;;
  log | logs) tail -n 100 -f "$LOG" ;;
  update)
    repo=$(cat "$PI_WEB_HOME/repo" 2>/dev/null || true)
    [ -n "$repo" ] || { echo "설치한 저장소를 모릅니다 ($PI_WEB_HOME/repo). 설치 스크립트를 다시 실행하세요." >&2; exit 1; }
    curl -fsSL "https://github.com/$repo/releases/latest/download/install-termux.sh" | bash -s -- "$@"
    ;;
  uninstall)
    for a in desktop agent mate; do
      use_app "$a"
      if running; then stop; fi
    done
    # Mate 실행기는 서버와 따로 돈다. 지우기 전에 멈춘다
    runner=$ROOT/mate/resources/mate-runner/mate-runner.mjs
    if [ -f "$runner" ]; then node "$runner" stop >/dev/null 2>&1 || true; fi
    rm -rf "$PI_WEB_HOME/app"
    rm -f "${PREFIX:-$HOME/.local}/bin/pi-web"
    echo "지웠습니다. 토큰·SSH 호스트 등 데이터($PI_WEB_HOME/data, agent, mate)는 남겨 두었습니다. 함께 지우려면: rm -rf $PI_WEB_HOME"
    ;;
  version | --version | -v) node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version)' "$ROOT/package.json" ;;
  help | --help | -h) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//' ;;
  *)
    echo "모르는 명령입니다: $cmd (pi-web help)" >&2
    exit 1
    ;;
esac
