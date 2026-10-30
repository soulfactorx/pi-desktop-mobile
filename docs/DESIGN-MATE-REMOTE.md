# Pi Desktop Mate 원격 실행기 — 설계 문서 (v0.1)

> 관련 문서: [세 앱의 역할과 데이터 경계](DESIGN-APPS.md) §4·§6 D5, [Pi Desktop Mate 설계](DESIGN-MATE.md) §2·§12·§13, [Pi Desktop 설계](DESIGN.md) §3.2(원격 배포)

Mate의 실행기를 이 PC가 아닌 호스트(WSL 배포판, SSH 서버)에서 돌린다. 예를 들어 늘 켜 둔 개발 서버에서 Mate가 저장소를 지켜보고,
노트북의 Mate 앱은 그 서버의 인박스·대화·임무를 보고 고친다. 앱을 닫아도, 노트북을 꺼도 임무는 그 호스트에서 돈다.

Agent의 D3·D4에서 쓴 방식(원격 배포, 앱은 클라이언트, 데이터 함수는 호스트에서)을 Mate에 맞춰 옮긴다.

---

## 1. 지금 구조와 바꿀 점

| | 지금 (로컬 전용) | 바뀐 뒤 |
|---|---|---|
| 앱 ↔ 실행기 | 같은 PC의 Mate 홈 파일. 앱 메인이 파일을 직접 읽고 쓰고 `fs.watch`로 바뀐 것을 안다 (DESIGN-MATE.md §2.2) | **실행기의 JSON-RPC**. 앱은 실행기에 붙은 연결로만 주고받는다. 로컬도 같은 길을 쓴다 |
| 실행기 띄우기 | 앱이 `node mate-runner.mjs start` (분리 프로세스, pid 파일) | 같다. 원격은 그 호스트에 번들을 올린 뒤 `wsl.exe`·`ssh`로 띄운다 |
| 연결 | 없음 (파일) | `mate-runner connect`: 표준 입출력 ↔ 실행기 소켓 다리 (Host Agent의 `connect`와 같은 방식) |
| 화면 갱신 | 앱의 `fs.watch` | 실행기가 자기 홈을 감시해 `mate.changed` 알림을 보낸다 |
| 텔레그램 토큰 | 앱이 풀어서 실행기 환경 변수로 | 로컬은 그대로. 원격은 연결 뒤 RPC로 넘기고 실행기는 메모리에만 둔다 (§5) |
| 폴더 고르기 | OS 폴더 창 | 원격은 실행기가 그 호스트의 폴더를 훑는다 (`fs.listDir`) |

앱에만 남는 것: 자동 업데이트, 로그인할 때 실행기 시작(로컬만), Pi Desktop 설치·열기, 텔레그램 토큰 암호화(safeStorage)와 `getMe` 확인, 파일·폴더를 OS 프로그램으로 열기(로컬만).

## 2. 실행기 JSON-RPC

### 2.1 소켓과 연결기

- 실행기(`mate-runner daemon`)가 Mate 홈 `run/mated.sock`(Windows는 이름 있는 파이프)에서 듣는다. 폴더 권한은 0700, 같은 사용자만 붙는다 (Host Agent와 같다).
- `mate-runner connect`: 실행기가 없으면 `start`처럼 띄우고, 소켓에 붙어 표준 입출력과 이어 준다. 원격은 이 명령을 `wsl.exe`·`ssh`로 실행한다.
- 메시지는 Host Agent와 같은 JSONL + JSON-RPC 2.0(`@pi-desktop/host-protocol`의 framing·jsonrpc)을 쓴다. 메서드 이름은 `mate.*`로 나눈다.
- 연결이 끊겨도 실행기와 임무는 계속 돈다. 앱은 Agent처럼 다시 붙는다 (vendor `host-connection`, 다시 붙기 정책).
- **번들 교체**: `connect`도 `start`와 같이, 떠 있는 실행기의 번들 해시가 다르고 도는 실행이 없으면 바꾼다 (지금 `start`의 규칙).

### 2.2 메서드 — 실행기의 app-api

Agent D4처럼 앱 화면이 쓰는 함수를 mate-runner `src/app-api.ts`에 이름으로 모으고, 실행기가 `mate.call { name, args }` 하나로 부른다.
지금 앱 메인(`apps/mate/src/main/index.ts`)이 Mate 홈 경로로 부르는 함수가 거의 그대로 들어간다.

| 무리 | 함수 (예) |
|---|---|
| 보기 | `overview` (지금 앱의 overview를 그대로 옮김) |
| 임무 | `saveDuty`, `deleteDuty`, `runNow` |
| 인박스 | `setInbox`, `applyChange`, `discardChange`, `delegate`, `applyInstall`, `describeInstall` |
| 실행 기록·휴지통 | `deleteRun`, `readSession`, `restoreTrash`, `emptyTrash`, `clearChat` |
| 대화 | `chatSend` |
| 설정 | `saveConfig` |
| 스킬·MCP | `skillsList`, `skillSave`, `skillDelete`, `mcpList`, `mcpAddPreset`, `mcpSetEnabled`, `mcpRemove`, `mcpCheck` |
| Pi | `piReadiness` (지금의 `mate-runner status`) |
| 호스트 폴더 | `listDir`, `makeDir` (host-agent `dir-list`를 번들해 씀) |
| 원격 텔레그램 | `setTelegramToken` (§5) |

- JSON으로 오가는 값만 받고 돌려준다. 돌려줄 값이 없으면 `null`. 모르는 이름이나 Object 원형의 이름은 거절한다 (Agent `agent.call`과 같다).
- 알림 `mate.changed`: 실행기가 Mate 홈을 감시해 보낸다. 지금 앱의 `watchHome` 규칙(세션·로그·대화 세션은 빼고, 200ms로 묶음)을 옮긴다.
- "지금 실행"은 지금처럼 `requests/`에 파일을 넣는 대신 실행기 안에서 바로 줄에 세운다. 파일 방식도 남겨 둔다 (터미널에서 `mate-runner run`, 예전 앱).

### 2.3 앱 쪽

- 앱 메인은 `MateConnection`(vendor `host-connection`을 감싼 것) 하나로 실행기에 붙고, 렌더러의 IPC를 `mate.call`로 넘긴다. 렌더러는 거의 바꾸지 않는다.
- 연결 상태(붙는 중·끊김·다시 붙는 중)를 화면 위쪽 실행기 표시(지금 "실행기 대기 중·꺼짐")에 함께 보인다.
- `fs.watch`·Mate 홈 직접 읽기는 없앤다. 로컬도 RPC로 가므로 앱과 실행기의 버전이 어긋나면 번들 교체(§2.1)로 맞춘다.

## 3. 호스트 고르기와 원격 배포

### 3.1 호스트

- Agent처럼 **한 번에 한 호스트**: 로컬, WSL 배포판, 등록한 SSH 호스트(키 인증만). 설정 탭에서 고른다. 고른 것은 앱 userData의 `mate-host.json`.
- **호스트를 바꿔도 앞 호스트의 실행기는 멈추지 않는다.** 임무가 두 곳에서 같이 돌 수 있으므로, 바꿀 때 "앞 호스트의 실행기 멈추기"를 함께 묻는다 (기본: 멈춤).
- SSH 호스트 목록은 앱마다 따로다 (Agent와 공유하지 않음, 앱 userData).

### 3.2 무엇을 어디에 올리나

| 무엇 | 그 호스트의 위치 |
|---|---|
| 실행기 번들 (`mate-runner.mjs`, 의존성 없는 한 파일) | `~/.pi-desktop-mate/runner/mate-runner-<버전>-<해시>.mjs` |
| mate-kit·pi-isolation (Pi가 `-e`로 불러오는 TypeScript) | `~/.pi-desktop-mate/kits/<내용 해시>/mate-kit`, `…/pi-isolation` |
| 데이터 (임무·인박스·대화·세션·휴지통·스킬·mcp.json) | `~/.pi-desktop-mate/` (지금과 같은 구조) |

- 실행기는 `PI_DESKTOP_MATE_KIT=<올린 kit>/mate-kit`로 띄운다. pi-isolation은 지금처럼 mate-kit 옆에서 찾는다 (`isolationDirOf`).
- 같은 내용이면 다시 올리지 않는다. 올리기는 임시 폴더에 다 쓴 뒤 바꿔치기한다 (Agent D3와 같다).

### 3.3 공용 배포 코드

Agent의 `apps/agent/src/main/hosts.ts`(kit 모으기·올리기, WSL·SSH 준비)와 vendor의 원격 모듈(`remote-agent`·`wsl`·`ssh`·`ssh-hosts`)을 Mate도 쓴다.
두 앱이 같은 코드를 쓰도록 **새 공용 패키지 `packages/host-deploy`** 로 옮긴다.

- 들어갈 것: 원격 셸 실행(`runCommand`·`shQuote`), Node 찾기와 번들 올리기(지금 `deployAgent`를 "번들 파일 + 홈 폴더 이름"을 받는 꼴로), kit 모으기·올리기, WSL·SSH 실행 명령, SSH 호스트 저장, 호스트 고르기 저장.
- Pi Desktop은 고치지 않는다. Agent의 vendor 원격 모듈은 이 패키지로 바꾼다 (Agent vendor README에 적는다).
- 테스트는 지금 Agent의 "sh로 원격 흉내"를 이 패키지로 옮겨 두 앱이 함께 쓴다.

## 4. 호스트에서 도는 것

지금도 실행기 안에서 도는 것은 그대로 그 호스트에서 돈다. 원격이 되면서 달라지는 점만 적는다.

| | 원격에서 |
|---|---|
| Pi | 그 호스트에 설치된 Pi와 그 호스트의 로그인(`~/.pi/agent/auth.json`)을 쓴다. 없으면 Pi 준비 안내가 "그 호스트에 Pi를 설치하세요"로 바뀐다 (Pi Desktop의 그 호스트 Pi 관리로 안내) |
| 활동 관찰 | 그 호스트의 Pi Desktop·터미널 pi 세션과 Agent 세션을 읽는다 (DESIGN-APPS.md §3.3, 같은 호스트만) |
| 고치기(act) 작업 공간 | 그 호스트 저장소의 git worktree. 적용도 그 호스트의 작업 폴더에 한다 |
| 텔레그램 | 그 호스트에서 `api.telegram.org`로 롱폴링한다. 회사 방화벽 뒤 서버면 막힐 수 있다 (연결 상태에 보인다) |
| 로그인할 때 시작 | 로컬만 지원. 원격 실행기는 그 호스트가 다시 켜지면 앱이 붙을 때 다시 뜬다. 서버에서 늘 돌리려면 사용자가 systemd 사용자 서비스 등으로 `mate-runner start`를 걸 수 있다 (안내만) |

## 5. 텔레그램 토큰 (원격)

- 로컬은 지금처럼 앱이 실행기를 띄울 때 환경 변수로 넘긴다.
- 원격은 명령 줄·환경 변수로 넘기지 않는다 (원격의 `ps`·셸 기록에 남을 수 있다). 연결 뒤 `mate.call setTelegramToken`으로 넘기고, 실행기는 **메모리에만** 둔다. 디스크에 쓰지 않는다.
- 그래서 원격 실행기가 다시 뜨면 앱이 붙을 때까지 휴대폰 연결이 쉰다. 휴대폰 탭에 "앱이 붙어야 휴대폰 연결이 다시 켜짐"을 보인다.
- 앱은 붙을 때마다(로컬도) `setTelegramToken`으로 넘긴다. 토큰을 저장·삭제할 때도 실행기를 다시 띄우지 않고 이 길로 바꾼다 (도는 임무가 끊기지 않게).
- 토큰은 이 PC의 키체인으로 암호화해 그 호스트의 설정에 둔다. 다른 PC의 앱이 같은 호스트에 붙으면 풀 수 없으므로, 그때는 실행기의 연결을 끄지 않고 휴대폰 탭에 "쉬고 있음"을 보인다.
- 시험 알림은 앱(이 PC)이 보낸다.
- 모델이 bash로 토큰을 볼 수 없게 Pi 실행 환경에서 빼는 규칙(DESIGN-MATE.md §12)은 그대로다 (메모리 값은 환경 변수로도 넘기지 않는다).

## 6. 단계

| 단계 | 내용 | 비고 |
|---|---|---|
| **D5-1 실행기 RPC** | 실행기 소켓·`connect`, `mate.call` app-api, `mate.changed`. 앱은 로컬 실행기에 RPC로 붙고 파일 직접 읽기·`fs.watch`를 없앤다 | **완료**. 동작은 지금과 같다 |
| **D5-2 공용 배포 패키지** | `packages/host-deploy`로 Agent의 원격 배포 코드를 옮긴다 (Agent 동작은 그대로) | **완료**. Agent vendor의 remote-agent·wsl·ssh·ssh-hosts를 없앴다 |
| **D5-3 Mate 호스트 고르기** | 원격 배포(번들·kit), 설정의 호스트 고르기·SSH 호스트, 앞 실행기 멈추기, 원격 폴더 고르기, 로컬 전용 기능 안내 | **완료**. 실제 WSL·SSH는 아직 확인하지 못했고, sh 흉내 통합 테스트로 확인 |
| **D5-4 원격 텔레그램** | RPC로 토큰 넘기기, 메모리 보관, 다시 뜬 뒤 안내 | **완료**. 로컬도 같은 길로 넘겨 토큰을 바꿔도 실행기를 다시 띄우지 않는다 |

각 단계는 PR 하나 이상. D5-1이 끝나면 로컬 Mate가 지금과 똑같이 동작하는지(dev:mock, 실제 Pi) 확인한 뒤 다음으로 간다.

## 7. 시험

- 실행기 RPC: `mate.call` 단위 테스트(임무·인박스·대화·설정), `mate.changed` 알림, 연결이 끊겨도 실행이 이어지는지.
- 원격: Agent처럼 이 PC의 `sh`와 임시 `HOME`으로 원격을 흉내 내 번들·kit 올리기 → `connect` → `mate.call overview`·`runNow` → 실제 Pi 실행이 그 홈에 남는지.
- 텔레그램: 가짜 텔레그램 서버로 원격 토큰 넘기기·메모리 보관·다시 뜬 뒤 쉬는지.
- 실제 WSL·SSH 확인은 Windows PC와 SSH 서버에서 사람이 한다 (자동 시험 밖).

## 8. 정한 것과 남은 질문

정한 것

- 로컬도 RPC로 간다 (한 길만 둔다). 파일 형식(DESIGN-MATE.md §2.2)은 실행기 안의 저장 방식으로 남는다.
- 한 번에 한 호스트. 앞 호스트 실행기는 바꿀 때 멈출지 묻는다.
- 원격 토큰은 메모리에만.

남은 질문 (구현 전에 정하면 좋은 것)

1. 여러 호스트의 인박스를 한 화면에 모아 볼지 (지금 설계는 고른 호스트 하나만).
2. 원격 실행기를 늘 돌리는 방법(systemd 등)을 앱이 만들어 줄지, 안내만 할지 (지금 설계는 안내만).
