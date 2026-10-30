#!/usr/bin/env bash
# Pi Web 설치 스크립트 — Android Termux에 Pi와 웹 서버를 한 번에 설치하고 켠다 (설계 §5.10, §5.11).
# 묶음에는 Pi Desktop(pi-web)과 Agent(pi-web agent)·Mate(pi-web mate) 웹 버전이 함께 들어 있다.
#
#   curl -fsSL https://github.com/__PI_WEB_REPO__/releases/latest/download/install-termux.sh | bash
#
# 옵션 (bash -s -- <옵션>):
#   --terminal        내장 터미널(Pi /login, 셸)을 쓰도록 node-pty를 빌드한다 (빌드 도구 수백 MB를 받는다)
#   --version vX.Y.Z  그 릴리스를 설치한다 (기본: 최신)
#   --file <경로>     내려받지 않고 가지고 있는 pi-web.tar.gz로 설치한다
#   --no-pi           Pi(@earendil-works/pi-coding-agent)를 설치하지 않는다
#   --no-start        설치만 하고 켜지 않는다
#
# 다시 실행하면 업데이트한다 (데이터·토큰·내장 터미널은 그대로 둔다). Termux가 아닌 Linux에서도 Node 22.19 이상이 있으면 된다.
set -euo pipefail

REPO="${PI_WEB_REPO:-__PI_WEB_REPO__}"
PI_WEB_HOME="${PI_WEB_HOME:-$HOME/.pi-web}"
PI_PACKAGE="@earendil-works/pi-coding-agent"
VERSION="latest"
FILE=""
TERMINAL=0
INSTALL_PI=1
START=1

while [ $# -gt 0 ]; do
  case "$1" in
    --terminal) TERMINAL=1 ;;
    --version) VERSION="$2"; shift ;;
    --file) FILE="$2"; shift ;;
    --no-pi) INSTALL_PI=0 ;;
    --no-start) START=0 ;;
    *) echo "모르는 옵션입니다: $1" >&2; exit 1 ;;
  esac
  shift
done

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m주의: %s\033[0m\n' "$*" >&2; }
fail() { printf '\033[1;31m실패: %s\033[0m\n' "$*" >&2; exit 1; }

TERMUX=0
if [ -n "${TERMUX_VERSION:-}" ] || [ -d /data/data/com.termux/files/usr ]; then TERMUX=1; fi

node_ok() {
  command -v node >/dev/null 2>&1 &&
    node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 19) ? 0 : 1)'
}

# 1. Node.js와 받기 도구
if [ "$TERMUX" = 1 ]; then
  # 먼저 설치된 패키지를 모두 올린다. 일부만 올리면 새 curl이 예전 openssl과 맞지 않아
  # "CANNOT LINK EXECUTABLE curl: cannot locate symbol SSL_…"로 실행되지 않는다 (Termux는 부분 업그레이드를 지원하지 않는다).
  # 설정 파일을 바꿀지 묻는 창이 뜨면 멈추므로, 사용자가 고친 설정은 그대로 둔다(--force-confold).
  step "Termux 패키지 업그레이드 (pkg upgrade)"
  export DEBIAN_FRONTEND=noninteractive
  pkg upgrade -y -o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef
  step "Termux 패키지 설치 (Node.js LTS, curl, tar)"
  packages="curl tar"
  # 이미 맞는 Node가 있으면(nodejs 패키지 등) 그대로 쓴다. nodejs와 nodejs-lts는 함께 설치할 수 없다.
  node_ok || packages="nodejs-lts $packages"
  # shellcheck disable=SC2086
  pkg install -y -o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef $packages
fi
node_ok || fail "Node.js 22.19 이상이 필요합니다. Termux라면: pkg install nodejs-lts"
echo "Node $(node --version)"

# 2. Pi
if [ "$INSTALL_PI" = 1 ]; then
  if command -v pi >/dev/null 2>&1; then
    echo "Pi가 이미 설치되어 있습니다 ($(command -v pi)). 업데이트는 화면의 Pi 관리 창에서 합니다."
  else
    step "Pi 설치 (npm install -g $PI_PACKAGE)"
    npm install -g "$PI_PACKAGE"
  fi
fi

# 3. 웹 묶음 받기
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
if [ -n "$FILE" ]; then
  [ -f "$FILE" ] || fail "파일이 없습니다: $FILE"
  cp "$FILE" "$work/pi-web.tar.gz"
else
  case "$REPO" in *__PI_WEB_REPO*) fail "릴리스 저장소를 모릅니다. PI_WEB_REPO=owner/repo를 주거나 --file을 쓰세요." ;; esac
  if [ "$VERSION" = latest ]; then
    url="https://github.com/$REPO/releases/latest/download/pi-web.tar.gz"
  else
    url="https://github.com/$REPO/releases/download/$VERSION/pi-web.tar.gz"
  fi
  step "Pi Web 받기 ($url)"
  curl -fL --retry 3 -o "$work/pi-web.tar.gz" "$url"
fi
tar -xzf "$work/pi-web.tar.gz" -C "$work"
[ -f "$work/pi-web/server.mjs" ] || fail "묶음 안에 server.mjs가 없습니다"

# 4. 바꿔 넣기: 켜져 있는 서버(Pi Desktop·Agent·Mate)는 끄고 설치 뒤 다시 켠다. 전에 빌드한 node-pty(node_modules)는 옮겨 온다
step "설치 ($PI_WEB_HOME/app)"
mkdir -p "$PI_WEB_HOME"
was_running=""
for app in desktop agent mate; do
  case "$app" in
    desktop) pid_file="$PI_WEB_HOME/data/server.pid" ;;
    *) pid_file="$PI_WEB_HOME/$app/server.pid" ;;
  esac
  if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    was_running="$was_running $app"
    if [ "$app" = desktop ]; then
      # 예전 실행 명령(v0.1.12까지)은 앱 이름을 모른다. Pi Desktop은 이름 없이 끈다
      PI_WEB_HOME="$PI_WEB_HOME" sh "$PI_WEB_HOME/app/bin/pi-web" stop || true
    elif [ -f "$PI_WEB_HOME/app/bin/pi-web" ]; then
      PI_WEB_HOME="$PI_WEB_HOME" sh "$PI_WEB_HOME/app/bin/pi-web" "$app" stop || true
    else
      kill "$(cat "$pid_file")" 2>/dev/null || true
    fi
  fi
done
if [ -d "$PI_WEB_HOME/app/node_modules" ]; then mv "$PI_WEB_HOME/app/node_modules" "$work/pi-web/node_modules"; fi
rm -rf "$PI_WEB_HOME/app.old"
if [ -d "$PI_WEB_HOME/app" ]; then mv "$PI_WEB_HOME/app" "$PI_WEB_HOME/app.old"; fi
mv "$work/pi-web" "$PI_WEB_HOME/app"
rm -rf "$PI_WEB_HOME/app.old"
echo "$REPO" >"$PI_WEB_HOME/repo"

# 5. 내장 터미널 (선택): node-pty는 네이티브 모듈이라 Android용 미리 빌드된 파일이 없어 여기서 빌드한다
if [ "$TERMINAL" = 1 ]; then
  step "내장 터미널 준비 (node-pty 빌드)"
  if [ "$TERMUX" = 1 ]; then
    pkg install -y -o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef python make clang binutils
    # Termux의 node-gyp는 android_ndk_path 변수가 없다고 실패한다. 빈 값을 정해 둔다.
    mkdir -p "$HOME/.gyp"
    [ -f "$HOME/.gyp/include.gypi" ] || echo "{'variables':{'android_ndk_path':''}}" >"$HOME/.gyp/include.gypi"
  fi
  if (cd "$PI_WEB_HOME/app" && npm install --no-save --no-package-lock --no-audit --no-fund node-pty@1.1.0); then
    echo "내장 터미널을 쓸 수 있습니다."
  else
    warn "node-pty를 빌드하지 못했습니다. 터미널 말고 다른 기능은 그대로 쓸 수 있습니다."
  fi
fi

# 6. pi-web 명령
if [ "$TERMUX" = 1 ]; then bin_dir="$PREFIX/bin"; else bin_dir="$HOME/.local/bin"; fi
mkdir -p "$bin_dir"
cat >"$bin_dir/pi-web" <<EOF
#!$(command -v sh)
# Pi Web 실행 명령 (install-termux.sh가 만듦)
PI_WEB_HOME="\${PI_WEB_HOME:-$PI_WEB_HOME}" exec sh "$PI_WEB_HOME/app/bin/pi-web" "\$@"
EOF
chmod 755 "$bin_dir/pi-web"
case ":$PATH:" in *":$bin_dir:"*) ;; *) warn "$bin_dir가 PATH에 없습니다. 셸 설정에 추가하세요." ;; esac

step "완료: Pi Web $(sh "$PI_WEB_HOME/app/bin/pi-web" version)"
cat <<'EOF'
  pi-web          Pi Desktop을 켜고 브라우저를 엽니다 (주소는 pi-web url)
  pi-web agent    Pi Desktop Agent를 켭니다 (승인·지식베이스·스킬·예약 작업)
  pi-web mate     Pi Desktop Mate를 켭니다 (임무 시간표·인박스·텔레그램)
  pi-web all      세 앱을 모두 켭니다
  pi-web stop     서버를 끕니다 (Pi 세션은 계속 돕니다. agent·mate·all도 같다: pi-web mate stop)
  pi-web update   최신 버전으로 업데이트합니다

휴대폰이 Termux를 멈추지 않게 하려면 (갤럭시 기준):
  - 설정 → 애플리케이션 → Termux → 배터리 → "제한 없음"
  - 개발자 옵션 → "하위 프로세스 제한 사용 중지" 켜기 (Android 14 이상)
  - 알림 창의 Termux 알림에서 "Acquire wakelock" (pi-web이 자동으로 걸어 둡니다)
LLM 로그인: 화면의 "프로바이더"에서 API 키를 넣습니다. OAuth 로그인(/login)은 --terminal로 설치하면 내장 터미널에서 됩니다.
EOF

if [ -n "$was_running" ]; then
  # 업데이트: 켜져 있던 것만 다시 켠다 (브라우저는 Pi Desktop이 켜져 있었으면 그것만 연다)
  for app in $was_running; do
    # 하나를 켜지 못해도 나머지는 켠다
    if [ "$app" = desktop ]; then
      sh "$PI_WEB_HOME/app/bin/pi-web" desktop start || warn "Pi Web을 다시 켜지 못했습니다 (pi-web log)"
    else
      PI_WEB_NO_OPEN=1 sh "$PI_WEB_HOME/app/bin/pi-web" "$app" start || warn "pi-web $app을 다시 켜지 못했습니다 (pi-web $app log)"
    fi
  done
elif [ "$START" = 1 ]; then
  sh "$PI_WEB_HOME/app/bin/pi-web" start
fi
