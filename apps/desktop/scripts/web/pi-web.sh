#!/bin/sh
# Pi Web 실행 명령 (설계 §5.10). 설치 스크립트(install-termux.sh)가 $PREFIX/bin/pi-web에서 이 파일을 부른다.
#
#   pi-web            서버를 백그라운드로 켜고 브라우저를 연다 (= pi-web start)
#   pi-web run        앞에서 실행 (Ctrl+C로 끈다)
#   pi-web stop | restart | status | url | open | log | update | uninstall | version
#
# 환경 변수: PI_WEB_PORT(기본 8787), PI_WEB_HOST(기본 127.0.0.1), PI_WEB_HOME(기본 ~/.pi-web), PI_WEB_NO_OPEN=1
set -eu

APP_DIR=$(cd "$(dirname "$0")/.." && pwd)
PI_WEB_HOME=${PI_WEB_HOME:-$HOME/.pi-web}
DATA_DIR=${PI_WEB_DATA:-$PI_WEB_HOME/data}
PORT=${PI_WEB_PORT:-8787}
LOG=$DATA_DIR/server.log
PID_FILE=$DATA_DIR/server.pid
URL_FILE=$DATA_DIR/url
export PI_WEB_DATA="$DATA_DIR"

running() {
  [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
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

start() {
  if running; then
    echo "이미 실행 중입니다 (pid $(cat "$PID_FILE"))."
    show_url
    open_url
    return 0
  fi
  mkdir -p "$DATA_DIR"
  rm -f "$URL_FILE"
  wake_lock
  nohup node "$APP_DIR/server.mjs" --port "$PORT" ${PI_WEB_HOST:+--host "$PI_WEB_HOST"} "$@" >>"$LOG" 2>&1 &
  echo $! >"$PID_FILE"
  # 서버가 주소 파일을 쓰면 뜬 것이다
  i=0
  while [ ! -f "$URL_FILE" ]; do
    i=$((i + 1))
    if [ "$i" -gt 100 ] || ! running; then
      echo "서버를 켜지 못했습니다. 기록($LOG)의 끝:" >&2
      tail -n 20 "$LOG" >&2 || true
      rm -f "$PID_FILE"
      exit 1
    fi
    sleep 0.2
  done
  echo "Pi Web을 켰습니다 (pid $(cat "$PID_FILE"))."
  show_url
  open_url
}

stop() {
  if running; then
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
    echo "Pi Web을 껐습니다. 실행 중이던 Pi 세션은 데몬에서 계속 돕니다."
  else
    echo "실행 중이 아닙니다."
  fi
  rm -f "$PID_FILE"
  wake_unlock
}

show_url() {
  if [ -f "$URL_FILE" ]; then
    echo "브라우저 주소: $(cat "$URL_FILE")"
  else
    echo "아직 주소가 없습니다. pi-web start로 켜세요."
  fi
}

cmd=${1:-start}
[ $# -gt 0 ] && shift

case "$cmd" in
  start) start "$@" ;;
  run)
    mkdir -p "$DATA_DIR"
    wake_lock
    exec node "$APP_DIR/server.mjs" --port "$PORT" ${PI_WEB_HOST:+--host "$PI_WEB_HOST"} "$@"
    ;;
  stop) stop ;;
  restart)
    stop
    start "$@"
    ;;
  status)
    if running; then
      echo "실행 중 (pid $(cat "$PID_FILE"))"
      show_url
    else
      echo "꺼져 있습니다."
    fi
    ;;
  url) show_url ;;
  open) open_url ;;
  log | logs) tail -n 100 -f "$LOG" ;;
  update)
    repo=$(cat "$PI_WEB_HOME/repo" 2>/dev/null || true)
    [ -n "$repo" ] || { echo "설치한 저장소를 모릅니다 ($PI_WEB_HOME/repo). 설치 스크립트를 다시 실행하세요." >&2; exit 1; }
    curl -fsSL "https://github.com/$repo/releases/latest/download/install-termux.sh" | bash -s -- "$@"
    ;;
  uninstall)
    stop
    rm -rf "$PI_WEB_HOME/app"
    rm -f "${PREFIX:-$HOME/.local}/bin/pi-web"
    echo "지웠습니다. 토큰·SSH 호스트 등 데이터($DATA_DIR)는 남겨 두었습니다. 함께 지우려면: rm -rf $PI_WEB_HOME"
    ;;
  version | --version | -v) node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version)' "$APP_DIR/package.json" ;;
  help | --help | -h) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//' ;;
  *)
    echo "모르는 명령입니다: $cmd (pi-web help)" >&2
    exit 1
    ;;
esac
