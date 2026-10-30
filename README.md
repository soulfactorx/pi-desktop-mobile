# Pi Desktop 모노레포

[Pi coding agent](https://pi.dev)를 **포크하지 않고**, 설치된 `pi` 그대로 엔진으로 쓰는 데스크톱 앱 세 개를 담은 저장소입니다.
Pi를 업데이트하면 세 앱도 그대로 따라갑니다.

## 앱

| 앱 | 하는 일 | 설명서 | 설계 | 릴리스 태그 |
|---|---|---|---|---|
| **Pi Desktop** | 설치된 Pi를 GUI로 쓴다. 채팅, 여러 프로젝트 탭, 로컬·WSL·SSH 호스트, Pi 설치·로그인·모델 관리, 리소스·Marketplace | [apps/desktop](apps/desktop/README.md) | [DESIGN.md](docs/DESIGN.md) | `v*` |
| **Pi Desktop Agent** | Pi를 엔진으로 쓰는 데스크톱 에이전트. 승인, 지식베이스, 스킬, 예약 작업, 다른 사람의 에이전트와 연결 | [apps/agent](apps/agent/README.md) | [DESIGN-AGENT.md](docs/DESIGN-AGENT.md) | `agent-v*` |
| **Pi Desktop Mate** | 묻기 전에 먼저 살펴보고 알려 주는 능동형 코딩 동료. 임무 시간표, 인박스, 별도 작업 공간에서 고치기, 텔레그램 | [apps/mate](apps/mate/README.md) | [DESIGN-MATE.md](docs/DESIGN-MATE.md) | `mate-v*` |

세 앱은 따로 설치하고 따로 업데이트합니다. Pi Desktop은 Pi를 GUI로 쓰는 놀이터, Agent는 혼자 쓰는 커스텀 Pi, Mate는 개인 데이터를 먼저 챙기는 Pi 기반 비서입니다. 함께 쓰는 것과 나눠 쓰는 것은 다음과 같습니다 (자세히는 [DESIGN-APPS.md](docs/DESIGN-APPS.md)).

- **함께 씀**: Pi 설치본, 로그인, 모델·프로바이더 설정(`~/.pi/agent`의 `auth.json`·`models.json`·`settings.json`). 로그인과 모델은 Pi Desktop에서 한 번 하면 다른 두 앱도 씁니다. Agent·Mate는 Pi 관리 화면을 따로 두지 않고, Pi가 없으면 Pi Desktop을 열거나 설치하라고 안내합니다.
- **나눠 씀**: 세션, 스킬·프롬프트·확장, MCP 서버, 사용자 지침(`AGENTS.md`), 기억·권한·작업 같은 앱 데이터, 휴지통·아카이브. Pi Desktop은 Pi의 기본 폴더(`~/.pi/agent`)를 그대로 쓰고, Agent는 `~/.pi-desktop-agent`, Mate는 `~/.pi-desktop-mate`에 둡니다. 데몬·실행기, 릴리스 태그, 개발 실행의 mock LLM 포트도 나눕니다.
- **어디서 도는가**: 앱은 클라이언트이고, 실제로 도는 곳은 Pi가 설치된 호스트(로컬·WSL·SSH)입니다. Pi Desktop은 이미 그렇고, Agent·Mate도 같은 구조로 옮기는 중입니다.

## 구성

```
apps/
  desktop/              Pi Desktop (Electron: main · preload · React 렌더러)
  agent/                Pi Desktop Agent (Electron, Pi Desktop의 연결·채팅 모듈을 복사해 씀)
  mate/                 Pi Desktop Mate (Electron)
packages/
  host-protocol/        앱 ↔ Host Agent 메시지 형식 (JSONL, JSON-RPC 2.0)
  host-agent/           대상 호스트에서 도는 상주 데몬(agentd)과 연결기(connect). Pi Desktop·Agent가 씀
  agent-kit/            Agent의 기능 묶음. Pi 패키지(확장·스킬)라 터미널 pi에도 설치할 수 있음
  mate-kit/             Mate의 Pi 확장: 권한 단계 강제(mate-guard), 제안 도구(mate_propose)
  mate-runner/          Mate의 상주 실행기: 임무 시간표를 지키고 실행마다 pi --mode json을 띄움
  pi-isolation/         Agent·Mate가 앱 홈의 세션·스킬·MCP·지침만 Pi에 올리는 실행 옵션과 확장
docs/                   설계 문서와 개발 방식
```

```
Pi Desktop ──┐
             ├─ host-agent connect → agentd → pi --mode rpc   (앱을 닫아도 세션이 계속 돎)
Agent ───────┘                                   └ Agent는 -e agent-kit 확장을 올림
Mate ───────── mate-runner → pi --mode json -e mate-kit       (임무마다 한 번씩 실행)
```

## 설치

[Releases](https://github.com/skax-soulfactor/pi-desktop/releases)에서 앱과 OS에 맞는 파일을 받습니다. **Latest**로 표시되는 것은 Pi Desktop 릴리스이고, Agent·Mate는 `agent-v*`·`mate-v*` 릴리스에서 찾습니다.

| OS | Pi Desktop | Pi Desktop Agent | Pi Desktop Mate |
|---|---|---|---|
| Windows | `Pi-Desktop-Setup-<버전>.exe` | `Pi-Desktop-Agent-Setup-<버전>.exe` | `Pi-Desktop-Mate-Setup-<버전>.exe` |
| macOS | `Pi-Desktop-<버전>-<arch>.dmg` | `Pi-Desktop-Agent-<버전>-<arch>.dmg` | `Pi-Desktop-Mate-<버전>-<arch>.dmg` |
| Linux | `Pi-Desktop-<버전>-<arch>.AppImage` / `.deb` | `Pi-Desktop-Agent-<버전>-<arch>.AppImage` / `.deb` | `Pi-Desktop-Mate-<버전>-<arch>.AppImage` / `.deb` |

처음이라면 **Pi Desktop**을 먼저 설치해 Pi 설치와 로그인을 마친 뒤, 필요한 앱을 더하면 됩니다.
세 앱 모두 새 버전을 스스로 확인하고, 묻기 전에는 내려받거나 설치하지 않습니다 (Windows·AppImage는 설치까지, 그 밖에는 새 버전을 알리기만). 자세한 동작은 각 앱 설명서에 있습니다.

### 코드 서명

운영체제가 "이 프로그램을 누가 만들었고 그 뒤 바뀌지 않았다"를 확인하는 디지털 서명입니다. 지금은 인증서가 없어 세 앱 모두 서명하지 않으므로 다음처럼 동작합니다.

- Windows: 처음 설치할 때 SmartScreen이 "알 수 없는 게시자" 경고를 띄웁니다. "추가 정보 → 실행"을 누르면 됩니다. 자동 업데이트는 정상으로 동작합니다.
  - 서명하려면 코드 서명 인증서(연 수십만 원 수준)를 사서 CI 비밀 값으로 넣으면 됩니다.
- macOS: Gatekeeper가 처음 실행을 막습니다. Finder에서 앱을 우클릭 → "열기"로 엽니다. 서명이 없으면 macOS의 자동 설치가 거부되므로, 앱은 새 버전을 알리고 릴리스 페이지를 엽니다.
  - 서명하려면 Apple Developer Program(연 99달러) 가입과 공증(notarization)이 필요합니다.
- Linux: 서명이 필요 없습니다.

## Android 휴대폰에서 쓰기 (웹 버전 pi-web)

이 포크(soulfactorx/pi-desktop-mobile)는 세 앱을 휴대폰 브라우저에서 쓰는 웹 버전 **pi-web**을 더합니다 (Pi Desktop은 `pi-web`, Agent는 `pi-web agent`, Mate는 `pi-web mate`). Electron 앱은 Android에서 돌지 않으므로, 휴대폰의 [Termux](https://termux.dev)에서 Pi와 웹 서버를 돌리고 휴대폰 브라우저(Chrome·삼성 인터넷)로 같은 화면을 엽니다. VS Code의 code-server와 같은 방식입니다 (설계 §5.10).

```bash
curl -fsSL https://github.com/soulfactorx/pi-desktop-mobile/releases/latest/download/install-termux.sh | bash
```

설치·명령(`pi-web`, `pi-web update` 등)·갤럭시 설정은 [apps/desktop 설명서의 "Android 휴대폰에서 쓰기"](apps/desktop/README.md#android-휴대폰에서-쓰기-웹-버전-pi-web)에 있습니다.

## 개발

- Node.js 22.19 이상 (Pi 요구 사항)
- Windows에서는 Git Bash (Pi의 bash 툴용)

```bash
npm install
```

npm 11은 설치 스크립트를 기본으로 막습니다. Electron·node-pty 설치 스크립트는 루트 `package.json`의 `allowScripts`로 허용해 두었습니다.

### 실행

API 키 없이 mock LLM으로 띄울 수 있습니다. 앱마다 포트와 데이터 폴더(저장소의 `.dev/` 아래)가 달라 동시에 띄워도 서로 섞이지 않습니다.

| 앱 | mock LLM 실행 | mock 포트 | 설치된 Pi로 실행 |
|---|---|---|---|
| Pi Desktop | `npm run dev:mock -w @pi-desktop/desktop` | 18911 | `npm run dev` |
| Agent | `npm run dev:mock -w @pi-desktop/agent` | 18912 | `npm run dev -w @pi-desktop/agent` |
| Mate | `npm run dev:mock -w @pi-desktop/mate` | 18913 | `npm run dev -w @pi-desktop/mate` |

mock에 보낼 수 있는 프롬프트 예와 앱별 개발 메모는 각 앱 설명서에 있습니다.

### 검사와 테스트

```bash
npm run typecheck
```

```bash
npm test
```

`npm test`는 모든 워크스페이스를 돌립니다. host-agent·agent-kit·mate-runner에는 저장소의 Pi devDependency를 mock LLM과 함께 띄우는 **실제 Pi 계약 테스트**가 들어 있어 API 키가 필요 없습니다. 한 패키지만 돌릴 때는 `npm test -w @pi-desktop/<이름>`을 씁니다.
CI(`.github/workflows/ci.yml`)는 Windows·Linux와 Node 22·24에서 타입 검사, 테스트, Pi Desktop 빌드를 돌립니다.

### 설치 파일 만들기

`npm run dist -w @pi-desktop/<desktop|agent|mate>`는 지금 OS용 설치 파일을 `apps/<앱>/release/`에 만듭니다(올리지 않음).
릴리스는 앱별 태그를 올리면 워크플로가 세 OS에서 만들어 올립니다. 태그와 워크플로 표는 [개발 방식 §6](docs/CONTRIBUTING.md#6-릴리스)에 있습니다.

## 문서

| 문서 | 내용 |
|---|---|
| [docs/DESIGN-APPS.md](docs/DESIGN-APPS.md) | 세 앱의 역할과 데이터 경계: 함께 쓰는 것·나눠 쓰는 것, 데이터 위치, 클라이언트·호스트 구조, 재설계 단계 |
| [docs/DESIGN.md](docs/DESIGN.md) | Pi Desktop 설계: 원칙, Host Agent·상주 세션, 기능 모듈, 로드맵 |
| [docs/DESIGN-AGENT.md](docs/DESIGN-AGENT.md) | Agent 설계: agent-kit 구조, 기능 배치, 단계별 구현 메모, 중계 서버안 |
| [docs/DESIGN-MATE.md](docs/DESIGN-MATE.md) | Mate 설계: 임무·권한 단계·인박스, 활동 관찰, 텔레그램, Mate 대화 |
| [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) | 개발 방식: 언어 규칙, 커밋 단위·메시지, 브랜치·PR, main 룰셋, 릴리스 |
| [apps/agent/src/vendor/README.md](apps/agent/src/vendor/README.md) | Agent가 Pi Desktop에서 복사해 쓰는 모듈과 다시 가져오는 규칙 |

## 라이선스

MIT
