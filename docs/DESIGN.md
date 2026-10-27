# Pi Desktop — 설계 문서 (v0.70)

> 목표: **Pi를 포크하지 않고**, 사용자가 설치한 `pi` 그대로(업데이트 계속 받으며) 위에 GUI를 얹는다.
> 기준 버전: `@earendil-works/pi-coding-agent` 1.3.0 (2026-10). ※ 구 패키지명 `@mariozechner/pi-coding-agent`는 0.73.1에서 멈춰 있음.

## 0. 확정된 결정 (v0.2)

| 항목 | 결정 |
|---|---|
| Pi 연결 방식 | **RPC 자식 프로세스** (`pi --mode rpc`). SDK는 메타데이터 조회와 Playground에만 사용 |
| 셸 | **Electron** |
| 최우선 완성 영역 | **채팅 (TUI 대체)** |
| 지원할 사용 패턴 | 여러 프로젝트 동시 작업 · TUI와 병행 사용 · **WSL 안의 Pi** · **원격(SSH) Pi** |
| 추가 기능 | **Pi 설치/업데이트/제거 관리** · **커뮤니티 리소스(패키지·스킬·프롬프트·확장) 검색 및 설치/제거** |
| 원격 작업 수명 | **GUI를 닫아도 원격 작업은 계속 실행**한다. GUI를 다시 열면 기존 세션에 다시 붙어 그대로 이어서 작업한다 (§3.4) |
| 커뮤니티 검색 소스 | **npm `pi-package` 키워드 검색**을 사용한다. pi.dev 갤러리는 공개 API가 없다(`/api/packages` → 501) |
| 저장소 관리 | GitHub 저장소. 코드 리뷰가 가능한 단위로 커밋하고, 주석과 커밋 메시지는 한글로 쓴다 (§11) |

v0.1 대비 가장 큰 구조 변화: WSL과 SSH를 지원하기 위해 **Host Agent**(§3.2)를 도입했다. 로컬·WSL·원격을 모두 같은 코드 경로로 다룬다.
v0.3에서는 Host Agent를 **상주 데몬 + 얇은 연결기**로 나눴다(§3.4). GUI가 꺼져도 원격 작업이 살아남게 하기 위해서다.

---

## 1. 핵심 원칙

| 원칙 | 의미 |
|---|---|
| **Zero-fork** | Pi 소스를 수정하지 않는다. 공식 통합 지점(RPC 모드, SDK, 설정 파일, 확장, CLI)만 쓴다 |
| **Pi가 소유한 파일이 진실의 원천** | 설정을 GUI 자체 DB에 복제하지 않는다. `~/.pi/agent/*`, `.pi/*`, `AGENTS.md`를 직접 읽고 쓴다. 그래서 TUI와 GUI를 섞어 써도 항상 일치한다 |
| **설치된 Pi를 따라간다** | GUI 번들에 Pi를 넣지 않는다. 대상 호스트에 설치된 Pi를 찾아 실행한다. `pi update` 결과가 GUI에 바로 반영된다 |
| **기능 감지 > 버전 하드코딩** | `get_commands`, JSON Schema, 응답 형태로 기능을 감지한다. 모르는 이벤트와 필드는 버리지 않고 raw로 보여준다 |
| **GUI 메타데이터는 분리 보관** | 창 배치, 워크스페이스 목록, 카탈로그 캐시처럼 GUI만 쓰는 상태는 Electron `userData`에 둔다. `~/.pi`는 오염시키지 않는다 |

## 2. Pi가 제공하는 통합 지점 (문서로 확인함)

| 통합 지점 | 용도 |
|---|---|
| `pi --mode rpc` + `RpcClient` | 채팅 세션 제어: prompt / steer / follow_up / abort, set_model, thinking level, compact, bash, 세션 switch·fork·clone·get_tree, get_commands, export_html |
| RPC Extension UI 서브프로토콜 | 확장의 `ctx.ui.select/confirm/input/editor`를 네이티브 다이얼로그로, `notify/setStatus/setWidget/setTitle`을 토스트·상태바·패널로 렌더링 |
| SDK export (`DefaultResourceLoader`, `DefaultPackageManager`, `SessionManager`, `ModelRegistry`, `parseSessionEntries`, `buildSessionProjection` 등) | 리소스 목록과 진단, 세션 파싱, 모델 목록 |
| `schemas/*.schema.json` | settings / models / keybindings / theme 폼을 스키마로 자동 생성 |
| CLI: `pi install/remove/update/list/config`, `pi update [--extensions\|--models\|--all]`, `pi auth check --json` | 패키지 관리, Pi 자체 업데이트, 인증 상태 확인 |
| 공식 설치기 `https://pi.dev/install.sh` (macOS/Linux) | 관리형 설치, 재설치, 제거. 의존성이 고정되고 `pi update`로 갱신된다 |
| npm 키워드 `pi-package` + [pi.dev/packages](https://pi.dev/packages) 갤러리 | 커뮤니티 패키지 검색 |

**한계와 보완책**
- RPC에 `reload` 명령이 없다. → §5.3의 bridge 확장으로 `ctx.reload()`를 호출한다.
- `/login`은 TUI 전용이다. → API 키는 GUI 폼으로 받고, OAuth는 내장 터미널(§4.7)로 처리한다.
- 세션 파일에 잠금이 문서화되어 있지 않다. → GUI가 세션 소유권(lease)을 관리한다(§5.4).
- RPC 모드에서는 `ctx.ui.custom()`, footer/header, 테마 전환 같은 TUI 전용 기능이 동작하지 않는다. → 해당 확장에 "TUI 전용" 배지를 달고, 필요하면 내장 터미널로 연다.

## 3. 아키텍처

### 3.1 전체 구조

```
┌──────────────────────────────── Electron App ─────────────────────────────────┐
│ Renderer (React) — 창마다 워크스페이스 탭                                     │
│  Chat · Sessions · Context · Prompts · Skills · Extensions · Marketplace ·    │
│  Providers · Settings · Pi Manager · Playground · Inspector · Terminal(xterm) │
│                    ▲ typed IPC (contextBridge + zod)                          │
├────────────────────┼──────────────────────────────────────────────────────────┤
│ Main process                                                                  │
│  HostManager ── HostConnection(local) ─┐                                      │
│              ├─ HostConnection(wsl:Ubuntu) ─┤   한 연결 = Host Agent 1개      │
│              └─ HostConnection(ssh:devbox) ─┘   (멀티플렉스 JSON-RPC 채널)    │
│  WorkspaceManager · CatalogService · LeaseManager · Telemetry(local only)     │
└────────┬──────────────────────┬───────────────────────────┬───────────────────┘
         │ stdio                │ wsl.exe -d <distro> --    │ ssh <host> (ControlMaster)
   node host-agent.js      node host-agent.js           node ~/.pi-desktop/host-agent.js
         │                      │                           │
   ┌─────┴───────── 각 호스트에서 동일하게 동작 ────────────────────────┐
   │ Host Agent: fs(read/write/list/stat/watch) · exec · pty ·           │
   │   pi 프로세스 풀(pi --mode rpc, 세션별) · SDK facade(설치본 import) │
   └─────────────────────────────────────────────────────────────────────┘
```

### 3.2 Host Agent — 로컬/WSL/SSH를 하나로

GUI가 Pi와 직접 대화하지 않고, **대상 호스트에서 도는 작은 Node 프로그램(Host Agent)**을 거친다.

**왜 필요한가**
- WSL이나 원격의 Pi는 **그 호스트의 파일**(`~/.pi/agent`, 프로젝트의 `.pi`)과 **그 호스트의 Node**로 동작한다. SDK import, 파일 감시, `pi install`을 전부 그 호스트 안에서 해야 한다.
- 호스트마다 다른 코드를 쓰는 대신 Agent 하나를 배포하면 로컬·WSL·SSH 모두 **같은 프로토콜**이 된다. 로컬도 같은 Agent를 자식 프로세스로 띄운다.

**프로토콜** (stdio 위의 JSON-RPC 2.0, 채널 멀티플렉싱)

| 네임스페이스 | 메서드 예시 |
|---|---|
| `host.*` | `info`(OS, arch, node 버전, 홈 경로), `ping` |
| `fs.*` | `read`, `write`(원자적: tmp 파일 → rename), `list`, `stat`, `watch`/`unwatch`, `mkdir`, `remove`(휴지통 폴더로 이동) |
| `proc.*` | `exec`(출력 스트리밍), `spawn`, `kill` |
| `pty.*` | `open`, `write`, `resize`, `close` (node-pty. 설치기·OAuth 로그인·TUI 폴백용) |
| `pi.*` | `locate`, `version`, `rpc.open(cwd, sessionFile?)` → 채널 ID, `rpc.send`, `rpc.close` |
| `session.*` | `list`(데몬이 소유한 살아 있는 세션), `attach(sessionId, lastSeq)`, `detach`, `claimWriter`, `pendingUi` (§3.4) |
| `daemon.*` | `status`, `shutdown`, `upgrade` |
| `sdk.*` | `resources(cwd)`, `contextFiles(cwd)`, `effectiveSystemPrompt(cwd)`, `listSessions(cwd)`, `models()` |

**배포와 부트스트랩**
1. 연결 전에 Agent가 없을 수 있으므로, 먼저 **plain shell exec**(`wsl.exe -- sh -c …`, `ssh host …`)로 `node --version`과 Agent 버전을 확인한다.
2. Agent는 의존성 없는 단일 번들(esbuild)로 만든다. `node-pty`처럼 네이티브 모듈이 필요한 pty 기능은 선택 사항으로 두고, 없으면 `script`/`python pty`로 대체하거나 해당 기능만 비활성화한다.
3. 버전이 다르면 `~/.pi-desktop/host-agent-<ver>.js`로 업로드한다(SSH는 stdin 파이프 또는 sftp, WSL은 `\\wsl$` 경로).
4. Node가 없으면 Pi 설치 마법사(§4.9)로 연결한다.

**전송 계층**

| 종류 | 실행 방법 | 비고 |
|---|---|---|
| Local | `child_process.spawn(process.execPath 또는 시스템 node, [agent])` | Electron 내장 Node와 시스템 Node 중 Pi가 쓰는 쪽을 사용 |
| WSL | `wsl.exe -d <distro> --cd <linux-path> -- node <agent>` | 배포판 목록은 `wsl.exe -l -q`. 경로는 `/mnt/c/...`와 `C:\...` 사이를 변환 |
| SSH | 시스템 `ssh`(ControlMaster로 연결 재사용) 또는 `ssh2` 라이브러리 | `~/.ssh/config`의 호스트 목록을 가져온다. 키·에이전트 인증은 OS ssh에 맡기고 **비밀번호는 저장하지 않는다** |

**연결 끊김**: §3.4의 상주 데몬 구조로 처리한다. 연결이 끊겨도 Pi 프로세스는 데몬 아래에서 계속 돌고, 다시 연결하면 놓친 이벤트를 재생한다.

### 3.3 워크스페이스 모델 (여러 프로젝트 동시 작업)

```
Workspace = { id, hostId, cwd, title, pinned, lastSessionFile, layout }
```
- 창 하나에 워크스페이스 탭 여러 개. 탭을 끌어 새 창으로 분리할 수 있다.
- 워크스페이스마다 열린 세션이 여러 개일 수 있고, **세션 하나 = RPC 프로세스 하나**다. 비활성 세션은 유휴 타임아웃 뒤 프로세스를 종료하고, 다시 열 때 `sessionFile`로 재개한다. 메모리를 아끼기 위해서다.
- 사이드바 "Activity"에서 모든 워크스페이스의 실행 중·대기 중·입력 필요(확장 다이얼로그) 상태를 한눈에 본다. 백그라운드 세션이 끝나거나 입력을 기다리면 OS 알림을 보낸다.
- 워크스페이스 목록은 GUI 메타데이터로 `userData`에 저장한다.

**구현 메모 (M1, v0.9)**
- 지금은 창 하나에 탭 여러 개까지 구현했다. 탭을 끌어 새 창으로 분리하기, 고정(pinned)은 후속 작업이다.
- 활동 패널(v0.17): 사이드바 대신 탭 바 오른쪽 "활동" 버튼으로 연다. 탭들이 연결한 호스트의 세션을 입력 필요 → 작업 중 → 대기 → 종료 순으로 보여주고, 누르면 보는 탭으로 가거나 새 탭으로 연다. 데몬 세션 요약에 `busy`(agent_start~agent_settled)와 `title`(이름 또는 첫 질문)을 두었다. 데몬은 붙어 있지 않은 세션의 이벤트를 보내지 않으므로 3초마다 목록을 다시 읽는다.
- 탭 하나 = 렌더러의 `Workspace` 하나. 숨긴 탭도 언마운트하지 않아 호스트 연결·세션 구독·확장 UI 상태를 그대로 유지한다.
- 탭 목록과 활성 탭, 탭별 호스트·마지막 세션은 렌더러 `localStorage`에 저장한다 (`pi-desktop.tabs`, `pi-desktop.tab.<id>.*`). 첫 탭은 기존 키를 그대로 써서 이전 설정이 이어진다. 탭을 닫으면 그 탭의 키를 지우고, Pi 세션은 데몬에서 계속 돈다.
- 새 탭은 지금 탭의 호스트로 시작하고 최근 세션을 자동으로 열지 않는다.
- 숨긴 탭이 실행 중→끝남이 되면 "완료", 확장 다이얼로그·끼어들기·열기 선택이 생기면 "입력 필요"를 탭에 표시하고 OS 알림을 띄운다. 탭을 열면 표시를 지운다.
- 같은 세션을 두 탭에서 열 수 있다. main 프로세스는 attach 중에도 실시간 이벤트를 모든 탭에 보내고, attach 결과의 재생 이벤트와는 seq로 중복을 거른다.

### 3.4 상주 세션 — GUI를 닫아도 작업은 계속된다 (v0.3 신규)

**요구사항**
- 원격(SSH) 작업은 GUI를 닫거나 네트워크가 끊겨도 계속 실행된다.
- GUI를 다시 열면 기존 세션에 다시 붙는다. 그동안 진행된 대화, 툴 실행, 대기 중인 확장 다이얼로그를 그대로 보고 이어서 작업한다.

**구조: Host Agent를 둘로 나눈다**

```
GUI ──ssh──▶ host-agent connect ──unix socket──▶ host-agentd (상주 데몬)
             (얇은 연결기: stdio ↔ 소켓 중계)        ├ pi --mode rpc  (세션 A)
             GUI가 꺼지면 함께 종료                   ├ pi --mode rpc  (세션 B)
                                                     └ 세션별 이벤트 저널
```

| 구성 요소 | 역할 | 수명 |
|---|---|---|
| `host-agentd` (데몬) | Pi RPC 프로세스 소유, 이벤트 저널 기록, fs/proc 처리 | SSH 연결과 무관하게 계속 실행 (`setsid`/`nohup`으로 분리 실행, 선택적으로 `systemd --user` 유닛) |
| `host-agent connect` (연결기) | SSH stdio와 데몬의 unix socket을 이어주기만 함. 데몬이 없으면 띄운 뒤 연결 | SSH 세션과 같이 죽음 |

- 소켓 위치: `~/.pi-desktop/run/agentd.sock`, 권한 `0600`. 같은 사용자만 접근할 수 있다.
- **구현 메모: 연결 상호 인증 (보안 검토, v0.60)**
  - 문제: Windows의 이름 있는 파이프(`pi-desktop-agentd-<사용자>-<해시>`)는 이름을 짐작할 수 있고 0700 같은 폴더 보호가 없다. 같은 PC의 다른 사용자가 데몬보다 먼저 같은 이름의 파이프를 만들면, 앱이 그쪽에 붙어 API 키 저장 같은 요청을 보낼 수 있었다.
  - 데몬은 소켓을 연 뒤 `run/agentd.token`(사용자만 읽음, POSIX 0600)에 무작위 토큰을 쓴다. 다른 데몬이 듣고 있으면 덮어쓰지 않는다.
  - 연결 순서(`handshake.ts`, JSON-RPC 앞에 한 줄씩): 데몬 nonce → 연결기 nonce와 HMAC(토큰, "client:"+데몬 nonce) → 데몬 HMAC(토큰, "server:"+연결기 nonce).
  - 연결기는 데몬이 증명하기 전에는 앱의 요청(stdin)을 넘기지 않는다. 증명이 틀리면 연결하지 않는다.
  - 호환: POSIX에서는 인증 없는 예전 연결기·데몬도 받는다(0700 폴더라 같은 사용자뿐).
  - Windows에서 인사가 없는 데몬이면 연결기가 `connector.unverified`를 먼저 앱에 쓴다. 앱은 `daemon.shutdown`만 보내 예전 데몬을 바꾼다(실행 중인 세션은 끝난다).
  - 바꾼 뒤에도 확인되지 않으면 연결하지 않고 이유를 보인다. 이전 버전 앱은 Windows의 새 데몬에 붙지 못하므로 함께 업데이트해야 한다.
  - 확인(dev:mock, Windows)
    - 새 데몬과 인증해 연결됐다.
    - 같은 이름의 파이프를 먼저 차지한 가짜 프로그램에는 `host.info`·`daemon.shutdown`만 갔고, 그 뒤로는 연결하지 않고 이유를 보였다.
    - 가짜를 끄자 새 데몬으로 다시 붙었다.
- 설치본에서는 개발용 환경 변수(`PI_DESKTOP_REMOTE_DEBUG_PORT`, `ELECTRON_RENDERER_URL`)를 쓰지 않는다(보안 검토, v0.60).
  - CDP는 앱을 마음대로 조작할 수 있고, 개발 서버 주소의 페이지는 preload의 앱 API를 갖기 때문이다.
  - 설치본을 검증할 때는 실행 인자 `--remote-debugging-port=<포트>`를 직접 준다.
- 데몬은 호스트당 1개, 사용자당 1개다. 이미 떠 있으면 연결기는 그 데몬에 붙는다.
- Windows에서는 연결기가 데몬을 **WMI(`Win32_Process.Create`)로** 띄운다. 직접 spawn이나 `cmd start`로 띄우면 앱(Electron)의 상속 가능한 핸들이 데몬까지 넘어가, 앱을 닫아도 그 자원이 풀리지 않는 것을 실험으로 확인했다(v0.6). WMI는 환경 변수를 통째로 대체하므로 연결기 환경 전체를 표준 입력으로 넘긴다.
- 데몬 버전이 새 GUI와 맞지 않으면, 실행 중인 세션이 없을 때만 교체한다. 세션이 있으면 기존 데몬을 유지하고 GUI에 "작업이 끝나면 업데이트" 배지를 띄운다.
- **구현 메모: 예전 데몬 교체 (M3, v0.27)**
  - 버전 번호 대신 **빌드 식별자**(번들 파일 SHA-256의 앞 12자리)로 비교한다. 버전이 같아도 번들이 바뀐 경우(개발 중 다시 빌드, 같은 버전으로 다시 배포)를 가리기 위해서다. WSL에 올리는 파일 이름의 해시와 같은 값이다.
  - 데몬은 시작할 때 자기 번들을 해시해 `host.info`·`daemon.status`의 `agentBuild`로 알린다. 이 필드가 없으면 예전 데몬으로 본다.
  - 앱은 연결할 때마다 자기 번들(로컬은 그 파일, WSL은 올린 파일)의 식별자와 비교한다. 다르면 `daemon.status`로 실행 중인 세션을 센다.
    - 세션이 없으면 `daemon.shutdown`을 보내고, 연결기가 끝나면 곧바로 다시 붙는다. 이때 연결기가 새 번들로 데몬을 띄운다. 오류 안내 없이 "연결 중"으로만 보인다.
    - 세션이 있으면 그대로 붙고 "Agent 업데이트 대기" 배지를 띄운다. 30초마다 세션 수를 다시 보고, 모두 끝나면 바꾼다. 배지를 누르면 "세션이 끝나면 바꾸기"(기본)와 "지금 바꾸기"(실행 중인 세션이 끝나고, 세션 파일로 "다시 열기")를 고를 수 있다.
    - 같은 번들로 한 번 바꿨는데도 다시 예전 데몬이 붙으면 되풀이하지 않고 배지만 띄운다.
  - 연결기는 지금처럼 바이트만 중계한다. 판단을 앱에 둔 이유는 사용자에게 묻는 화면이 앱에 있고, SSH에서도 같은 코드로 쓸 수 있기 때문이다.

**세션 이벤트 저널과 재연결**
1. 데몬은 세션마다 Pi가 보낸 모든 RPC 이벤트에 **순번(seq)**을 붙여 저널에 쌓는다. 저널은 **메모리 링버퍼**다 (v0.6: 디스크 저널은 두지 않기로 함, 아래 4번).
2. GUI는 세션별로 마지막으로 받은 `seq`를 기억한다.
3. 다시 연결하면 `session.attach(sessionId, lastSeq)`를 호출한다.
   - 저널에 그 뒤의 이벤트가 남아 있으면 **빠짐없이 재생**한 다음 실시간 스트림으로 이어간다.
   - 너무 오래되어 저널에서 잘렸으면 **스냅샷 복구**를 한다. `get_messages`, `get_state`, `get_tree`로 현재 상태를 통째로 받아 화면을 다시 그린 뒤 실시간 스트림을 붙인다.
4. 저널은 Pi의 세션 파일을 대신하지 않는다. 대화의 진짜 기록은 Pi의 세션 JSONL이고, 저널은 **스트리밍 중간 상태**(진행 중인 메시지 델타, 툴 실행 출력)를 잃지 않기 위한 보조 장치다.
   - **디스크 저널을 두지 않는 이유 (v0.6 결정)**: 데몬이 죽으면 그 아래 Pi 프로세스도 stdin이 닫혀 함께 끝난다. 디스크에 남긴 중간 상태로는 대화를 이어 갈 수 없고, 이어 가려면 어차피 Pi 세션 파일로 다시 열어야 한다. 그래서 데몬 재시작은 "세션 파일로 다시 열기 + `get_messages` 스냅샷"으로 복구한다.
   - 링버퍼에서 잘린 구간을 요청받으면 앱은 같은 스냅샷 방식으로 화면을 다시 만든다.

**GUI가 없는 동안 생기는 일**

| 상황 | 동작 |
|---|---|
| 에이전트가 계속 작업 | 그대로 진행한다. 결과는 세션 파일과 저널에 쌓인다 |
| 확장이 다이얼로그를 띄움 (`select`/`confirm` 등) | 데몬이 요청을 **보류 목록**에 보관한다. 다시 연결하면 GUI가 바로 띄운다. 확장이 timeout을 지정했다면 Pi가 기본값으로 자동 처리하고, 그 사실을 GUI에 알린다 |
| Steer / Follow-up 큐 | Pi 프로세스 안에 그대로 남아 있다 |
| Pi 프로세스가 죽음 | 데몬이 감지해 앱에 알린다. 앱은 대화를 화면에 남긴 채 입력을 잠그고 "다시 열기"를 보여준다 (`sessionFile`로 재시작 후 스냅샷 복구) |
| 데몬이 죽음 (재시작) | Pi도 함께 끝난다. 앱은 새 데몬에 재연결한 뒤 보던 세션이 없으면 같은 방식으로 "다시 열기"를 보여준다 |
| 원격 서버 재부팅 | 데몬과 진행 중이던 턴은 사라진다. 세션 파일은 남아 있으므로 마지막 확정 지점부터 재개할 수 있다 |

**GUI를 다시 열었을 때의 화면**
- 시작하면 등록된 모든 호스트에 연결해 `sessions.list`로 **살아 있는 세션 목록**을 가져온다. Activity 사이드바에 실행 중·완료·입력 대기 상태로 표시한다.
- GUI가 꺼져 있던 동안 끝난 작업에는 "새 결과" 배지를 단다.
- 워크스페이스 탭과 창 배치는 `userData`에 저장해 두었다가 그대로 복원한다.

**여러 GUI가 같은 세션에 붙을 때** (예: 노트북과 데스크톱)
- 한 세션에 **입력 권한(writer)을 가진 클라이언트는 하나**다. 나머지는 읽기 전용으로 실시간 스트림을 본다.
- 읽기 전용 쪽에서 "제어 가져오기"를 누르면 기존 writer에게 알린 뒤 권한을 넘긴다.
- **구현 메모 (M3, v0.29)**
  - 단위는 데몬 연결 하나(= 앱 하나)다. 한 앱의 여러 탭은 연결을 함께 쓰므로 같은 권한을 가진다.
  - 권한을 얻는 경우: 세션을 연 앱, 또는 권한이 빈 세션에 붙거나(attach) 먼저 입력한 앱.
  - 권한이 없는 앱이 바꾸는 명령(prompt, abort, 모델 변경, 확장 다이얼로그 답 등)이나 `session.close`를 보내면 `NotWriter`(-32012)로 거부한다. `get_*` 조회와 `export_html`은 읽기 전용 앱도 보낼 수 있다.
  - `session.claimWriter`로 권한을 가져온다. 권한이 바뀌면 붙어 있는 앱마다 자기 기준 값(`you`·`other`·`none`)을 `session.writerChanged`로 알리고, attach 결과에도 담는다.
  - 권한을 가진 앱이 끊기면(앱 종료, 네트워크) 권한을 비운다. 남은 앱은 입력창이 바로 풀리고, 먼저 입력하는 쪽이 가져간다.
  - 앱은 `other`일 때 입력창·세션 바를 잠그고 "다른 앱이 조작 중" 안내와 "제어 가져오기" 버튼을 보여준다. 대화는 계속 실시간으로 보인다.
  - 확인: 같은 데몬에 붙는 두 번째 연결로 다른 PC의 앱을 흉내 냈다. 그 연결이 제어를 가져가 보낸 질문과 답이 앱에 실시간으로 보였고, 앱에서 다시 가져오자 그 연결의 입력이 거부되었다.

**호스트별 기본값**

| 호스트 | GUI 종료 시 기본 동작 | 비고 |
|---|---|---|
| SSH 원격 | **계속 실행** (요청 사항) | |
| WSL | 계속 실행 | WSL은 클라이언트 프로세스가 모두 끝나면 배포판을 멈출 수 있다. M3 스파이크에서 데몬이 살아남는지 확인하고, 안 되면 `systemd` 사용 또는 keep-alive 방식을 적용한다 |
| 로컬 | 실행 중인 세션이 있으면 **물어본다** ("백그라운드에서 계속" / "모두 중지") | 같은 데몬 구조라서 기술적으로는 원격과 똑같이 동작한다 |

**데몬 정리 규칙**: 살아 있는 세션이 없고 연결된 GUI도 없는 상태가 설정 시간(기본 30분) 동안 이어지면 스스로 종료한다. Pi Manager 화면에서 호스트별 데몬 상태 확인과 강제 종료를 할 수 있다.

## 4. 기능 모듈

### 4.1 Chat (최우선, TUI 대체)

**목표: TUI에서 하던 모든 일을 마우스와 키보드로 더 편하게.** M1에서 이 화면의 완성도를 가장 높인다.

- **스트리밍 렌더링**: `message_update` 델타로 그리고 `message_end`로 확정본을 교체한다(json.md 규칙). 완료 판정은 `agent_end`가 아니라 `agent_settled`다.
- **사고(thinking) 블록**: 접기/펼치기, 기본 상태는 `hideThinkingBlock` 설정을 따른다.
- **툴 호출 카드**: 툴별 렌더러를 둔다.
  - `edit`/`write`: side-by-side diff, 파일 열기 버튼
  - `bash`/`powershell`: 터미널 스타일 출력, 종료 코드, 실행 시간
  - `read`/`grep`/`find`: 파일 링크와 결과 요약
  - 알 수 없는 툴(확장·MCP): 인자와 결과를 JSON 트리로
  - **구현 메모 (M1, v0.11)**
    - 표시 규칙은 `tool-view.ts`에 두고 Pi 1.3.0의 실제 결과로 테스트한다. edit는 `details.patch`(표준 unified diff)를 쓰고, patch가 없으면(실행 중, 실패) 인자의 `oldText`·`newText`로 미리보기를 그린다.
    - "파일 열기"는 실행 파일이 실행될 위험이 있어서 탐색기에서 **위치만 보여준다**(`shell.showItemInFolder`). WSL은 `\\wsl.localhost\<배포판>` 경로로 바꾼다. SSH 호스트에서는 버튼을 숨긴다.
    - 툴 호출 id를 턴마다 다시 쓰는 모델 서버가 있어서, 같은 id의 결과는 가장 최근 카드에 붙인다.
    - read·grep·find·ls의 결과 링크(클릭해서 파일 열기)는 후속 작업이다.
- **입력창**
  - 멀티라인 에디터, 히스토리(↑), 초안 자동 저장
  - `/` 자동완성: `get_commands`(프롬프트 템플릿, 스킬, 확장 커맨드)와 각 설명을 표시
  - `@` 파일 피커(Host Agent의 `fs.list`로 원격에서도 동작), 이미지 붙여넣기와 드래그 앤 드롭
  - `!` 셸 명령은 RPC `bash`로 실행
  - 스트리밍 중에는 **Steer**(현재 턴 뒤에 끼워넣기)와 **Follow-up**(실행이 끝난 뒤) 버튼을 따로 보여주고, 대기 중인 큐를 표시하고 비울 수 있다.
  - **구현 메모 (M1, v0.10)**
    - 히스토리는 최근 100개를 모든 탭이 함께 쓰고, 초안은 세션 파일별로 저장한다.
    - `!명령`은 결과를 컨텍스트에 넣고, `!!명령`은 넣지 않는다(`excludeFromContext`, TUI와 같은 규칙).
    - Pi는 RPC `bash`에 출력 조각(`bash_execution_update`)만 보내고 시작·끝 이벤트가 없다. 그래서 데몬이 `pi_desktop_bash_start`·`pi_desktop_bash_end`를 저널에 남긴다(`DaemonEvents`). 다른 탭이나 다시 연결한 앱도 같은 셸 카드를 그린다.
    - `bash`는 끝나야 응답이 오므로 데몬과 앱 모두 이 명령에는 응답 시간 제한을 두지 않는다. 셸 카드의 "멈춤"은 `abort_bash`를 보낸다.
    - 이미지 첨부(v0.16): 붙여넣기·끌어 놓기로 PNG·JPEG·GIF·WebP를 받는다(한 장 20MB, 한 번에 10장). 질문과 함께 RPC `images`로 보낸다. 크기 조정은 Pi가 모델 설정대로 하므로 하지 않는다. 이미지를 받지 않는 모델(input에 "image" 없음)이면 Pi가 이미지 대신 "(image omitted …)"를 보내므로, 첨부할 때 미리 안내한다.
    - `@` 파일 피커(v0.15): 데몬의 `fs.search`가 세션 작업 폴더에서 찾는다. git 저장소면 `git ls-files`(.gitignore 존중), 아니면 생성물 폴더를 빼고 훑는다. 목록은 10초 캐시한다. 고르면 `@경로`만 넣는다. Pi RPC는 프롬프트 속 `@경로`를 펼치지 않으므로(TUI도 경로만 넣음) 모델이 필요하면 read 툴로 읽는다.
    - 대기 큐(v0.12): `queue_update`로 받은 Steer·Follow-up을 입력창 위에 보여준다. "비우고 입력창으로"와 "중단"은 `clear_queue`로 꺼낸 글을 입력창에 되돌린다. Pi는 `abort`만 하면 큐를 이어서 처리하므로, 중단은 큐를 먼저 꺼낸 뒤 abort한다.
- **상단 바**: 모델 선택(`get_available_models`, 프로바이더별 그룹·검색), thinking level, 컨텍스트 사용량 게이지(`get_session_stats`), 비용, Compact 버튼, 자동 컴팩션 토글
  - **구현 메모 (M1, v0.14)**: 모델 선택은 검색창이 있는 선택기다. 최근 사용 5개(모든 탭 공통)를 맨 위에 두고 프로바이더별로 묶는다. 키보드(↑·↓·Enter·Esc)로 고를 수 있다. 목록에 없는 현재 모델(확장이 바꾼 모델)도 보인다. 자동 컴팩션 토글은 Compact 옆 "자동" 체크다(v0.18).
- **세션 사이드바**: 워크스페이스별 세션 목록과 검색, 이름 변경, HTML export, **트리 뷰(`get_tree`)에서 노드를 골라 fork/clone**
  - **구현 메모 (M1, v0.13)**: 검색은 실행 중·기록 목록을 이름·첫 메시지·폴더·파일 경로로 거른다. 이름 변경은 보고 있는 실행 중 세션만 된다(`set_session_name`에 Pi 프로세스가 필요). 기록에서 고른 세션은 열어서 바꾼다. HTML export는 세션 파일 옆에 만든다. Pi 기본 위치는 작업 폴더(사용자 저장소)이고, Pi는 없는 폴더를 만들지 않기 때문이다. 만든 파일은 로컬·WSL이면 탐색기에서 보여준다.
- **확장 UI**: select/confirm/input/editor는 모달로, timeout이 있으면 카운트다운을 보여준다. notify는 토스트, setStatus는 상태바, setWidget은 우측 패널, setTitle은 탭 제목으로.
- **재시도·오류**: 자동 재시도 진행 표시와 `abort_retry`, 오류 메시지 카드에 "다시 시도" 버튼
  - **구현 메모 (M1, v0.12)**: Pi는 재시도할 때마다 내용 없는 오류 응답을 남기므로, 재시도가 시작되면 그 응답은 화면에서 빼고 재시도 안내로 대신한다. "다시 시도"는 Pi에 해당 RPC가 없어서 **"다시 보내기"**(마지막 질문을 입력창에 채우기)로 구현했다. 바로 보내면 같은 질문이 기록에 겹쳐 쌓이기 때문이다.
- **키보드 우선**: 명령 팔레트(Ctrl+K), 단축키는 Pi `keybindings.json`의 의미를 가능한 한 따른다.
  - **구현 메모 (M1, v0.18)**: Ctrl+K 팔레트는 보이는 탭의 Workspace가 연다. 탭 명령은 App이 넘겨준다. 세션 전환, 최근 기록, 실행 제어, Compact·자동 컴팩션, 트리, 내보내기, TUI, Thinking·모델, Pi 명령을 담는다. 지금 쓸 수 없는 명령은 목록에서 뺀다. Pi `keybindings.json`을 따르는 단축키는 후속 작업이다.

### 4.2 Context & Instructions
- **AGENTS.md 계층 뷰**: agent-dir → 상위 디렉터리들 → cwd 순서로 실제 로드되는 파일을 나열한다(`sdk.contextFiles`). 각 파일을 Monaco로 편집하고, `AGENTS.override.md`가 있으면 무엇을 대체하는지 표시한다.
- `SYSTEM.md` / `APPEND_SYSTEM.md`(user/project) 편집과 **실제 적용되는 시스템 프롬프트 미리보기**

### 4.3 Prompt Templates · 4.4 Skills · 4.5 Extensions
v0.1과 같다. 목록마다 출처 배지(user / project / package 이름)를 달고, 생성 마법사, 활성/비활성 토글, 로드 진단을 제공한다. Extension Dev Mode는 저장할 때마다 자동 reload한다.

**구현 메모: 리소스 창 (M4 첫 단계, v0.30)** — 읽기 전용이다. 편집·생성·토글은 다음 단계에서 한다.
- 데몬의 `resources.list({cwd})`가 그 호스트에 설치된 Pi의 SDK로 Pi와 똑같이 찾는다.
  - 프롬프트·스킬·AGENTS.md·SYSTEM.md·APPEND_SYSTEM.md: `DefaultResourceLoader`를 `noExtensions`로 돌린다.
  - 확장·테마: 확장은 불러오는 순간 코드가 실행된다. 그래서 `DefaultPackageManager.resolve`의 경로 해석으로 목록만 얻고, 설치되지 않은 패키지는 설치하지 않고 건너뛴다. 확장 코드가 실행되지 않음을 테스트로 확인한다.
  - 설정에서 꺼 둔 프롬프트·스킬은 로더가 돌려주지 않으므로 경로 해석 결과에서 "꺼짐"으로 채운다.
  - 이름 충돌 같은 진단은 그 파일 항목에 표시한다.
- 앱: 상단의 "리소스" 버튼과 명령 팔레트 "리소스 보기"로 연다. 기준은 보고 있는 세션의 폴더, 없으면 입력창의 폴더다.
  - 탭: 컨텍스트(불러오는 순서) / 프롬프트 / 스킬 / 확장 / 패키지
  - 출처 배지(사용자·프로젝트·패키지 소스), 짧은 경로(`~agent/…`, `./…`, `../AGENTS.md`), 로컬·WSL이면 "위치 열기"
- "알 수 없는 메서드" 오류에는 상단의 "Agent 업데이트 대기"를 눌러 바꾸라는 안내를 덧붙인다. 세션이 돌고 있으면 예전 데몬을 유지하므로(§3.4) 생기는 일이며, 개발 중 실제로 만났다.

**구현 메모: 리소스 편집 (M4, v0.31)** — 마크다운 리소스(AGENTS.md·프롬프트·스킬)만 고치고 만든다. 토글과 삭제는 아직 없다.
- 데몬의 `resources.read` / `resources.write` / `resources.create`
  - 다루는 파일은 Pi가 리소스로 읽는 `.md`뿐이다. 데이터 폴더 안, 작업 폴더나 상위 폴더의 `.pi/` 안, 작업 폴더나 상위 폴더에 바로 있는 AGENTS.md·CLAUDE.md만 허용한다. `auth.json` 같은 설정은 막힌다.
  - 쓰기는 임시 파일에 쓴 뒤 바꿔치기한다(§5.7). 앱이 읽은 뒤 파일이 바뀌었으면(수정 시각 비교) 덮어쓰지 않는다.
  - 덮어쓰기 전 내용은 파일마다 하나씩 앱 홈의 `resource-backups/`에 남긴다. 처음에는 파일 옆 `.bak`으로 했으나, 사용자 저장소에 `AGENTS.md.bak`이 생겨 바꿨다.
  - 새 프롬프트·스킬은 사용자(데이터 폴더) 또는 프로젝트(`.pi/`)에 틀을 갖춰 만든다. 이름 규칙은 Pi 스킬 규칙과 같다(소문자·숫자·하이픈, 64자 이하). 이미 있으면 거부한다.
- 앱: 리소스 창 항목의 "편집"으로 편집기를 연다. 패키지에 든 것과 확장 코드는 고치지 않는다.
  - Ctrl+S로 저장한다. 거부되면 "다시 열기"로 바뀐 내용을 본다.
  - 저장하지 않고 나가려 하면 확인을 받는다.
  - 탭 위의 "새 …" 칸으로 만든다.
- 반영 시점: Pi RPC에는 다시 불러오기 명령이 없고, 확장 명령의 `ctx.reload()`로만 할 수 있다. 처음에는 "새로 여는 세션부터 반영"이라고만 안내했다. v0.32부터는 저장한 뒤 "지금 세션에 반영"으로 §5.3 bridge 확장의 `/desktop:reload`를 보낸다.

### 4.6 Marketplace (신규) — 커뮤니티 리소스 검색·설치·제거

**카탈로그 소스**는 플러그형 `CatalogProvider` 인터페이스로 만든다.

| Provider | 데이터 출처 | 설치 방식 |
|---|---|---|
| **npm** | `registry.npmjs.org/-/v1/search?text=keywords:pi-package` (다운로드 수, 최근 업데이트 포함) | `pi install npm:<name>@<ver>` |
| ~~pi.dev 갤러리~~ | 공개 API 없음(`/api/packages` → 501, 페이지는 서버 렌더링 HTML). 갤러리도 npm `pi-package` 키워드를 기준으로 하므로 npm 검색으로 충분하다. 미리보기는 `package.json`의 `pi.image`/`pi.video`를 직접 읽고, 상세 화면에 "pi.dev에서 보기" 링크만 둔다 | — |
| **GitHub 저장소** | 사용자가 등록한 저장소(기본 예시: `anthropics/skills`, `badlogic/pi-skills`). GitHub API로 `SKILL.md`, `prompts/*.md`, `package.json`의 `pi` 매니페스트를 스캔 | 패키지 형태면 `pi install git:...@<ref>`, 개별 스킬·프롬프트면 해당 폴더만 복사(§아래) |
| **URL / 로컬 경로** | 직접 입력 | `pi install <url\|path>` |

**화면**
- 검색창 + 필터(종류: extension / skill / prompt / theme, 정렬: 인기·최신, 출처)
- 상세 페이지: README 렌더링, 포함된 리소스 목록(매니페스트 분석), 버전 목록, 저장소 링크, 다운로드 수, **보안 요약**(확장 코드 포함 여부, `dependencies` 목록, 설치 스크립트 유무)
- 설치 대화상자: 범위(User / 이 프로젝트), 버전 고정 여부, **포함할 리소스 선택**(settings의 패키지 필터로 저장)
- "설치됨" 탭: `pi list` 결과, 업데이트 가능 표시(`pi update <source>`), 제거(`pi remove`), 리소스 필터 편집(`pi config`에 해당)

**구현 메모: 작업 기록 (M4, v0.47)** — 위 보안 원칙의 "활동 로그"
- 저장
  - 앱 userData의 `activity-log.jsonl`에 한 줄씩 덧붙인다.
  - 2500줄을 넘으면 최근 2000줄만 둔다. 깨진 줄은 건너뛴다.
- 남기는 자리
  - main의 IPC 처리기를 한 자리(`handle`)에서 감싼다. 기록할 채널 표(`LOGGED`)에 있으면 무엇을 했는지와 성공·실패(이유)를 남긴다.
  - 키 값·파일 내용은 적지 않는다.
- 대상
  - SSH 호스트 저장·삭제, Agent 교체
  - GitHub 가져오기·업데이트·제거
  - 다른 호스트에서 복사(리소스 받기는 실패만 남긴다)
  - models.json 프로바이더 저장·삭제·받기, API 키 저장·자격 증명 삭제
  - 패키지 필터, settings.json 변경·JSON 저장, 프로젝트 신뢰
  - 리소스 저장·만들기, Pi 데이터 백업·삭제, Pi 업데이트
- 터미널 명령: 앱이 내장 터미널에서 대신 실행하는 명령(pi 인자, 셸 초기 입력)은 열 때 화면이 `logAction`으로 남긴다.
  - 해당 명령: Marketplace 설치, 패키지 업데이트·제거, Pi 설치·제거, OAuth 로그인 등
  - 결과는 알 수 없어 "실행함"만 적는다. 사용자가 직접 연 빈 터미널은 남기지 않는다.
- 화면: 탭 바의 "활동"을 "세션 / 작업 기록"으로 나눈다. 작업 기록은 최근 200개를 호스트 이름·시각과 함께 보인다. 실패는 빨갛게 이유와 함께 보인다.
- 확인: dev 환경에서 세 가지를 하자 그대로 나왔다.
  - 설정 폼 저장(성공)
  - 바깥에서 바뀐 뒤 JSON 저장(실패와 이유)
  - OAuth 로그인 터미널(명령)
  - 시험 뒤 기록 파일과 설정은 지웠다.

**개별 스킬·프롬프트 가져오기** (패키지가 아닌 단일 폴더나 파일)
- 패키지 매니저를 거치지 않고 해당 폴더(`SKILL.md` + 부속 파일)나 `.md`만 `~/.pi/agent/skills/<name>/`(또는 `.pi/skills/`)로 복사한다.
- 출처, 커밋 SHA, 파일 해시를 GUI 메타데이터(`userData/imports.json`)에 기록한다. 이를 근거로 **업데이트 확인**과 **로컬 수정 감지**(수정됐으면 덮어쓰기 전에 diff를 보여줌), **깨끗한 제거**를 한다.
- 이름이 충돌하면 이름 변경, 덮어쓰기, 취소 중에서 고르게 한다.

**보안 원칙** (Pi 문서의 권고를 그대로 반영)
- 확장이 포함된 패키지는 설치 전에 "임의 코드가 실행됩니다" 경고와 소스 링크를 보여준다.
- 프로젝트 범위 설치는 프로젝트 trust 상태를 함께 표시한다.
- 설치와 제거는 모두 활동 로그에 남긴다.

**구현 메모: Marketplace 첫 단계 (M4, v0.34)** — npm 카탈로그만. GitHub 저장소 카탈로그, 개별 스킬 가져오기, 리소스 필터 편집은 다음 단계다.
- 카탈로그 조회
  - 공개 npm 레지스트리만 읽으므로 이 PC의 main 프로세스가 조회한다.
  - 검색: `/-/v1/search?text=keywords:pi-package <검색어>`. 이름·버전·설명·게시자·월간 다운로드·게시 시각을 보인다.
  - 상세: 패키지 문서 하나에서 README(20만 자까지)·최근 안정 버전·라이선스·저장소를 얻고, 보안 요약을 만든다.
- 보안 요약
  - `pi` 매니페스트에 적힌 리소스 종류를 보인다. 매니페스트가 없으면 관례 폴더로 찾아 미리 알 수 없으므로 코드 실행 가능성이 있다고 본다.
  - 확장 코드 실행 경고, 설치 스크립트(preinstall·install·postinstall), 의존성 목록을 보인다.
  - README의 HTML은 그리지 않고 글자로 둔다.
- 설치·제거·업데이트: 그 호스트의 `pi install/remove/update`를 내장 터미널에서 눈앞에 실행한다.
  - 버전 기본값 "최신"은 `pi update`로 갱신된다. 특정 버전을 고르면 고정되어 업데이트되지 않으므로, 업데이트 버튼을 막는다.
  - 범위: 사용자 / 이 프로젝트(`-l`, 신뢰해야 불러옴)
  - 사용자 범위 명령은 홈에서, 프로젝트 범위만 그 폴더에서 실행한다. 프로젝트 폴더에서 실행하면 Pi가 그 폴더의 신뢰를 TUI 메뉴로 묻는 것을 확인했다.
  - 패키지 이름(앞쪽 하이픈 금지)과 버전 형식을 확인한 뒤에만 명령을 만든다.
- 리소스 창 패키지 탭: 업데이트·제거(한 번 더 확인)와 "Marketplace에서 패키지 찾기"
- 활동 로그는 v0.47에서 붙였다(아래 "작업 기록" 메모).
- 확인: 격리된 개발 환경에서 스킬만 든 패키지를 설치하고 제거했다(설정의 `packages` 반영, 리소스 창에 패키지 스킬 표시).

**구현 메모: GitHub 개별 가져오기 (M4, v0.35)** — 가져오기와 출처 기록까지. 업데이트 확인·로컬 수정 감지·제거, 사용자가 저장소 목록을 저장하는 기능은 다음 단계다.
- 카탈로그 조회(main)
  - 저장소(`owner/repo[@ref]` 또는 주소)를 `GET /repos/o/r/commits/<ref|HEAD>`로 커밋 SHA에 고정하고, `git/trees/<sha>?recursive=1`로 한 번에 훑는다. API 호출은 저장소당 두 번이다.
  - 인증 없이는 시간당 60회 한도라, 넘으면 그렇게 알린다. 파일 내용은 한도에 들지 않는 `raw.githubusercontent.com/<o>/<r>/<sha>/<경로>`에서 받는다.
  - `SKILL.md`가 든 폴더를 스킬로 본다. 중첩된 스킬은 각자의 것으로 나눈다. 스킬 폴더 밖의 `prompts/*.md`는 프롬프트로 본다.
- 가져오기
  - 이 PC가 파일을 받은 뒤(200개, 10MB 한도) 그 호스트 데몬의 `resources.import`로 쓴다. 쓴 뒤에 출처를 userData의 `imports.json`에 남긴다: 호스트·쓴 곳·저장소·커밋 SHA·저장소 안 경로·파일별 git blob SHA.
  - 데몬은 스킬을 `skills/<이름>/`에 폴더째, 프롬프트를 `prompts/<이름>.md`로 쓴다. 이미 있으면 거부한다(이름 충돌은 다른 이름으로 가져오게 한다).
  - 파일 경로는 스킬 폴더 안으로만 쓴다. 임시 폴더에 다 쓴 뒤 이름을 바꿔, 실패해도 반쯤 쓴 스킬이 남지 않는다.
- 화면
  - Marketplace에 npm / GitHub 탭을 둔다. 예시 저장소(`anthropics/skills`, `badlogic/pi-skills`)를 바로 열 수 있다.
  - 스킬 상세에서는 SKILL.md 앞머리를 따로 보이고, 실행 스크립트(.sh·.py·.js 등)를 경고와 함께 나열한다. 스킬은 모델이 그 스크립트를 실행하게 할 수 있기 때문이다.
  - 가져온 항목은 "가져옴"으로 표시한다.
- 확인: `anthropics/skills`(스킬 20개)와 `badlogic/pi-skills`(8개)를 실제로 훑었다. `brand-guidelines`를 격리된 개발 환경에 가져와 파일 2개가 쓰이고 리소스 목록에 나타났다. 출처 기록, "가져옴" 표시, 같은 이름 재가져오기 거부도 확인했다.

**구현 메모: 패키지 리소스 필터 편집 (M4, v0.44)** — 설치된 패키지의 리소스를 하나씩 켜고 끈다(`pi config`에 해당).
- 데몬
  - `packages.resources`: Pi 패키지 매니저의 `resolve`로, 설정에 적힌 소스·범위가 같은 패키지 리소스를 모은다.
    - 종류: 확장·스킬·프롬프트·테마
    - 항목마다 켜짐 여부와 패턴을 준다. 패턴은 리소스 기준 폴더(`baseDir`, 보통 패키지 루트)에서의 상대 경로다.
  - `packages.setFilter`: 바꾼 것만 받아 그 범위(user·project)의 settings.json 패키지 항목에 적는다. 규칙은 `pi config`와 같다.
    - 문자열 소스는 객체로 바꾼다.
    - 같은 경로를 가리키던 이전 항목(`+`·`-`·`!`·그대로)은 지우고 `+경로`(켬)나 `-경로`(끔)를 붙인다.
    - 필터가 하나도 없으면 문자열 소스로 되돌린다(`autoload` 같은 다른 키가 있으면 객체로 둔다). 빈 배열 `[]`은 "그 종류는 하나도 불러오지 않음"이라 지우지 않는다(v0.48에서 고침).
    - 손으로 쓴 glob 패턴은 남긴다.
    - `reset`이면 필터를 모두 지운다.
  - 쓰기는 Pi의 `SettingsManager`(`setPackages`·`setProjectPackages`·`flush`)로 한다. Pi와 같은 잠금·병합을 쓴다.
  - Windows에서는 패턴이 `skills\b\SKILL.md`처럼 백슬래시로 적힌다. `pi config`와 같다.
- 앱: 리소스 창 패키지 탭
  - 설치된 패키지에 "리소스 고르기"가 있다. 누르면 그 줄 아래에 종류별 체크박스가 열린다.
  - 바꾼 개수만큼 "n개 바꾸기"로 저장한다. 필터가 있으면 "필터 지우고 모두 켜기"도 보인다.
  - 저장한 뒤 목록을 다시 읽어 "일부만 사용"과 각 탭의 "꺼짐" 표시가 바로 바뀐다. 열린 세션은 "지금 세션에 반영"이나 다시 열기로 반영한다.
- 프로젝트 범위의 "사용자 패키지 위 덧씌우기"는 v0.49에서 붙였다(아래 "§5.9 마무리" 메모).
- 확인: 격리된 dev 데이터 폴더에 로컬 경로 패키지(스킬 2·프롬프트 1)를 등록했다.
  - 스킬 하나를 끄자 settings.json에 `-skills\beta\SKILL.md`가 적혔고, 스킬 탭에서 "꺼짐"이 되었다.
  - "필터 지우고 모두 켜기"로 문자열 소스로 돌아왔다.
  - 시험 뒤 설정과 패키지는 되돌렸다.

**구현 메모: 설치·복사에 패키지 필터 잇기 (M4, v0.48)**
- 언제 적나
  - 설치는 내장 터미널의 `pi install`이다. 설치 전에는 settings에 패키지 항목이 없으므로 터미널이 코드 0으로 끝난 뒤에 적는다.
  - 이를 위해 터미널 도크에 `onSuccess`를 두었다.
- 데몬: `packages.setFilter`에 `set`(종류별 배열을 통째로)을 더했다. 사용자 범위는 `cwd` 없이도 된다.
- Marketplace 상세
  - 매니페스트에 둘 이상의 종류가 선언되어 있으면 "포함할 리소스" 체크박스를 보인다.
  - 뺀 종류는 설치 뒤 `[]`로 적는다.
- 다른 호스트에 설치
  - 원본 패키지 항목의 필터 배열을 읽어 둔다. 대상 설치가 끝나면 필터를 지우고 그 배열을 적는다.
  - Pi가 하나씩 켜고 끄며 적은 `+경로`·`-경로`는 대상 OS 구분자로 바꾼다. 손으로 쓴 glob은 그대로 둔다.
  - "필터도 옮기기"는 끌 수 있다.
- 작업 기록에는 "필터 적용: skills 1개, prompts 빼기"처럼 남는다.
- 확인
  - 로컬(Windows) dev에서 "리소스 고르기"로 `npm:@tmustier/pi-skill-creator`의 스킬을 껐다.
  - "다른 호스트에 설치"로 WSL에 설치하자, 끝난 뒤 WSL 설정에 같은 필터가 적혔다. WSL 리소스 창에서도 그 스킬이 "꺼짐"이었다.
  - Marketplace에서 `pi-subagents`(확장·스킬·프롬프트) 상세에 체크박스가 나왔다. 실제로 설치하지는 않았다.
  - 시험 뒤 WSL 설정·패키지 폴더와 dev 설정은 되돌렸다.

**구현 메모: 가져온 항목 관리 (M4, v0.36)** — 업데이트 확인·로컬 수정 감지·차이·업데이트·제거.
- 로컬 수정 감지
  - 데몬 `resources.inspectImported`가 가져온 폴더·파일의 git blob SHA(`git hash-object`와 같은 값)를 계산한다.
  - 이것을 가져올 때 GitHub 트리에서 기록한 SHA와 비교해, 고치거나 더하거나 지운 파일을 찾는다.
- 업데이트 확인: 원본 저장소의 최신 커밋 트리에서 같은 폴더·경로의 SHA와 비교한다. 같은 저장소는 한 번만 훑는다.
  - 기록에는 브랜치가 없어서 기본 브랜치의 최신과 비교한다. `@브랜치`로 가져온 항목도 기본 브랜치와 비교된다.
- 차이 보기: 파일을 골라 이 호스트 내용(`resources.readImported`)과 원본 최신 내용을 줄 단위로 비교한다(LCS, 주변 3줄). 툴 카드의 DiffView로 그린다.
- 업데이트: 원본 최신으로 다시 받아 `resources.import`의 `replace`로 바꾼다.
  - 새 내용을 다 쓴 뒤 이전 것을 앱 홈 `resource-backups/imports/<이름>-<시각>`으로 옮긴다. 바꾸다 실패하면 되돌린다.
  - 이 호스트에서 고친 항목은 "고친 내용 백업하고 바꾸기"로 한 번 더 확인한다.
- 제거: 바로 지우지 않고 같은 백업 폴더로 옮긴 뒤 기록을 지운다.
- 데몬은 앱 기록을 그대로 믿지 않는다. 데이터 폴더나 `.pi/` 바로 아래의 `skills/<이름>`, `prompts/<이름>.md`만 다루고, 다른 드라이브로 옮길 때는 복사 후 지운다.
- 확인: `brand-guidelines`를 원본이 그 뒤 바뀐 예전 커밋(`ef740771ac`)에서 가져오고 로컬 SKILL.md에 한 줄을 더했다.
  - 상태: "이 호스트에서 고침 1개, 원본 새 버전 1개 파일"
  - 차이: LICENSE 저작권 줄(원본 변경)과 더한 줄(로컬 수정)
  - 업데이트: 최신 커밋으로 바뀌고, 고친 내용은 백업에 남았으며, 다시 확인하니 "최신"
  - 제거: 백업 폴더로 옮겨지고 기록이 비었다.

### 4.7 Providers & Models
- 프로바이더별 상태는 `pi auth check --provider X --json`으로 확인한다(ready / not_ready / invalid). **키 값은 렌더러로 보내지 않는다.**
- **API 키 등록**: GUI 폼으로 입력받아 Host Agent가 `auth.json`에 원자적으로 쓴다. 저장 후 `auth check`로 검증한다. `!command` 형식(시크릿 매니저 연동)도 지원한다.
- **OAuth 로그인**: 내장 터미널(xterm.js + `pty.open`)에서 `pi`를 띄워 `/login <provider>`를 실행한다. 원격이나 WSL에서 콜백이 닿지 않으면, Pi가 안내하는 대로 리다이렉트 URL을 붙여넣는 흐름을 그대로 쓴다.
- `models.json`은 스키마 기반 폼으로 편집한다(OpenAI 호환 엔드포인트, Ollama, llama.cpp 등). "연결 테스트" 버튼과 `pi update --models`(모델 카탈로그 새로고침)를 제공한다.

**구현 메모 (M2, v0.21)**
- 프로바이더 목록은 설치된 Pi 옆의 pi-ai `builtinProviders()`(ID·이름·API 키/OAuth 지원)에 models.json·auth.json의 프로바이더를 합친다. Pi 버전에 맞게 따라가도록 데몬 번들에 넣지 않는다.
- 상태는 `pi auth check --json`으로 확인한다. 저장된 것만 자동으로 확인하고, 나머지는 버튼으로 확인한다.
- API 키는 데몬이 auth.json에 원자적으로 쓴다(POSIX 600). 같은 항목의 `env`는 남긴다.
- 목록에는 자격 증명의 종류만 담고 키 값은 돌려주지 않는다.
- models.json 폼(v0.22)
  - 사용자 정의 프로바이더의 name·baseUrl·api·apiKey와 모델의 id·name·reasoning·이미지 입력·contextWindow·maxTokens만 다룬다. 나머지(compat, headers, modelOverrides, cost 등)는 그대로 둔다.
  - apiKey가 그대로 키 값이면 가리고, 바꾸지 않으면 유지한다.
  - 쓰기 전에 `models.json.bak`으로 백업하고, 깨진 파일은 덮어쓰지 않는다.
  - "연결 테스트"는 데몬이 그 호스트에서 `{baseUrl}/models`를 불러 모델 ID를 가져온다(WSL의 localhost가 맞게).
- OAuth 로그인은 내장 터미널에서 한다(§4.12, v0.23).

### 4.8 Settings
v0.1과 같다. 스키마 기반 폼, User/Project 탭, diff 미리보기 후 저장, 원본 JSON 편집 모드.

**구현 메모: 설정 폼 첫 단계 (M4, v0.45)** — Pi 관리의 "설정" 탭(편집 / 다른 호스트로 복사), 사용자 범위만
- 스키마
  - 데몬의 `settings.schema`가 그 호스트에 설치된 Pi의 `schemas/settings.schema.json`을 그대로 준다.
  - 앱에 항목을 적어 두지 않으므로 Pi 버전마다 늘거나 바뀐 항목을 따른다(§1 기능 감지).
  - 스키마를 배포하지 않는 Pi면 폼을 만들 수 없다고 알린다.
- 필드로 바꾸는 규칙
  - boolean, 숫자(정수), 문자열은 그대로 쓴다.
  - `enum`과 const들의 `anyOf`는 선택지로 쓴다. `boolean|const`는 true·false·const 선택지가 된다.
  - `number|const`는 숫자 또는 그 값을 받는 입력이다.
  - 속성이 있는 객체는 한 단계 펼친다(`compaction.enabled`).
  - 배열·패턴 객체·더 깊은 객체는 "폼에서 다루지 않는 항목"으로 이름만 알린다.
  - 숨기는 것
    - Pi 내부 값: `lastChangelogVersion`·`deviceId`·`trackingId`·`$schema`
    - 다른 화면에서 다루는 목록: `packages`·`extensions`·`skills`·`prompts`·`themes`
- 화면
  - 자주 쓰는 설정(기본 모델·생각 수준·신뢰·steering·compaction·retry 등)을 먼저 보이고, 나머지는 접어 둔다. 이름·설명으로 찾는다.
  - 값이 없으면 "기본값(스키마 default)"으로 보인다. 비우거나 "기본값"을 고르면 키를 지운다. 하위 필드가 모두 비면 상위 키도 지운다.
  - 맞지 않는 입력이 있으면 저장을 막는다. 저장 전에 "지금 → 바꿀 값"을 미리 본다.
- 저장
  - `settings.merge`로 고친 최상위 키만 바꾼다. 하위 필드는 지금 객체에 덮어 보낸다.
  - 지울 키는 `remove`로 보낸다. 이전 파일은 `settings.json.bak`으로 남는다.
- 확인: 격리된 dev 설정에서 확인했다.
  - 바꾼 것: 생각 수준, compaction 두 필드, `httpIdleTimeoutMs: "disabled"`
  - 잘못된 값은 저장이 막혔다.
  - 미리보기 뒤 저장하자 그 키들만 바뀌었다.
  - compaction 하위 필드를 기본값으로 되돌리자 `compaction` 키가 지워졌다.

**구현 메모: 설정 폼 2단계 (M4, v0.46)** — 프로젝트 범위와 원본 JSON 편집
- 데몬
  - `settings.read`·`merge`가 `scope`·`cwd`를 받는다. 프로젝트 범위는 작업 폴더의 `.pi/settings.json`이다.
  - `settings.read`는 경로·원본 글·수정 시각도 준다. 깨진 파일도 원본 글은 준다.
  - `settings.write`(JSON 모드)
    - 원본 글을 그대로 쓴다. 최상위가 객체인 JSON이어야 한다.
    - 읽을 때의 수정 시각과 다르면 거부한다. 새 파일은 `null`로 보낸다.
    - `.bak` 백업 뒤 원자적으로 쓰고, 없던 `.pi` 폴더는 만든다.
- 앱: 설정 → 편집
  - 범위: 사용자 / 프로젝트를 고른다. 프로젝트 폴더는 지금 탭의 폴더를 기본으로 넣는다(Pi 관리를 연 호스트일 때).
    - 프로젝트 범위에서는 이 내용을 알린다: 같은 키는 사용자 설정보다 우선한다. 폴더를 신뢰해야 쓰인다. "Global setting only" 항목은 사용자 범위에서만 쓰인다.
  - 방식: 폼 / JSON
    - JSON은 고친 글을 차이(DiffView)로 본 뒤 저장한다.
    - 맞지 않는 JSON이면 저장을 막는다. 폼으로 다루지 않는 목록·묶음과 깨진 파일은 여기서 고친다.
- 확인: 격리된 dev 환경에서 확인했다.
  - 프로젝트 범위 폼으로 `.dev/.pi/settings.json`을 새로 만들었다.
  - 사용자 범위 JSON 모드에서 확인한 것
    - 잘못된 글은 저장이 막혔다.
    - 차이를 본 뒤 저장했다.
    - 읽은 뒤 바깥에서 파일을 바꾸자 저장이 거부되었다.
  - 시험 뒤 설정은 되돌렸다.

### 4.9 Pi Manager (신규) — 설치·업데이트·사용·제거

호스트마다(로컬, WSL 배포판, SSH 서버) 하나씩 있는 화면이다.

**상태 감지** (`pi.locate`)

| 항목 | 방법 |
|---|---|
| 설치 여부와 경로 | `command -v pi` / `where pi`, `npm root -g` |
| **설치 방식** | 관리형 설치기(`managed-install.json` 마커) / npm 전역 / Nix(`/nix/store` 경로) / 기타 |
| 버전 | `pi --version`, 최신 버전은 `npm view @earendil-works/pi-coding-agent version` |
| 전제 조건 | Node ≥ 22.19, Windows는 Git Bash(또는 `shellPath`, PowerShell 툴 설정) |
| 데이터 | `~/.pi/agent` 크기, 세션 수, 인증된 프로바이더 수 |

**구현 메모 (M2 첫 단계, v0.19)**: 읽기 전용 상태 화면부터 만들었다. 데몬의 `pi.status`가 다음을 돌려준다. 바꾸는 동작은 아직 없다.
- 찾은 Pi(경로·버전·설치 방식)
- Pi를 실행할 node와 Pi `engines.node` 충족 여부
- Git Bash(Windows, Pi와 같이 `settings.json`의 `shellPath` → Git for Windows 순)
- 세션 수·크기, 설정 파일 유무
- auth.json의 프로바이더 이름 (키 값은 보내지 않음)

최신 버전은 `pi.latest`(`npm view`, 1시간 캐시)로 조회한다. 상단 바에 Pi 버전과 "↑ 새 버전"을 표시한다. PATH 탐색, Nix 설치 감지, `~/.pi/agent` 전체 크기는 아직 없다.

**설치 마법사**

| 대상 | 기본 방법 | 대안 |
|---|---|---|
| macOS / Linux / WSL / SSH | 공식 설치기: `curl -fsSL https://pi.dev/install.sh \| sh` (스크립트 내용을 먼저 보여주고 동의를 받은 뒤 **내장 터미널에서 실행**. 설치기가 대화형 메뉴를 쓰기 때문) | `npm install -g --ignore-scripts @earendil-works/pi-coding-agent` |
| Windows 네이티브 | Node가 22.19 이상인지 확인 → 없으면 `winget install OpenJS.NodeJS.LTS` 안내(동의 후 실행) → `npm install -g --ignore-scripts @earendil-works/pi-coding-agent` | — |
| 공통 후속 단계 | Git Bash 확인(Windows), 프로바이더 로그인(§4.7), 기본 모델 선택, 첫 워크스페이스 열기 | |

**업데이트**
- 시작할 때와 주기적으로 최신 버전을 확인하고 배지로 알린다. CHANGELOG의 해당 구간을 보여준다.
- 실행: `pi update`(Pi만) / `pi update --extensions` / `pi update --all`. Nix 설치는 `nix profile upgrade pi` 명령을 안내만 한다.
- 실행 중인 세션은 안전하게 정지(`agent_settled`까지 대기하거나 사용자 확인 후 abort)한 다음 업데이트하고, 끝나면 각 세션을 `sessionFile`로 다시 연다.
- **특정 버전 설치·롤백**: `npm i -g @earendil-works/pi-coding-agent@<ver>`. GUI 호환 범위(`supportedPi`) 밖이면 경고한다.

**구현 메모 (M2, v0.20)**
- 업데이트는 데몬의 `pi.update`가 Pi의 `pi update`를 그대로 실행한다. 대상은 self·extensions·all·models만 받는다. 설치 방식 판단은 Pi에 맡긴다. Pi는 npm 전역·관리형 설치가 아니면 스스로 거부한다.
- 거부해도 종료 코드가 0이라, 성공 여부는 실행 전·후 버전으로 판단하고 거부는 출력 문구로 알아본다. 진행 출력은 `pi.updateOutput` 알림으로 보낸다.
- 실행 중인 세션은 멈추지 않는다. 업데이트 전에 "그 세션은 지금 버전으로 계속 돌고, 새 버전을 쓰려면 다시 열어야 한다"고 알리고 확인을 받는다. 자동 정지·재시작과 특정 버전 설치·롤백은 후속 작업이다.

**구현 메모: 설치·다른 버전·제거 (M2, v0.24)**
- 앱은 명령을 몰래 실행하지 않는다. 실행할 명령을 그대로 보여주고, 확인하면 그 호스트의 내장 터미널(셸)에 입력해 눈앞에서 돈다.
- Windows는 `npm.cmd install -g --ignore-scripts`로 설치한다(PowerShell 실행 정책 때문에 npm.ps1 대신 npm.cmd). Node가 부족하면 `winget install OpenJS.NodeJS.LTS` 단계를 둔다.
- macOS·Linux·WSL은 공식 설치기를 `~/.pi-desktop/pi-install.sh`로 내려받아 `less`로 보여준 뒤 실행한다. 설치기는 대화형 메뉴(y 다시 설치 / u 제거 / n 아무것도 안 함)로 다루므로, 관리형 설치의 제거도 설치기로 한다.
- 특정 버전·롤백은 npm 전역 설치만 된다. 설치기에는 버전 옵션이 없다.
- 데이터(`~/.pi/agent`) 처리(v0.25)
  - 백업: 언제든 `<앱 홈>/backups/pi-agent-<날짜시각>.tar.gz`로 만든다(POSIX 600, Windows는 System32 tar).
  - 삭제: Pi를 제거한 뒤에만 된다(관리형 설치는 Pi가 데이터 폴더 안에 있다). 두 번 확인하고("삭제" 직접 입력), 기본은 백업 후 삭제다.
  - 데몬의 안전장치: 실행 중 세션, Pi가 그 안에 설치됨, 확인 경로 불일치, 홈·루트·얕은 경로는 거부한다. 폴더 안 링크(junction 포함)의 대상은 지우지 않는다.

**제거**
- 방식별 명령: 관리형 설치는 설치기의 uninstall 동작(내장 터미널), npm은 `npm uninstall -g @earendil-works/pi-coding-agent`, Nix는 안내만.
- 데이터 처리 선택: **유지**(기본) / **백업 후 삭제**(`~/.pi/agent`를 zip으로 보관한 뒤 삭제) / 그대로 삭제. 삭제 옵션은 두 번 확인한다. `auth.json`이 포함된다는 점을 명시한다.

**"사용"**: 호스트 카드에서 바로 "워크스페이스 열기", "터미널에서 pi 열기"(내장 xterm)를 제공한다.

### 4.10 SDK Playground · 4.11 Event Inspector
v0.1과 같다. Playground 스크립트도 Host Agent를 통해 **대상 호스트에서** 실행되므로 WSL이나 원격의 Pi SDK로 개발하고 테스트할 수 있다.

**구현 메모: Event Inspector (M5, v0.50)** — 세션의 RPC 이벤트를 원본 그대로 본다
- 모으기
  - 앱(렌더러)이 켜질 때 세션 이벤트 리스너 하나를 단다. 세션마다 최근 2000개를 원본 그대로 모은다(`event-log.ts`).
  - 그래서 Inspector를 열기 전에 온 이벤트도 보인다. 재연결 재생으로 같은 seq가 다시 와도 한 번만 담는다.
  - 화면 상태(chat-state 등)와는 따로 둔다. 데몬 변경은 없다.
- 화면: 명령 팔레트 "Event Inspector"(개발자 도구 묶음)로 지금 탭 세션의 이벤트를 연다.
  - 줄마다 seq, 받은 시각(ms까지), 종류, 한 줄 요약(메시지 역할, 내부 이벤트 종류, 도구 이름, 확장 요청 method 등)을 보인다.
  - 종류별 개수 칩을 눌러 숨긴다. 종류·원본 JSON으로 찾는다. 멈춤·비우기가 있다.
  - 줄을 펼쳐 JSON을 보고 복사한다.
  - 앱이 화면에 쓰지 않는 종류(예: `turn_start`·`turn_end`·`agent_end`)는 경고색으로 표시한다. Pi가 새 이벤트를 더하면 바로 눈에 띈다(§1 "모르는 이벤트는 raw로").
- 아직 하지 않은 것: 앱이 Pi로 보낸 명령(prompt·steer 등) 나란히 보기, 파일로 내보내기
- 확인: dev:mock 세션에서 `tool:bash` 메시지 하나를 보냈다.
  - 이벤트 30개가 종류별 개수와 함께 나왔다.
  - `turn_*`·`agent_end`가 "앱이 쓰지 않음"으로 표시되었다.
  - 펼치기·숨기기를 확인했다.

**구현 메모: Extension Dev Mode (M5, v0.51)** — 확장을 저장하면 세션에 바로 반영한다(§4.5)
- 데몬: `files.watchTree {watchId, roots}`·`files.unwatchTree`
  - 주기적으로(1초) 훑어 수정 시각·크기를 견주고, 생기거나 바뀌거나 사라진 파일을 `files.changed {watchId, paths}`로 알린다.
  - fs.watch 대신 폴링이라 WSL·네트워크 드라이브·SSH 호스트에서도 같게 동작한다.
  - `node_modules`·`.git`은 건너뛰고 2000개까지 본다. 감시는 앱 연결에 묶여 있어, 앱이 끊기면 멈춘다.
- 앱
  - 명령 팔레트(개발자 도구)에서 "Extension Dev Mode 켜기·끄기"로 쓴다. 지금 탭 세션에 입력 권한이 있을 때만 켤 수 있다.
  - 감시할 것
    - 그 세션 리소스 목록의 확장(내장·패키지에 든 것 제외). 폴더 확장은 그 폴더째 본다.
    - 사용자 `extensions`·프로젝트 `.pi/extensions` 폴더(새 확장을 잡기 위해)
  - 바뀌면 400ms 모은 뒤 `/desktop:reload`로 반영한다. Pi의 reload는 확장 런타임도 바꾼다.
    - 작업 중이면 끝난 뒤에 반영한다.
    - 반영할 때마다 감시할 뿌리를 다시 계산한다.
  - 상단에 "Dev Mode · 감시 중 / 반영 대기 / 시각 반영: 파일" 칩을 보인다. 실패는 빨갛게 이유와 함께 보인다. 누르면 끈다.
- 확인: 데이터 폴더 `extensions/hello-dev.ts`(명령 하나 등록)로 시험했다.
  - 켠 뒤 파일의 명령 설명을 고치자 "반영: hello-dev.ts"가 나왔고, `/` 자동완성의 설명이 바뀌었다.
  - 새 확장 파일을 만들자 그 명령이 생겼다.
  - 처음에는 예전 데몬이 새 메서드를 몰라 "Agent 업데이트 대기"로 바꾸라는 안내가 나왔다. 바꾼 뒤 동작했다.

**구현 메모: SDK Playground (M5, v0.52)** — 고른 호스트의 Pi SDK로 스크립트를 실행한다(§4.10)
- 데몬: `playground.run {runId, code, cwd?, timeoutMs?}`·`playground.stop {runId}`, 알림 `playground.output {runId, stream, text}`
  - 스크립트(ES 모듈 JavaScript) 앞에 `const pi = await import(<설치된 Pi의 dist/index.js>)`를 붙인다. 최상위 await를 쓸 수 있다.
  - Pi를 실행하는 것과 같은 node·환경(`PI_CODING_AGENT_DIR` 등)으로 띄운다. 파일은 앱 홈의 `playground`에 임시로 쓰고, 끝나면 지운다.
  - 출력은 요청한 앱에만 바로 알린다. 1MB를 넘으면 자른다.
  - 멈추는 경우: 제한 시간(기본 2분)을 넘을 때, stop할 때, 앱 연결이 끊길 때.
  - 응답: 종료 코드, 신호, 걸린 시간, 시간 초과, 잘림
  - 사용자가 쓴 코드를 그대로 실행하므로 터미널처럼 그 사용자의 권한으로 돈다.
- 앱: 명령 팔레트 "SDK Playground"(개발자 도구)
  - 고르는 것: 호스트(로컬·WSL·SSH), 작업 폴더(기본은 지금 탭 폴더), 제한 시간(30초·2분·10분), 예제 셋
  - 편집기: Tab은 공백 두 칸이고, Ctrl+Enter로 실행한다. 쓴 스크립트는 이 PC(localStorage)에 남는다.
  - 출력은 바로바로 보이고 표준 오류는 빨갛다. 끝나면 결과 한 줄을 보인다. 실행 중에는 중지할 수 있다.
- 참고: Pi의 `SessionManager.listAll()`은 인자가 없으면 `PI_CODING_AGENT_SESSION_DIR`을 보지 않는다. 그래서 예제는 그 변수를 넘긴다.
- 확인
  - 로컬(Windows): "최근 세션" 예제가 세션 26개를 보였다.
  - WSL(Ubuntu): `process.platform`이 linux, node v24.20.0, SDK exports 157개로 나왔다.
  - 0.3초마다 찍는 무한 루프를 중지하자 "멈춤 (SIGTERM)"이 나왔다.
  - 데몬이 예전 것이라 로컬은 "지금 바꾸기"로 바꿨다. WSL은 실행 중인 세션이 없어 앱이 알아서 바꿨다.

**구현 메모: 인스톨러·자동 업데이트 (M5, v0.53)**
- 설치 파일: electron-builder(`apps/desktop/electron-builder.yml`). `npm run dist`는 지금 OS용을 만든다.
  - 대상 형식
    - Windows: NSIS(설치 폴더 선택 가능, 사용자별 설치)
    - macOS: dmg·zip(x64·arm64)
    - Linux: AppImage·deb
  - Host Agent 번들은 앱 밖(로컬 node·WSL·SSH)에서 도는 파일이다. 그래서 asar에 넣지 않고 `resources/host-agent`에 두며, 설치본은 `process.resourcesPath`에서 찾는다. 버전은 옆의 package.json에서 읽는다.
  - 화면 의존성은 vite 번들에 들어가므로 devDependencies로 옮겼다. 설치본의 node_modules에는 node-pty·electron-updater만 들어간다(app.asar 약 7MB, 설치 파일 약 115MB).
  - node-pty는 N-API라 Electron에 맞춰 다시 빌드하지 않는다.
  - electron-builder가 정확한 버전을 요구해 Electron을 고정했다(44.9.1). 설치본의 패키지 이름은 `pi-desktop`이다.
- 코드 서명: 인증서가 없어 하지 않는다.
  - Windows는 첫 설치 때 SmartScreen 경고가 나지만 업데이트는 된다.
  - macOS는 Gatekeeper 경고가 나고 자동 설치가 거부된다(Squirrel.Mac이 서명을 요구).
- 자동 업데이트(앱 main `updater.ts`, electron-updater)
  - 배포처: GitHub Releases(`publish: github`, 공개 저장소라 토큰 없음). `publish`를 바꾸면 generic URL·S3 등도 쓸 수 있다.
  - 확인 시점: 시작 15초 뒤, 6시간마다, 명령 팔레트 "업데이트 확인". 설치한 앱에서만 돌고, 개발 실행과 로컬 빌드(버전 0.0.1)는 disabled다.
  - OS별 동작(`update-policy.ts`)
    - Windows·AppImage: 내려받아 두었다가 탭 바 배지 "다시 시작해 <버전> 설치"로 바꾼다. 앱을 끌 때도 설치한다.
    - 서명 없는 macOS·deb: "새 버전 <버전>"을 알리고 누르면 릴리스 페이지를 연다.
  - 시험용 `PI_DESKTOP_UPDATE_URL`을 주면 그 주소(generic)에서 확인한다.
- 릴리스 워크플로(`.github/workflows/release.yml`)
  - 태그 `v*`를 올리면 세 OS 러너에서 앱 버전을 태그에 맞춰 만든다.
  - 마지막 작업이 결과물(설치 파일, blockmap, `latest*.yml`)을 모아 `gh release create`로 한 번에 올린다. 세 OS가 같은 릴리스에 동시에 올리다 부딪히지 않게 하기 위해서다.
  - 손으로 돌리면(workflow_dispatch) 만들기만 한다.
- 확인(Windows 로컬)
  - `npm run dist`로 설치 파일을 만들었다. 압축을 푼 앱(`win-unpacked`)이 `resources/host-agent`의 번들로 데몬을 띄워 연결했다.
  - 실제 GitHub 확인은 아직 릴리스가 없어 "No published versions"였다.
  - 버전만 0.0.2로 만든 설치 파일을 로컬 HTTP 서버에 두고 `PI_DESKTOP_UPDATE_URL`로 가리켰다. 0.0.1 앱이 찾아 내려받아(blockmap 차등 시도 뒤 전체) "다시 시작해 0.0.2 설치" 배지를 띄웠다. 설치는 하지 않았다.
  - macOS·Linux 빌드는 첫 태그(또는 손으로 돌린 워크플로)에서 확인한다.

**구현 메모: v0.1.0 사용 피드백 반영 (v0.54)**
- 앱 아이콘: `apps/desktop/build/icon.svg`(보라 그라데이션, 붓질한 π, 청록 커서)
  - `scripts/render-icon.mjs`가 설치된 Electron으로 1024px PNG를 만든다. electron-builder가 `build/icon.png`로 각 OS 아이콘을 만든다.
  - 개발 실행 창 아이콘과 상단 바 로고에도 쓴다.
- 메뉴바(`main/app-menu.ts`): Electron 기본 메뉴 대신 파일·편집·보기·세션·Pi·개발자 도구·도움말
  - 앱 기능 항목은 명령 id를 화면에 보낸다(`pi:menu-command`). 탭·업데이트·활동은 App이, 나머지는 지금 탭의 Workspace가 같은 id의 명령 팔레트 명령으로 실행한다.
  - 단축키는 화면이 처리하므로 메뉴에는 표시만 한다(`registerAccelerator: false`). 편집·확대·전체 화면은 Electron role이다.
  - 테스트가 메뉴의 모든 id를 어디선가 처리하는지 확인한다.
- 새 폴더: 데몬 `fs.makeDir {parent?, name}`이 폴더를 만들고 절대 경로를 돌려준다. 이름에 경로 구분자·금지 문자가 있거나 이미 있으면 거절한다.
  - 상단의 "새 폴더" 대화상자(위치·이름, "만들고 새 세션")와 폴더 탐색기의 "새 폴더"가 쓴다.
- 입력창 `/`: Pi RPC `get_commands`는 확장 명령·프롬프트 템플릿·스킬만 준다. TUI 기본 명령(/model, /compact, /tree …)은 TUI 안에만 있다.
  - 앱이 같은 이름의 앱 명령을 더해 보여 주고, 보내면 가로채 앱 기능으로 처리한다(`app-commands.ts`). 같은 이름의 Pi 명령이 있으면 Pi 명령이 이긴다.
- TUI 넘기기 오류: Pi는 첫 메시지 전에는 세션 파일을 만들지 않는다. 그래서 빈 세션을 넘기면 없는 파일을 따라가다 ENOENT가 났다.
  - 파일이 없으면 따라가지 않고 `pi --session-id <id>`(없으면 만든다) 명령을 복사한다.
- 확인(dev:mock, CDP): 상단 바 로고, 메뉴 명령 이벤트로 명령 팔레트·새 폴더 대화상자 열기, `/` 목록에 Pi 명령과 앱 명령이 함께 나오는 것을 보았다.

**구현 메모: v0.1.1 사용 피드백 반영 (v0.55)**
- 화면이 모두 사라지던 오류: v0.1.1에서 메뉴바 명령 구독(useRef·useEffect)이 App의 탭 바 `map` 안에 들어가 있었다.
  - 탭 수가 바뀌면(활동 패널에서 세션 열기, 새 탭) 훅 개수가 달라져 React가 화면을 내렸다. 구독을 컴포넌트 본문으로 옮겼다.
- 실행 중 세션 전환(`switchTo`): 저장된 세션 파일로 띄운 Pi의 저널에는 이전 대화가 없다.
  - 저널 재생만 하면 기록에서 연 세션을 다시 눌렀을 때 대화가 비었다. 이제 전환할 때마다 get_messages로 다시 그린다(`snapshot` 옵션 제거).
- 사이드바 제목: 실행 중 세션 제목을 "이 폴더"로 걸러진 기록에서 찾아서, 세션을 바꿀 때마다 제목이 바뀌었다.
  - 한 번 읽은 기록의 제목을 기억한다(없으면 데몬의 `title`, 그다음 폴더 이름).
  - 기록 목록은 호스트가 바뀔 때만 비워 깜박이지 않게 했다.
- 세션 닫기: 실행 중 세션 줄의 ✕가 `session.close`를 부른다. 대화는 세션 파일에 남아 기록에서 다시 연다.
- TUI → GUI: 팔로우 배너의 "GUI에서 이어 쓰기"가 따라가던 파일을 `sessionFile`로 다시 연다(`resumeFollowed`).
- 폴더 표시: 상단 바는 "지금 세션 <폴더 이름>"(전체 경로는 툴팁), 입력줄은 "새 세션 폴더" 이름표로 구분한다.
- 확인(dev:mock, CDP)
  - 두 폴더의 세션을 번갈아 눌러도 대화와 제목이 그대로였다. 기록에서 다시 연 세션도 같았다.
  - 활동 패널에서 다른 세션을 고르면 새 탭에 그 대화가 나왔다. "+" 새 탭에서도 콘솔 오류가 없었다.
  - TUI로 넘긴 뒤 "GUI에서 이어 쓰기"로 돌아와 질문을 이어 보냈다. ✕로 닫자 실행 중에서 빠지고 기록에 남았다.

**구현 메모: v0.1.2 사용 피드백 반영 (v0.56)**
- Pi 업데이트 배지가 안 나오던 문제
  - 원인: WSL에서 `npm view`가 한 번 실패했다(WSL 시작 직후 네트워크 등). 데몬은 그 실패를 1시간 캐시했고, 앱은 연결할 때 한 번만 물었다.
  - 같은 환경에서 다시 확인하면 성공했다.
  - 데몬(`pi-status.ts`): npm 명령이 실패하면 npm 레지스트리에 HTTPS로 직접 묻는다(`firstSuccess`, 설치용 축약 메타데이터). 실패는 1분만 캐시한다. 오류 메시지는 npm의 마지막 오류 줄을 쓴다.
  - 화면(`usePiStatus`): 실패했으면 2분 뒤, 성공했으면 6시간마다 다시 묻는다.
- Pi 관리 창 머리줄: 760px로 넓히고, 항목은 줄바꿈하지 않으며(`white-space: nowrap`), 좁으면 항목 단위로 넘긴다(`flex-wrap`).
- Pi가 없는 호스트: 사이드바 기록의 "설치된 Pi를 찾지 못했습니다" 오류 대신, 안내와 "Pi 설치하기"(Pi 관리 상태 탭)를 보인다.
- 확인
  - Pi가 없는 상태로 띄운 개발 앱(`PI_DESKTOP_PI_CLI` 없이, 빈 `PI_CODING_AGENT_DIR`)에서 안내가 나왔다. 버튼을 누르자 설치 화면이 열렸고, 머리줄은 한 줄이었다.
  - WSL에서 "다시 확인" 뒤 "1.4.0 사용 가능", 상단 바에 "↑ 새 버전"이 나왔다.

**구현 메모: v0.1.3 Linux 첫 사용 피드백 반영 (v0.57)**
- Pi 설치 스크립트가 `execvp(3) failed`로 바로 끝나던 문제
  - 원인: 로컬 셸이 OS와 상관없이 `powershell.exe`였다.
  - `terminal-command.ts`: Windows는 PowerShell, macOS·Linux는 사용자의 로그인 셸(`$SHELL -l`, 없으면 `/bin/sh`)로 띄운다.
- 제목줄·작업 표시줄에 앱 아이콘이 안 나오던 문제(KDE Wayland, AppImage)
  - 원인: 설치본은 창 아이콘을 주지 않았다. Linux 실행 파일에는 아이콘이 없고, AppImage는 .desktop 파일도 없다.
  - Linux 설치본도 `resources/icon.png`(extraResources)를 창 아이콘으로 준다. X11은 `_NET_WM_ICON`, Wayland는 xdg-toplevel-icon으로 전달된다.
  - deb는 `desktopName: pi-desktop.desktop`과 `linux.syncDesktopName`으로 .desktop 파일 이름·`StartupWMClass`를 창의 app_id와 맞춘다.
- 설치한 뒤에도 "Pi 없음"이 남던 문제
  - 원인: 설치 명령은 셸 안에서 돌아 끝나도 터미널이 닫히지 않는다. 그래서 종료 코드로 끝을 알 수 없었고, 화면은 연결할 때 한 번만 Pi 상태를 읽었다.
  - `Workspace.tsx`: Pi 관리에서 설치·업데이트·제거 명령을 보내면 3초마다 Pi 상태를 다시 읽는다. Pi 위치·버전이 바뀌면 상단 바를 갱신하고 멈춘다. 터미널을 닫으면 한 번 더 읽고 멈추며, 30분이 지나도 멈춘다.
  - 사이드바: 기록은 Pi가 있다고 확인된 뒤에만 읽는다. 상태를 아직 모를 때(시작 직후, 제거 직후) 읽으면 데몬이 "설치된 Pi를 찾지 못했습니다"를 낸다. Pi를 지우면 남은 기록 목록을 치운다.
- 로컬 빌드가 릴리스로 자동 업데이트되던 문제
  - 원인: `npm run dist`로 만든 0.0.1 AppImage가 0.1.3을 내려받아, 끌 때 시험하던 빌드를 바꿔 버렸다.
  - `update-policy.ts`(`isLocalBuild`): 저장소 버전(0.0.1) 그대로인 빌드는 업데이트를 확인하지 않는다. 릴리스 워크플로는 태그 버전으로 바꿔 만들므로 영향이 없다. `PI_DESKTOP_UPDATE_URL`로 시험할 때는 예외다.
- 확인(CachyOS, KDE Wayland, AppImage)
  - 제목줄과 작업 표시줄에 앱 아이콘이 나왔다.
  - 설치 스크립트를 내려받아 보고 실행해 Pi를 설치했다. 제거한 뒤 다시 설치하자 상단 바가 "Pi 없음"에서 버전으로 저절로 바뀌고 기록이 나왔다.
  - 실행 로그에 `pi:list-history` 오류와 업데이트 다운로드가 없었다.

### 4.12 내장 터미널 (신규, 공통 인프라)
xterm.js와 `pty.*`를 쓴다. 쓰임새는 대화형 설치기, OAuth 로그인, TUI 전용 확장 폴백, 사용자가 원할 때 진짜 `pi` TUI 열기다.

**구현 메모 (M2, v0.23)**: 사용자 결정에 따라 터미널은 **Electron main에서 node-pty로** 띄운다. 데몬의 `pty.*`는 두지 않는다.
- node-pty 1.1.0은 N-API라 Electron용으로 다시 빌드할 필요가 없고, Windows 사전 빌드를 포함한다.
- 로컬은 찾은 Pi의 node와 cli.js로 직접(pi.cmd shim 없이) 띄운다. 셸은 Windows면 PowerShell, macOS·Linux면 로그인 셸(`$SHELL -l`)이다(v0.57).
- WSL은 `wsl.exe -d <배포판> --cd <폴더>`로 실행한다. Windows ConPTY가 WSL까지 감싸므로 크기 조정이 리눅스까지 전달된다(데몬 쪽 `script` 방식은 크기 조정이 안 된다).
- 원격(SSH)은 M3에서 같은 방식(`ssh -t`)으로 붙인다.
- 화면은 작업 영역 아래 도크(여러 탭, 접기)다. 열기는 명령 팔레트의 "터미널: pi 열기·셸 열기"다.
- OAuth 로그인은 프로바이더 탭의 버튼으로 한다. pi를 띄우고 화면이 잠잠해진 뒤 `/login <프로바이더>`를 대신 입력한다.

**구현 메모: 복사·붙여넣기 (v0.58)**
- 그전에는 xterm.js가 `Ctrl+C`·`Ctrl+V`를 제어 문자로 터미널에 보내 버려, 메뉴바의 편집 → 복사·붙여넣기로만 할 수 있었다.
- 단축키(`terminal-keys.ts`, `attachCustomKeyEventHandler`): Windows Terminal·VS Code와 같다.
  - Windows·Linux: `Ctrl+Shift+C/V`, 선택이 있을 때의 `Ctrl+C`, 그리고 `Ctrl+V`. macOS: `Cmd+C/V`.
  - 한글 입력 중에도 맞도록 물리 키(`e.code`)를 본다.
  - 복사는 선택한 글을 `navigator.clipboard`에 쓴다. 붙여넣기는 막지 않고 브라우저의 paste 이벤트를 xterm이 받게 둔다(괄호 붙여넣기 모드를 지킨다).
- 오른쪽 클릭 메뉴: 복사(선택이 있을 때)·붙여넣기(`navigator.clipboard.readText` → `term.paste`)·모두 선택.
- 확인(Linux, 빌드한 앱을 CDP로 조작): `Ctrl+Shift+C`와 선택이 있을 때의 `Ctrl+C`로 복사됐다. `Ctrl+V`·`Ctrl+Shift+V`·메뉴 붙여넣기는 한 번씩만 입력됐다. 선택이 없을 때 `Ctrl+C`는 `sleep 30`을 멈췄다.
- 글꼴: 기본 고정폭 글꼴 뒤에 흔한 Nerd Font 이름들을 둔다(`TERMINAL_FONTS`). 기본 글꼴에 없는 아이콘(사설 영역, `eza --icons`·starship 등)이 설치된 Nerd Font로 그려진다. 일반 글자는 예전 글꼴 그대로다.
  - 확인(Linux, MesloLGS Nerd Font 설치): `\uf313`·`\ue7a8`·`\uf07b`·`\uf15b`와 프롬프트의 화살표가 네모 대신 아이콘으로 보였다.

**구현 메모: 설정 폼의 모델 선택과 세션 새로고침 (v0.59)**
- 모델 목록(`pi.models`, `pi-models.ts`): 데몬이 `pi --list-models` 표를 읽어 프로바이더·모델 ID를 돌려준다.
  - 인증이 있는 프로바이더의 모델과 models.json의 사용자 정의 프로바이더가 들어간다.
  - SDK의 ModelRegistry는 내부 런타임(ModelRuntime)을 만들어야 해서 CLI 출력을 쓴다.
- 설정 폼: `defaultProvider`·`defaultModel`을 선택 목록으로 보인다(`modelChoices`). 모델은 고른 프로바이더의 것만 나온다.
  - 목록에 없는 값은 "(목록에 없음)"으로 남는다. "직접 입력…"으로 글자 칸을 쓸 수 있다.
  - 목록을 못 읽으면(예전 데몬, 인증 없음) 이유를 보이고 글자 칸을 쓴다.
- 세션 새로고침: Pi는 세션을 시작할 때 모델 스냅샷을 만들고, RPC `get_available_models`는 그것만 준다(`modelRuntime.getAvailableSnapshot()`).
  - RPC에 다시 읽는 명령이 없고, Pi의 reload(`/desktop:reload`)도 설정·리소스·확장만 다시 읽는다.
  - 그래서 세션을 연 뒤 로그인하면 `/model`에 예전 모델만 보였다.
  - 확인(`session-refresh.ts`): auth.json에 자격 증명이 있는데 세션 모델에 없는 프로바이더가 있으면 배너를 띄운다. 세션 시작, 창 포커스, Pi 관리를 닫을 때, 30초마다 본다.
  - "세션 새로고침"(`restartSession`): Pi를 끄고 같은 세션 파일로 다시 띄운 뒤 대화를 다시 그린다. 파일이 아직 없으면 같은 폴더에 새 세션을 연다.
- 확인(dev:mock, CDP)
  - WSL 설정 폼에 anthropic·openrouter와 그 모델이 나왔고, 프로바이더를 바꾸면 모델 목록이 바뀌었다. 로컬은 mock 목록이 나왔다.
  - 로컬 mock 세션에서 시험 키로 openai를 등록하자 배너가 떴다. 새로고침 뒤 세션 모델에 openai가 들어가고 대화가 이어졌다. 시험 키는 지웠다.

**구현 메모: 리소스 삭제·Marketplace README·Pi 제거 뒤 세션 정리 (v0.61)**
- 리소스 삭제(`resources.delete`, `import-manage.ts`의 `resourceDeleteTarget`)
  - 지울 대상: 프롬프트는 `prompts/` 바로 아래 .md, 스킬은 `skills/<이름>/SKILL.md`의 폴더(또는 `skills/` 바로 아래 .md), 확장은 `extensions/` 바로 아래 파일·폴더(또는 `extensions/<이름>/index.ts`의 폴더).
  - 데이터 폴더나 프로젝트 `.pi` 안의 것만 받는다. 바로 지우지 않고 `~/.pi-desktop/resource-backups/deleted`로 옮긴다.
  - 화면은 사용자·프로젝트 범위의 직접 둔 것만 "삭제"를 보이고(`isDeletable`), 한 번 더 눌러야 지운다.
- Marketplace README(`readme-view.ts`): 마크다운 화면은 원문 HTML을 그리지 않아 태그가 글자로 보였다.
  - 보여 주기 전에 `<a>`는 링크, `<br>`은 줄바꿈, `<h1~6>`은 제목으로 바꾼다.
  - 이미지는 대체 글만 남기고, 나머지 태그·주석은 지운다. 코드 블록과 인라인 코드는 그대로 둔다.
- Pi 제거 뒤 세션 정리: Pi 상태가 "Pi 없음"인데 실행 중인 세션이 있으면 모두 닫는다(`closeAllSessions`). 지워진 설치본의 Pi 프로세스가 계속 돌지 않게 하기 위해서다.
- 확인(dev:mock, CDP)
  - 프로젝트 프롬프트를 만들어 "삭제 → 정말 삭제"하자 목록에서 빠지고 백업 폴더로 옮겨졌다.
  - pi-web-access README의 `<p><img></p>` 배너가 대체 글로 바뀌었다.
  - Pi 제거 뒤 세션 정리는 실제 제거로 확인하지 않았다.

**구현 메모: 확장·패키지 만들기 (v0.62)**
- 확장 템플릿(`extension-templates.ts`): 명령·툴·확인·빈 확장. Pi 문서·예제(hello.ts, permission-gate.ts)의 형태를 따른다.
  - Pi가 넣어 주는 패키지(`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`)만 import해, 설치·빌드 없이 jiti로 바로 읽힌다.
  - `resources.create`에 `extension` 종류와 `template`을 더했다. 위치는 `<데이터 폴더 또는 .pi>/extensions/<이름>.ts`다.
- 패키지 만들기(`resources.createPackage`, `package-scaffold.ts`): `~/pi-packages/<이름>`에 다음을 만든다.
  - package.json: keywords `pi-package`, `files`, Pi 제공 패키지는 `peerDependencies: "*"`(docs/packages.md 권고)
  - README(설치·게시 방법), .gitignore, 템플릿 확장
  - 고른 리소스의 복사본(`resourceDeleteTarget`으로 파일·폴더를 정함). 복사할 것을 먼저 모두 확인해, 반쯤 만든 패키지가 남지 않게 한다.
- 편집 허용 범위(`resourcePathProblem`): extensions/ 안의 확장 코드와 `~/pi-packages` 안의 .md·코드·.json을 더했다. auth.json 같은 설정은 여전히 막힌다.
- 화면
  - 확장 탭 "새 확장"(템플릿 선택). 직접 둔 확장 코드에 "편집"이 보인다.
  - 패키지 탭 "새 패키지 만들기"(이름·설명·템플릿·넣을 리소스). 만든 뒤 편집·위치 열기·"이 호스트에 설치"(`pi install <폴더>`)를 할 수 있다.
  - 만든 결과는 리소스 창 상태에 두어, 편집기를 열었다 돌아와도 남는다.
- 확인(dev:mock, CDP)
  - 명령 템플릿 확장을 만들고 /reload 뒤 `/이름`을 실행하자 알림이 떴다.
  - 툴 템플릿은 dev:mock이 `--tools`로 툴을 정해 두어 세션에서는 켜지지 않는다. 같은 mock 모델로 `pi -p`에서 호출해 결과를 확인했다.
  - 패키지를 만들어 확장을 편집하고 "이 호스트에 설치"로 설치했다. /reload 뒤 패키지의 명령이 실행됐다. 시험 패키지와 설정은 지웠다.

**구현 메모: 예전 Agent의 거절 안내 (v0.63)**
- 앱을 업데이트해도 실행 중인 세션이 있으면 예전 데몬을 그대로 쓴다("업데이트 대기", §3.4).
  - 이때 새 기능 요청이 예전 데몬에 가면 "kind는 prompt·skill·agents…"(잘못된 인자)나 "알 수 없는 메서드"로 거절돼, 사용자는 이유를 알 수 없었다.
- `HostConnection.request`: 업데이트 대기 중(`agentUpdate`)인 연결에서 MethodNotFound·InvalidParams로 거절되면 `staleAgentError`(agent-build.ts)가 안내로 바꾼다.
  - 안내 내용: Agent가 이전 버전일 수 있고, "Agent 업데이트 대기 → 지금 바꾸기"로 바꾼다. 원래 오류도 함께 보인다.
- 확인(dev:mock, Windows)
  - v0.1.7 소스로 빌드한 데몬에 세션을 열어 둔 채 현재 앱으로 다시 붙었다. 확장 만들기에서 안내가 나왔다.
  - "지금 바꾸기" 뒤에는 만들어졌다.

**구현 메모: 내가 만든 패키지 (v0.64)**
- 문제: 패키지를 만들고 바로 설치하지 않으면, 창을 닫은 뒤 패키지 탭에서 다시 찾을 수 없었다(설정에 적힌 패키지만 보였다).
- `resources.listPackages`(`listMyPackages`): `~/pi-packages`에서 package.json이 있는 폴더를 이름·버전·설명·파일 목록(node_modules·.git 제외, 200개까지)과 함께 돌려준다. package.json이 깨졌어도 목록에 보여 고칠 수 있게 한다.
- `resources.deletePackage`: 폴더를 `~/.pi-desktop/resource-backups/packages`로 옮긴다. 이름에 경로 구분자·..가 있으면 거절한다.
- 화면: 패키지 탭 "내가 만든 패키지"
  - 설치 여부는 설정의 패키지 중 `installedPath`가 그 폴더인 것으로 본다(`installedPackageFor`, 구분자·대소문자 무시).
  - 동작: 파일 골라 편집, 설치(`pi install <폴더>`)·설치 해제(`pi remove <source>`), 위치 열기, 삭제(설치된 동안은 막음)
- 확인(dev:mock, CDP)
  - 패키지를 만들고 리소스 창을 다시 열자 목록에 "설치 안 됨"으로 나왔다.
  - 설치하자 "설치됨 (사용자)"로 바뀌었고, 그동안 삭제는 막혔다.
  - 파일 편집이 열렸다. 설치 해제 뒤 삭제하자 백업 폴더로 옮겨졌다.

**구현 메모: 로컬 패키지 제거 (v0.65)**
- 문제: 로컬 경로로 설치한 패키지의 "설치 해제"·"제거"가 되지 않았다.
  - Pi는 로컬 경로 소스를 설정 파일 기준 상대 경로(예: `..\\..\\pi-packages\\x`)로 저장한다.
  - `pi remove`는 일치를 볼 때, 설정 쪽은 설정 폴더 기준으로 풀고 입력 쪽은 지금 폴더(cwd) 기준으로 푼다(package-manager.js `getSourceMatchKeyForInput`).
  - 그래서 저장된 상대 경로를 그대로 넘기면 "No matching package found"가 된다.
- 수정: 제거·업데이트 인자에는 `commandSource`(market-view.ts)를 쓴다. 로컬 경로 소스면 설치된 절대 경로(`installedPath`)를, npm·git·URL이면 소스를 그대로 넘긴다.
- 확인
  - CLI: 저장된 상대 경로로는 "No matching"이었고, 절대 경로로는 지워졌다.
  - 앱: 다른 작업 폴더의 세션에서 "내가 만든 패키지"의 설치 해제와 설정 목록의 "정말 제거"가 모두 설정에서 패키지를 뺐다.
- 내가 만든 패키지 줄: 파일 고르기·편집·설치·위치 열기·삭제를 한 줄(`my-package-actions`, 가운데 맞춤)에 둔다.

**구현 메모: Windows bash 출력 한글 깨짐 (v0.66)**
- 원인: Pi는 bash 출력을 UTF-8(`TextDecoder`)로 읽는다. 그런데 한국어 Windows의 기본 명령(findstr·tasklist 등)은 콘솔 코드 페이지(CP949)로 출력해 글자가 깨졌다.
- Pi 설정 `shellCommandPrefix`에 `chcp.com 65001`을 넣으면 고쳐진다. 사용자 설정 파일은 고치지 않고 bridge 확장이 같은 일을 한다(`bridge.ts`).
  - 모델의 bash 툴: `tool_call`에서 실행할 명령 앞에 `chcp.com 65001 > /dev/null 2>&1`을 붙인다.
  - 입력창의 `!명령`(RPC `bash`): `user_bash`에서 접두사를 붙이는 실행기(`createLocalBashOperations`를 감쌈)를 넘긴다.
  - 대화에 남는 명령은 원래 것이다.
  - 조건: Windows이고 `pi.getSettings().shellCommandPrefix`가 비어 있을 때만 붙인다.
- 명령마다 새 콘솔(`windowsHide`)에서 돌기 때문에, Pi 프로세스에서 chcp를 한 번 실행해서는 바뀌지 않았다(실험으로 확인).
- 확인
  - dev:mock에서 bash 툴과 `!명령`으로 `findstr`·`tasklist`를 실행했다. 출력이 깨지지 않았고(안내 문구는 영어), 툴 카드에는 원래 명령이 보였다.
  - 실제 Pi 테스트(`real-pi-bridge.test.ts`, Windows만): `!명령` 출력에 깨진 글자(U+FFFD)가 없다.

**구현 메모: 빈 탭 되살리지 않기 (v0.67)**
- 문제: Windows에서 실행할 때마다 탭이 두 개 나왔다. 저장된 탭 목록(`pi-desktop.tabs`)에 예전에 열어 둔 빈 탭이 남아 있었고, 앱은 그 탭까지 되살렸다.
  - Linux에서는 탭을 하나만 썼기 때문에 한 개로 보였다.
- `loadTabs`: 첫 탭과, 보던 세션이 기억된 탭(`pi-desktop.tab.<id>.lastSession.<호스트>`가 null이 아님)만 되살린다(`restorableTabIds`). 되살리지 않는 탭의 저장값은 지운다.
- 확인(dev:mock): 빈 새 탭을 만든 뒤 새로 고침하자 사라졌다. 세션을 연 둘째 탭은 남았다.

**구현 메모: 업데이트를 묻고 진행 (v0.68)**
- 그전에는 auto 모드(Windows·AppImage)에서 `autoDownload`로 묻지 않고 내려받고, `autoInstallOnAppQuit`로 끌 때 설치했다. 직접 확인했는데 업데이트가 없으면 아무 말이 없었다.
- 이제 `autoDownload`와 `autoInstallOnAppQuit`를 끈 채로 시작한다.
  - 새 버전을 찾으면 `available` 상태로 배지만 보인다.
  - 배지·"업데이트 확인"(`checkForUpdates(true)`)·`confirmUpdate`가 main의 `dialog.showMessageBox`로 묻는다.
  - 업데이트를 고르면 `downloadUpdate` 하고 `autoInstallOnAppQuit`를 켠다. `update-downloaded` 뒤에 지금 다시 시작해 설치할지 묻는다.
  - 창 문구는 `update-policy.ts`의 `availablePrompt`·`restartPrompt`·`resultPrompt`로 테스트한다.
- 직접 확인(interactive): 결과가 none이면 "최신 버전입니다", error면 이유와 VPN·프록시 안내, 개발·로컬 빌드면 확인하지 않는 실행이라고 알린다. 주기적 확인은 배지만 바꾼다.
- 확인(Windows, 빌드한 설치본을 따로 둔 데이터 폴더로 실행, `PI_DESKTOP_UPDATE_URL`의 로컬 피드, 창은 UI Automation으로 읽고 누름)
  - 피드가 같은 버전이면 15초 뒤 확인은 조용했고, 직접 확인은 "최신 버전입니다"를 띄웠다.
  - 피드를 0.0.2로 바꾸자 업데이트할지 물었다. 나중에를 고르자 latest.yml만 받고 설치 파일은 받지 않았으며, 배지가 "새 버전 0.0.2 업데이트…"였다.
  - 배지를 눌러 업데이트를 고르자 내려받은 뒤 다시 시작할지 물었다. 나중에를 고르자 배지가 "다시 시작해 0.0.2 설치"가 됐다.
  - 시험 앱은 강제로 끝내 설치하지 않았다. 시험 내려받기(updater 캐시의 pending)는 지웠다.

**구현 메모: 연결이 안 될 때 (v0.69)**
- 문제: 그전에는 SSH 서버가 꺼졌거나 IP가 바뀌면 다음처럼 됐다.
  - 0.5~10초 간격으로 ssh를 끝없이 다시 띄웠다.
  - 화면의 요청(세션 목록, 기록, 활동 패널의 3초 주기 요청 등)이 `readyWaiters`에서 끝없이 기다리며 쌓였다.
  - SSH가 붙은 뒤 원격 명령이 멈추면 "연결 중"에 머물렀다.
- 다시 붙기(`reconnect-policy.ts`)
  - 간격을 0.5초부터 두 배씩 늘린다(최대 30초). 연달아 6번 실패하면 멈추고 `disconnected { gaveUp: true }`로 알린다.
  - "다시 연결"(`reconnectHost`)을 누르거나, 멈춘 호스트를 다시 고르면(`connectHost`) 실패 횟수를 비우고 다시 붙는다.
- 요청: 연결되지 않은 동안은 20초까지만 기다린다(`REQUEST_WAIT_MS`). 멈춘 뒤에는 기다리지 않고 이유와 함께 실패하고, 멈추는 순간 기다리던 요청도 끝낸다.
- 시간 제한: 연결 준비 전체(`prepare`)는 90초, SSH 원격 명령 하나(`runCommand`)는 60초다. 넘기면 실패로 보고 다음 시도로 넘어간다.
- 화면
  - 배지: "연결 끊김 · N초 뒤 다시 시도 (n/6)". 누르면 지금 다시 연결한다.
  - 멈추면 배지가 "연결 실패 · 다시 연결"이 되고, 위쪽 배너에 이유와 "다시 연결"·"SSH 호스트 관리…"가 나온다.
- 확인(dev:mock, 닿지 않는 주소 `pi@10.255.255.1`)
  - 기다리는 요청은 20초 뒤 실패했다.
  - 약 1분 동안 "n초 뒤 다시 시도 (5/6)"를 거쳐 멈췄고, 배너가 나왔다. 멈춘 뒤의 요청은 바로 실패했다.
  - "다시 연결"과 호스트를 다시 고르면 다시 붙기 시작했다.

## 5. 상세 설계 포인트

### 5.1 PiLocator (Host Agent 내부)
1. 탐색 순서: 사용자 지정 경로 → 관리형 설치 경로 → `npm root -g`/`@earendil-works/pi-coding-agent` → PATH의 `pi` → 구 패키지 `@mariozechner/pi-coding-agent`(감지되면 이전 안내)
2. 실행은 `node <pkg>/dist/bundle/cli.js --mode rpc`로 한다. Windows `.cmd` shim 문제를 피하기 위해서다.
3. SDK는 `import(pathToFileURL(<pkg>/dist/index.js))`로 동적 로드한다.

### 5.2 SessionHost
- 세션 하나에 RpcClient 하나. 모든 명령에 `id`를 붙여 응답을 매칭하고 타임아웃을 건다.
- 프로세스가 죽으면 마지막 `sessionFile`로 재시작하고 사용자에게 알린다.

### 5.3 pi-desktop-bridge 확장
RPC 프로세스를 띄울 때 `-e <bridge>`로 주입한다. 사용자 settings에는 기록하지 않는다.
- `/desktop:reload` → `ctx.reload()`: 리소스를 편집한 뒤 프로세스 재시작 없이 반영
- `/desktop:resources` → 현재 로드된 확장·스킬·프롬프트·툴 목록을 JSON으로 반환
- `/desktop:lease` → 세션 소유권 하트비트(§5.4)

**구현 메모 (M4, v0.32)**: `/desktop:reload`만 만들었다.
- 확장 파일: 데몬이 다른 모듈을 import하지 않는 TypeScript 한 파일을 앱 홈의 `bridge/pi-desktop-bridge-<해시>.ts`에 한 번 쓴다. 세션을 열 때 `-e`로 넣으며, 그 호스트의 Pi가 jiti로 불러온다. `PI_DESKTOP_NO_BRIDGE=1`이면 넣지 않는다.
- 명령 동작: 작업 중이면 알림만 하고 반영하지 않는다. 아니면 `ctx.reload()`를 부른다. reload 뒤에는 예전 런타임의 ctx를 쓰면 안 되므로 바로 끝낸다.
- RPC에서 `{type:"prompt", message:"/desktop:reload"}`를 보내면 확장 명령으로 처리된다(`disposition: "handled"`). LLM은 부르지 않고 대화에도 남지 않는다. 실제 Pi 계약 테스트로 확인한다.
- 앱의 안전장치: 보내기 전에 `get_commands`에 `desktop:reload`가 있는지 확인한다. 앱 업데이트 전에 연 세션에는 bridge가 없어서, 그대로 보내면 LLM에 질문으로 가기 때문이다.
- 확인하다 알게 된 것: **RPC 모드는 프로젝트 신뢰를 묻지 못한다**(security.md "Project trust without an interactive prompt").
  - 저장된 신뢰(`~/.pi/agent/trust.json`)도 `--approve`도 없으면 프로젝트 `.pi/`의 프롬프트·스킬·확장·설정을 건너뛴다. 기본값 `defaultProjectTrust: "ask"`일 때다. AGENTS.md는 신뢰와 상관없이 불러온다.
  - 그래서 앱에서 처음 연 프로젝트는 `.pi/` 리소스가 빠진다. 리소스 창은 신뢰 여부를 따지지 않고 보여 주므로, 실제와 다르게 보일 수 있다.
  - 처음에는 bridge가 `project_trust` 이벤트로 묻는 방안을 생각했다. 그러나 Pi는 확장의 답을 저장된 결정보다 먼저 쓰므로(project-trust.js), `/trust`로 저장한 결정까지 덮어쓰게 되어 택하지 않았다. 아래 v0.33 구현 메모를 본다.

**구현 메모: 프로젝트 신뢰 (M4, v0.33)**
- 데몬
  - `trust.get({cwd})`: 그 호스트 Pi의 SDK(`hasTrustRequiringProjectResources`, `ProjectTrustStore`, `SettingsManager.getDefaultProjectTrust`)로 Pi와 같은 순서로 정한다. 필요 없음 → 저장된 결정 → 기본값 순이다. 결과는 `trusted`·`untrusted`·`ask`다.
  - `trust.set({cwd, decision})`: Pi의 `trust.json`에 저장하거나 지운다. 터미널 pi의 `/trust`와 같은 파일이다.
  - `session.open`의 `trust: "yes"|"no"`는 그 실행에만 `--approve`·`--no-approve`로 넘긴다.
- 앱
  - 세션을 여는 모든 경로(새 세션·다시 열기·기록에서 열기·분기)가 열기 전에 확인한다. `ask`면 대화상자로 묻는다.
  - 선택지: 이번만 신뢰하지 않고 열기(첫 선택, 가장 안전) / 신뢰하고 열기(기억) / 이번만 신뢰하고 열기 / 신뢰하지 않음으로 기억하고 열기. Esc는 열지 않는다.
  - 상태를 읽지 못하면(예전 데몬) 묻지 않고 Pi 기본 동작에 맡긴다.
- 리소스 창
  - 신뢰 상태 안내와 "이 폴더 신뢰"·"저장된 결정 지우기" 버튼을 둔다.
  - 불러오지 않는 project 리소스에 배지를 단다. 저장하지 않은 폴더는 "이번만 신뢰"로 연 세션에는 불러와져 있을 수 있어서 "신뢰해야 불러옴"으로 표시한다.
  - 신뢰를 바꿔도 이미 열린 세션은 Pi가 시작할 때 정한 그대로다.
- 실제 Pi 계약 테스트로 확인한 것
  - 정해진 것이 없으면 프로젝트 프롬프트를 건너뛴다.
  - "이번만" 결정은 저장하지 않고 적용된다.
  - 저장한 결정은 다음 실행부터 묻지 않고 쓰인다.

### 5.4 TUI와 병행 사용 (신규)

Pi는 세션 파일 잠금을 문서화하지 않았다. 그래서 **같은 세션 파일에 두 프로세스가 동시에 쓰는 상황을 GUI가 막는다.**

| 상황 | 동작 |
|---|---|
| GUI만 사용 | 정상 |
| TUI가 세션 X를 쓰는 중에 GUI가 X를 엶 | 감지: 세션 JSONL의 최근 mtime과 append 감시, 그리고 같은 `sessionFile`을 인자로 가진 `pi` 프로세스 탐색(로컬은 프로세스 목록, 원격은 Agent의 `ps`). **팔로우 모드(읽기 전용)**로 열어 파일 tail로 실시간 표시한다. 버튼: "포크해서 GUI에서 계속" / "TUI 종료 후 이어받기" |
| GUI가 세션 X를 쓰는 중에 TUI가 X를 엶 | 막을 수 없다. GUI가 자기가 쓰지 않은 append를 감지하면 경고 배너를 띄우고 GUI 쪽 입력을 잠근다 |
| 설정·리소스 파일을 TUI/에디터에서 수정 | `fs.watch`로 즉시 반영한다. GUI에서 편집 중이었다면 3-way 병합 다이얼로그 |
| GUI에서 리소스 수정 → 실행 중인 TUI | TUI 쪽에는 `/reload` 안내만 표시한다(TUI를 원격 조작하지 않음) |

추가로 **"이 세션을 TUI에서 열기"** 버튼을 둔다. GUI 쪽 세션을 정지한 뒤 내장 터미널이나 외부 터미널에서 `pi --session <file>`로 연다.

**구현 (v0.7, M1)**
- 다른 프로그램이 쓰는 중인지 판단: 기록에서 연 세션 파일이 **최근 2분 안에 수정**됐고 이 데몬의 실행 중 세션이 쓰는 파일이 아니면(`stored.inspect`의 `ownedBy` 없음) 바로 열지 않고 "읽기 전용으로 따라가기 / 분기해서 새 세션으로 이어 쓰기 / 그래도 이 파일로 열기"를 묻는다. 프로세스 목록으로 찾는 방식은 TUI가 `pi --continue`처럼 경로 없이 실행되면 찾을 수 없어 쓰지 않았다.
- 팔로우 모드: Pi를 띄우지 않고 파일을 직접 읽어(`stored.read`, Pi SDK 순수 함수로 해석) 보여주고, `fs.watchFile`로 변경을 감시한다. `SessionManager.open`은 파일을 다시 쓸 수 있어 쓰지 않는다. TUI는 완료된 메시지만 파일에 쓰므로 스트리밍 중간 상태는 보이지 않는다.
- 분기해서 이어 쓰기: `pi --fork <파일>`로 새 파일에서 이어 간다. 원래 파일은 건드리지 않는다.
- TUI에서 열기: GUI 쪽 Pi를 닫고 터미널 명령을 복사한 뒤 같은 파일을 팔로우한다.
- GUI가 쓰는 세션 파일에 TUI가 끼어드는 경우의 감지(위 표 세 번째 줄, v0.8): 데몬이 우리 Pi의 마지막 활동(이벤트 수신, 명령 전송) 시각을 기록하고, **파일 수정 시각이 그보다 3초 이상 뒤이면서 새로 덧붙은 부분에 대화 메시지 항목이 있으면** 다른 프로그램이 쓴 것으로 본다. 감지 알림 시각이 아니라 mtime으로 비교하는 이유는 파일 감시가 주기적 stat이라 알림이 늦게 오기 때문이다(처음 구현에서 실제로 오탐). 감지되면 앱은 입력을 잠그고 "닫고 따라가기 / 복제해서 계속 / 무시하고 계속"을 제시한다.

### 5.5 WSL 특이사항
- 호스트 목록에 설치된 배포판을 자동으로 표시한다.
- 경로 변환: Windows 경로로 연 프로젝트(`C:\src\app`)를 WSL Pi로 돌리면 `/mnt/c/src/app`. 성능 경고를 보여주고 WSL 내부 경로 사용을 권장한다.
- WSL 쪽 `~/.pi/agent`와 Windows 쪽 `~/.pi/agent`는 **별개의 설정**이다. 호스트 배지로 항상 구분해서 보여준다. 호스트 간 공유는 §5.9의 복사 기능으로만 한다.
- (M1 구현에서 확인한 사항)
  - `/etc/wsl.conf`에서 automount를 끈 환경에서는 WSL 안에서 Windows 드라이브가 보이지 않는다. 그래서 Agent 번들을 WSL 홈 `~/.pi-desktop/agent/host-agent-<버전>-<해시>.mjs`로 업로드해 실행한다. 경로 변환(`/mnt/c`)도 이런 환경에서는 쓸 수 없으므로, WSL 프로젝트는 WSL 내부 경로로만 연다.
  - `wsl.exe -- <명령>`은 인자를 이어 붙여 기본 셸이 다시 해석한다. 여러 줄 스크립트와 `$` 변수가 깨지므로 항상 `wsl.exe --exec`로 호출한다.
  - 공식 설치기로 설치한 Pi는 `.bashrc`에서만 PATH에 들어가므로, 데몬은 관리형 설치 구조(`~/.pi/agent/install/current-version`)를 직접 읽어 찾는다.
  - systemd가 켜진 WSL(Ubuntu)에서는 연결기가 끊긴 뒤에도 데몬과 Pi가 계속 실행되는 것을 확인했다. 장시간(수십 분 이상) 유휴 상태에서의 생존 여부는 아직 확인하지 않았다.
- **폴더 탐색 (M3 첫 단계, v0.26)**: Windows 폴더 선택 대화상자는 WSL 안을 보여주지 못하므로, 로컬이 아닌 호스트에서는 "폴더 선택"이 앱의 폴더 탐색 창을 연다. SSH 호스트도 같은 창을 쓴다.
  - 데몬의 `fs.listDir`가 그 호스트에서 한 폴더의 하위 폴더만 돌려준다. 경로가 비었거나 `~`면 홈, 상대 경로는 홈 기준이다. 폴더를 가리키는 링크도 폴더로 치고, 한 번에 2000개까지 담는다.
  - 창은 경로 입력·홈·경로 마디(누르면 이동)·하위 폴더 목록으로 되어 있다. 글자를 치면 하위 폴더를 거르고, ↑·↓와 Enter로 들어가며, 거르기 칸이 빈 채 Backspace는 상위 폴더, Ctrl+Enter는 지금 폴더 선택이다. 숨김 폴더는 기본으로 감춘다.
  - 입력창에 이미 경로가 있으면 그 폴더에서 열고, 없는 경로면 홈에서 연다.
  - 확인하며 알게 된 것: 연결기는 소켓에 떠 있는 데몬에 버전 확인 없이 붙어서, 예전 데몬이 살아 있으면 새 메서드를 몰랐다("알 수 없는 메서드"). v0.27에서 빌드 식별자를 비교해 교체하도록 고쳤다(§3.4 구현 메모).

### 5.6 원격(SSH) 특이사항
- 인증은 OS `ssh`와 ssh-agent에 맡긴다. GUI는 비밀번호나 키를 저장하지 않는다.
- 파일 피커, diff, 편집은 모두 Agent의 `fs.*`로 처리한다. 큰 파일은 스트리밍하고 크기 제한을 둔다.
- 이미지 붙여넣기는 원격 임시 폴더로 업로드한 뒤 경로를 전달한다.
- 네트워크가 끊기거나 GUI를 닫아도 Pi 프로세스는 원격 데몬 아래에서 계속 실행된다. 다시 연결하면 저널로 이어 붙인다(§3.4).
- SSH 연결이 끊긴 것을 빨리 알아채도록 `ServerAliveInterval`을 설정하고, 지수 백오프로 자동 재연결한다.
- **구현 메모: SSH 호스트 (M3, v0.28)**
  - 호스트 등록: 호스트 선택 목록의 "SSH 호스트 관리…"에서 이름·접속 대상(`user@host` 또는 `~/.ssh/config`의 Host 이름)·포트만 받는다. 앱 userData의 `ssh-hosts.json`에 저장하고, 인증 정보는 담지 않는다. 호스트 id는 `ssh:<이름>`이다.
  - 실행: OS의 `ssh`를 쓴다. Windows는 Git 등 다른 ssh보다 `System32OpenSSHssh.exe`를 먼저 쓴다. 공통 옵션은 다음과 같다.
    - `BatchMode=yes`: 비밀번호를 묻지 않고, 키 인증이 안 되면 실패한다.
    - `StrictHostKeyChecking=accept-new`: 처음 보는 호스트 키는 받고, 바뀐 키는 거부한다.
    - `ServerAliveInterval=15`, `ConnectTimeout=10`
  - 원격 명령은 로그인 셸 종류와 상관없도록 `sh -c …`로 감싼다.
  - Agent 배포는 WSL과 같은 절차를 공통 모듈(remote-agent.ts)로 쓴다: node 확인 → 홈의 `~/.pi-desktop/agent/`에 해시 이름으로 업로드 → `exec node <agent> connect`.
  - 오류 안내: 키 인증 실패에는 키 등록 방법을, 호스트 키 변경과 접속 실패에는 확인할 것을 덧붙인다. Node가 없으면 Termux용 명령(`pkg install nodejs-lts`)도 안내한다.
  - 내장 터미널은 `ssh -t`로 붙인다. 셸은 서버의 로그인 셸이고, pi는 데몬이 찾은 node·cli.js로 실행한다. 그래서 Pi 관리 창의 설치·OAuth 로그인도 SSH 호스트에서 된다.
  - Android(Termux, Node가 `android`로 알림)에서는 공식 설치기가 돌지 않으므로 Pi 설치 안내를 npm 전역 설치로 바꾼다.
  - 확인한 환경: Termux sshd(포트 8022)가 켜진 Android 15 휴대폰(aarch64, Node 24.18 LTS)
    - Agent 자동 배포, 폴더 탐색, 터미널로 Pi 설치(npm 전역)
    - 세션 열기와 `!` 셸 명령
    - 앱을 닫았다 다시 열면 휴대폰의 데몬·Pi가 살아 있고, 세션과 출력이 그대로 이어짐
  - 아직 하지 않은 것
    - `~/.ssh/config` 호스트 자동 가져오기
    - 비밀번호·암호 걸린 키 입력 (ssh-agent에 올린 키는 됨)
    - 휴대폰에서 LLM으로 실제 대화(자격 증명 없음)
    - Android가 백그라운드의 Termux를 멈추는 경우의 대응(Termux wake lock) — 웹 서버 pi-web(§5.10)은 켤 때 wake lock을 건다

### 5.7 ConfigService — 안전한 파일 편집
- 모든 쓰기는 Host Agent의 원자적 쓰기를 쓴다. JSON은 jsonc-parser로 부분 수정해서 원본 포맷과 주석을 보존한다. 저장 전 스키마 검증, `.bak` 1개 유지.
- 저장 후 열린 세션에 "리로드" 배너 → `/desktop:reload`
- `auth.json`은 쓰기만 하고, 렌더러로는 프로바이더 이름과 상태만 보낸다.

### 5.8 보안
- 렌더러: `contextIsolation`, `sandbox`, nodeIntegration 끔. IPC 채널은 화이트리스트와 zod로 검증한다.
- 외부 스크립트(설치기 등)는 항상 내용을 보여주고 동의를 받은 뒤 실행한다.
- 원격 명령 실행은 Agent 프로토콜로만 한다. 임의 셸 문자열은 사용자가 직접 입력한 경우에만 허용한다.

### 5.9 호스트 간 리소스 복사 (v0.4 확정)

**원칙**: 호스트(로컬 Windows, 각 WSL 배포판, 각 SSH 서버)마다 `~/.pi/agent`를 **독립적으로 관리**한다. 공유가 필요하면 사용자가 명시적으로 **복사**한다. 복사한 뒤에는 두 사본이 서로 영향을 주지 않는다. 자동 동기화는 하지 않는다.

**복사 대상과 방법**

| 리소스 | 복사 방법 | 주의 |
|---|---|---|
| 스킬 (폴더) | 폴더 전체를 대상 호스트의 같은 범위(user/project)로 복사 | 스킬이 실행하는 프로그램이 대상 OS에 있는지 경고 |
| 프롬프트 템플릿 (`.md`) | 파일 복사 | — |
| 확장 (파일·폴더) | 파일 복사 | OS 의존 코드(경로 구분자, `powershell` 등) 정적 감지 후 경고 |
| Pi 패키지 | 파일이 아니라 **선언을 옮긴다**: 대상 호스트에서 `pi install <같은 source>` 실행. 리소스 필터 설정도 함께 복사 | 로컬 경로 패키지는 경로가 달라지므로 폴더째 복사한 뒤 새 경로로 설치할지 묻는다 |
| AGENTS.md / SYSTEM.md / APPEND_SYSTEM.md (user 범위) | 파일 복사 | 대상에 이미 있으면 diff를 보여주고 덮어쓰기·병합·취소 선택 |
| settings.json | **항목 단위로 골라서** 복사 (전체 덮어쓰기 금지) | `shellPath`, `sessionDir`처럼 호스트마다 달라야 하는 항목은 기본으로 제외 |
| models.json | 프로바이더·모델 항목 단위로 골라서 복사 | `localhost` 엔드포인트는 대상 호스트에서 접근 가능한지 경고 |
| auth.json (인증 정보) | **복사하지 않는다** | 대상 호스트에서 다시 로그인하도록 Providers 화면으로 안내 |

**사용 흐름**
1. 리소스 목록이나 상세 화면에서 "다른 호스트로 복사"를 누른다. 여러 개를 골라 한꺼번에 복사할 수도 있다.
2. 대상 호스트를 고르고(여러 개 가능), 범위(user / 특정 프로젝트)를 고른다.
3. **미리보기**: 대상에 새로 생기는 파일, 바뀌는 파일(diff), 이름이 충돌하는 항목, 경고를 보여준다.
4. 적용하면 Host Agent의 원자적 쓰기로 저장하고, 해당 호스트에 열린 세션에 리로드 배너를 띄운다.
5. Marketplace에서 설치할 때도 설치 대화상자에서 대상 호스트를 여러 개 고를 수 있다. 같은 source로 각 호스트에 따로 설치한다.

**출처 기록**: 복사 이력(원본 호스트, 경로, 시각, 파일 해시)을 GUI 메타데이터(`userData/copies.json`)에 남긴다. 리소스 상세 화면에 "Windows에서 복사됨 · 이후 원본이 바뀜" 같은 정보를 보여주고, 다시 복사할 때 바뀐 부분만 diff로 보여준다. 이 정보는 안내용일 뿐이고 자동으로 반영하지 않는다.

**호스트 비교 화면** (선택): 두 호스트를 골라 리소스 목록을 나란히 놓고, 한쪽에만 있는 것과 내용이 다른 것을 표시한다. 여기서 바로 복사할 수 있다.

**구현 메모: 스킬·프롬프트 복사 (M4, v0.37)** — 첫 단계는 스킬과 프롬프트만 한다.
- 원본 호스트 데몬의 `resources.export`가 읽는다.
  - 스킬은 SKILL.md가 있는 폴더 전체, 파일 하나 스킬은 SKILL.md로 담는다. 프롬프트는 .md 하나다.
  - 개수·크기 한도는 가져오기와 같다.
- 대상 호스트 데몬은 기존 `resources.import`로 쓴다.
  - 같은 이름이 있으면 거부한다. "대상의 것을 백업하고 바꾸기"를 고르면 `replace`로 이전 것을 대상의 백업 폴더로 옮긴 뒤 바꾼다.
- 리소스 창의 스킬·프롬프트 항목에 "다른 호스트로"가 있다(다른 호스트가 있을 때만).
  - 대상 호스트·범위·이름을 고르고 파일 목록을 미리 본다.
  - 대상 OS(연결 정보의 platform)에서 돌지 않을 스크립트를 경고한다: Windows 대상의 `.sh`, 그 밖 대상의 `.ps1`·`.bat`.
- 확인: 로컬(Windows)의 프로젝트 스킬을 WSL(Ubuntu)의 사용자 범위로 복사했다.
  - `.ps1` 경고가 나왔다.
  - 같은 이름으로 다시 복사하니 거부되었고, "백업하고 바꾸기"를 고르자 이전 것이 WSL 쪽 백업 폴더로 옮겨졌다.
- 아직 하지 않은 것
  - settings.json·models.json 항목 단위 복사
  - 확장 복사(OS 의존 코드 감지)
  - 여러 개·여러 호스트 한꺼번에
  - 복사 기록(`copies.json`)
  - 호스트 비교 화면

**구현 메모: AGENTS.md·패키지 옮기기 (M4, v0.38)** — 데몬은 기존 기능만 쓴다.
- 사용자 범위 AGENTS.md·SYSTEM.md·APPEND_SYSTEM.md
  - 리소스 창 컨텍스트 탭에서 데이터 폴더 안 파일(`~agent/…`)에만 "다른 호스트로"가 있다.
  - 대상 데이터 폴더는 대상의 `pi.status`로 얻고, 대상 OS 구분자로 같은 이름을 붙인다.
  - 대상에 있으면 차이(− 대상의 지금 내용 · + 복사할 내용)를 보이고 "덮어쓰기"로 묻는다. 같으면 막는다.
  - 쓰기는 `resources.write`의 수정 시각 확인과 백업(대상 `resource-backups/`)을 그대로 쓴다.
  - 병합은 하지 않는다. 필요하면 대상에서 편집기로 고친다.
- 패키지
  - 패키지 탭의 "다른 호스트에 설치"는 파일을 옮기지 않는다. 대상 호스트의 내장 터미널에서 같은 소스로 `pi install`(프로젝트면 `-l`)을 실행한다.
  - 로컬 경로 소스(`./`, `/`, `~/`, `C:`, `file:`)는 호스트마다 경로가 달라 막는다.
  - "일부만 사용" 필터는 v0.48부터 설치가 끝난 뒤 함께 옮긴다.
- 확인: 로컬(Windows) → WSL(Ubuntu)
  - AGENTS.md: 새로 만들기, 로컬을 고친 뒤 차이를 보고 덮어쓰기, 대상 백업 생성
  - 패키지: 대상 터미널에서 `pi install npm:@tmustier/pi-skill-creator`가 코드 0으로 끝나고 WSL 설정에 기록됨
  - 시험 뒤 WSL 설정·파일은 원래대로 되돌렸다.

**구현 메모: models.json 프로바이더 옮기기 (M4, v0.39)** — 항목 단위는 프로바이더 하나다.
- 데몬
  - `models.exportProvider`는 프로바이더 하나를 통째로 담는다. compat·headers·모델별 필드처럼 폼에 없는 것도 옮긴다.
  - 그대로 값인 `apiKey`와 헤더 값은 비밀일 수 있어 빼고 `dropped`로 알린다. 환경 변수(`$X`·`${X}`)와 명령(`!cmd`) 참조는 남긴다.
  - `models.importProvider`는 같은 이름이 있으면 거부한다. `replace`면 바꾸되, 대상의 `apiKey`와 헤더 값은 남긴다(들어온 것이 같은 헤더를 주면 그것이 이긴다).
- 앱
  - Pi 관리 → 모델의 프로바이더 줄에 "다른 호스트로"가 있다(다른 호스트가 있을 때만).
  - 뺀 비밀 필드와, localhost·127.x·0.0.0.0·[::1] 주소는 대상 호스트 기준으로 해석된다는 경고를 보인다.
  - 대상에 있으면 "대상의 것을 바꾸기"로 묻는다.
- 확인: 로컬(Windows)의 `mock` 프로바이더 → WSL(Ubuntu)
  - API 키가 빠진 채 새 models.json이 생겼다.
  - 대상에 키를 넣고 다시 복사하니 거부되었고, "바꾸기" 뒤에도 대상의 키가 남았다.
  - 시험 뒤 WSL의 models.json은 지웠다(원래 없었다).
- 모델 하나 옮기기와 여러 개 한꺼번에는 v0.49에서 붙였다.

**구현 메모: settings.json 항목 단위 복사 (M4, v0.40)** — 단위는 최상위 키다.
- 데몬
  - `settings.read`는 사용자 settings.json의 최상위 값을 그대로 준다. 깨진 파일이면 `error`를 담는다.
  - `settings.merge`는 받은 최상위 키만 바꾸고 나머지는 둔다.
    - 쓰기 직전에 다시 읽어, 그 사이 Pi가 바꾼 다른 키를 지우지 않는다.
    - `settings.json.bak` 백업 뒤 원자적으로 쓴다. 깨진 파일은 덮어쓰지 않는다.
  - 중첩 객체(compaction 등)는 키 단위로 통째로 바꾼다. 하위 필드 병합은 하지 않는다.
- 앱: Pi 관리에 "설정" 탭
  - 원본 호스트의 항목마다 복사할 값과 대상의 지금 값, 상태(대상에 없음·다름·같음)를 보인다.
  - 다르거나 대상에 없는 항목은 처음부터 골라 둔다.
  - 호스트마다 다른 항목은 고르지 않은 채 이유를 보인다: `shellPath`·`sessionDir`·`externalEditor`·`shellCommandPrefix`·`npmCommand`·`httpProxy`·`extensions`·`skills`·`prompts`·`themes`.
  - `packages`는 고를 수 없다. 설치가 따라야 하므로 패키지 탭의 "다른 호스트에 설치"로 안내한다.
  - 기본 모델 관련 항목에는 "대상에 같은 프로바이더·모델이 있어야 한다"고 알린다.
  - Pi 내부 값(`lastChangelogVersion`·`deviceId`·`trackingId`)은 보이지 않는다. 프록시 주소의 계정은 가린다.
- 프로젝트 범위 `.pi/settings.json`은 아직 다루지 않는다.
- 확인: 로컬(Windows) dev 설정 → WSL(Ubuntu)
  - 기본으로 고른 3개를 복사했다(defaultModel은 해제). 대상의 다른 키는 남았고 `.bak`이 생겼다.
  - 다시 읽은 뒤에도 해제한 항목은 해제된 채였다.
  - 시험 뒤 WSL·dev 설정은 원래대로 되돌렸다.

**구현 메모: 확장 복사 (M4, v0.41)** — 스킬·프롬프트 복사(`resources.export`·`import`)에 `extension` 종류를 더했다.
- 모양: Pi가 불러오는 두 모양을 그대로 옮긴다.
  - `.ts`·`.js` 파일 하나는 `extensions/<이름><확장자>`로 쓴다.
  - `index.ts`·`index.js`가 있는 폴더는 `extensions/<이름>/`으로 폴더째 쓴다.
  - 같은 이름이 다른 모양(파일↔폴더)으로 있으면 Pi가 둘 다 불러오므로, "바꾸기"여도 거부한다.
- 의존성
  - 폴더의 `node_modules`·`.git`은 옮기지 않고 `skipped`로 알린다.
  - `package.json`에 dependencies가 있으면 `needsInstall`로 알린다. 앱은 대상 폴더에서 `npm install`할 명령을 보여 준다(실행은 하지 않는다).
- OS 의존 코드 정적 감지 (앱, 정규식)
  - 유닉스 대상: PowerShell·`cmd /c`·드라이브 경로 문자열·`.exe`
  - Windows 대상: `/usr/`·`/bin/` 같은 경로 문자열·`sh -c`·`chmod`·`xdg-open`
  - `process.platform`으로 나눠 쓰는 파일이면 "괜찮을 수도 있다"고 덧붙인다. 막지는 않는다.
- 패키지에 든 확장도 복사할 수 있다. 대상에서는 패키지와 상관없는 독립 사본이 된다.
- 확인: 로컬(Windows) dev 데이터 폴더의 폴더 확장 → WSL(Ubuntu)
  - 확장에는 PowerShell 호출, 의존성, node_modules가 들어 있었다.
  - PowerShell 경고, node_modules 제외, npm install 안내가 나왔다.
  - 파일 3개가 복사되었다.
  - 다시 복사하니 거부되었고, "백업하고 바꾸기" 뒤에 이전 것이 WSL 쪽 백업으로 옮겨졌다.
  - 시험 뒤 양쪽의 시험 확장과 백업은 지웠다.

**구현 메모: 복사 기록 (M4, v0.42)** — 앱 userData의 `copies.json`
- 무엇을 남기나
  - 대상: 스킬·프롬프트·확장·사용자 AGENTS.md 등 파일로 된 것
  - 기록 내용: 종류, 이름, 원본 호스트·경로, 대상 호스트·경로, 시각, 파일별 git blob SHA
  - 같은 대상 위치는 하나만 두고, 다시 복사하면 바꾼다.
  - 프로바이더·settings.json 항목은 파일이 아니라서 남기지 않는다.
- 경로
  - 대상 경로는 대상 리소스 목록에 보일 진입 파일로 남긴다(스킬은 `SKILL.md`, 폴더 확장은 원본의 index 파일). 그래야 목록 항목과 바로 맞출 수 있다.
  - 원본 경로는 원본 리소스 목록의 경로다.
- 상태 확인(리소스 창을 열 때)
  - 사본과 원본을 `resources.export`로 다시 읽어 해시를 견준다. 데몬에 새 메서드는 없다.
  - 사본: 그대로 / 이 호스트에서 고침 / 지워짐
  - 원본: 그대로 / 바뀜 / 없어짐 / 확인 못함(호스트가 닿지 않음 등, 20초 제한)
  - 파일 하나짜리는 이름이 바뀔 수 있어 내용만 견준다.
- 표시
  - 리소스 창 항목에 "○○에서 복사됨 · 이 호스트에서 고침 · 이후 원본이 바뀜" 배지를 붙인다.
  - 배지에 마우스를 올리면 원본 경로와 복사 시각을 보인다.
  - 안내용이며 자동으로 반영하지 않는다.
  - 기록이 실패해도 복사 결과에는 영향을 주지 않는다.
- 다시 복사할 때 차이 보기는 v0.49에서 호스트 비교 화면에 붙였다.
- 확인: 로컬(Windows) dev 스킬 → WSL(Ubuntu)
  - 복사 직후 WSL 리소스 창에 "로컬 (Windows)에서 복사됨"이 나왔다.
  - 양쪽 파일을 고치자 "이 호스트에서 고침 · 이후 원본이 바뀜"이 나왔다.
  - 되돌리자 배지가 "복사됨"만 남았다.
  - 시험 뒤 스킬과 `copies.json`은 지웠다.

**구현 메모: 호스트 비교 화면 (M4, v0.43)** — Pi 관리의 "비교" 탭
- 범위
  - 사용자 범위만 견준다: 데이터 폴더의 AGENTS.md·SYSTEM.md·APPEND_SYSTEM.md, 스킬·프롬프트·확장
  - 패키지에 든 것과 프로젝트 범위는 뺀다. 프로젝트 폴더는 호스트마다 경로가 달라 짝을 정할 수 없다.
- 목록 수집 (앱 main의 `hostInventory`)
  - 데이터 폴더를 작업 폴더로 `resources.list`를 부른다.
  - 항목마다 `resources.export`로 읽어 해시를 매긴다.
    - 파일 하나면 그 blob SHA를 쓴다. 이름이 달라도 같게 본다.
    - 여러 파일이면 경로·SHA 목록의 SHA-1을 쓴다.
  - 데몬 변경은 없다.
- 맞추기: 종류와 이름으로 짝을 짓는다. 상태는 한쪽에만 / 같음 / 내용 다름 / 확인 못함(읽기 실패)이다.
- 화면
  - "다른 것만"이 기본이고, 머리글에 상태별 개수를 보인다.
  - 줄마다 "→ 상대 호스트" / "← 이 호스트" 버튼으로 바로 복사한다. 사용자 범위에 같은 이름으로 쓴다.
  - 내용이 다르면 덮어쓰기(이전 것은 대상 백업)를 그 줄 아래에서 한 번 더 묻는다.
  - 대상 OS 경고(스크립트·확장 코드)와 node_modules·npm install 안내가 있어도 같은 자리에서 묻는다.
  - 복사하면 `copies.json`에 출처를 남기고 목록을 다시 읽는다.
- 확인: 로컬(Windows) dev ↔ WSL(Ubuntu)
  - 시험 항목: 로컬에만 있는 AGENTS.md·스킬, WSL에만 있는 스킬, 양쪽에 있지만 내용이 다른 프롬프트
  - 처음에는 "내용 다름 1 · 로컬에만 2 · WSL에만 1"로 나왔다.
  - 양방향 복사와 덮어쓰기(WSL 쪽 백업 생성)를 마치자 "두 호스트가 같습니다"가 나왔다.
  - 시험 뒤 양쪽의 시험 파일·백업과 `copies.json`은 지웠다.

**구현 메모: §5.9 마무리 (M4, v0.49)** — 남은 네 가지
- 다시 복사할 때 차이 보기 (호스트 비교)
  - "내용 다름"을 한 줄씩 복사하면, 덮어쓰기 전에 대상의 지금 파일과 복사할 파일을 견준다.
  - 파일마다 새로 생김 / 바뀜(diff) / 대상에만 있어 사라짐을 보인다. 폴더째 바꾸므로 대상에만 있던 파일은 사라진다.
  - 파일 하나짜리는 이름이 달라도 짝짓는다. 0바이트가 든 파일은 글로 보이지 않는다.
- 여러 개 한꺼번에 (호스트 비교)
  - 줄마다 체크박스를 두고 "고른 n개 → 상대 호스트" / "← 이 호스트"로 복사한다.
  - 원본 쪽에 있고 같지 않은 줄만 그 방향으로 옮긴다.
  - 덮어쓸 것과 OS 경고는 한 번에 모아 묻는다.
  - 차례로 복사하며, 하나가 실패해도 나머지는 계속하고 결과를 모아 알린다.
- 모델 하나 옮기기
  - 데몬 `models.exportModel`·`importModel`을 더했다.
  - 모델 항목을 통째로 옮기되, 그대로 값인 헤더는 뺀다.
  - 받는 쪽은 같은 이름의 프로바이더에 넣는다. 그 프로바이더가 없으면 프로바이더째 옮기라고 거부한다.
  - 같은 ID는 "바꾸기"일 때만 바꾸고, 대상 모델의 헤더 값은 남긴다.
  - 모델 탭의 "다른 호스트로" 패널에서 "복사할 것"(프로바이더 전체 / 모델 하나)을 고른다.
- 프로젝트에서만 고르기(덧씌우기)
  - 프로젝트 settings에 `{ source, autoload: false, … }` 항목을 두면, Pi는 그것을 사용자 패키지 위의 필터로 본다(+ 켬, - 끔, 없으면 사용자 설정을 따름).
  - `packages.resources`·`setFilter`의 `overlay`로 다룬다.
    - 덧씌우기가 있으면 Pi가 그 패키지를 project 범위로 보고하므로, 읽을 때 범위는 따지지 않는다.
    - 덧씌울 것이 없어지면 항목을 지운다.
  - 리소스 창 패키지 탭에서 프로젝트 폴더를 볼 때, 사용자 패키지에 "이 프로젝트에서만 고르기"와 "덧씌우기 지우기"가 있다.
  - 사용자 settings는 바꾸지 않는다. 프로젝트 설정이므로 폴더를 신뢰해야 쓰인다.
  - 참고: Windows에서도 Pi는 `/` 구분자 패턴을 받아들였다.
- 확인: 로컬(Windows) dev ↔ WSL(Ubuntu)
  - 차이 보기: 여러 파일 스킬의 덮어쓰기 전 차이에서 a.txt 새로 생김, old.txt 사라짐, SKILL.md 바뀜이 나왔다.
  - 한꺼번에: 세 개(새 스킬 하나, 덮어쓰기 둘)를 한 번에 확인하고 복사했다. 나머지 하나를 가져오자 "두 호스트가 같습니다"가 나왔다.
  - 모델: 대상에 프로바이더가 없으면 거부되었다. 프로바이더째 옮긴 뒤 모델 하나 넣기와 바꾸기가 되었다.
  - 덧씌우기: 프로젝트 `.pi/settings.json`에만 `-SKILL.md`가 적혔고, 스킬 탭에 "꺼짐 · 신뢰해야 불러옴"이 나왔다. "덧씌우기 지우기"로 항목이 지워졌다.
  - 시험 뒤 양쪽의 시험 파일·백업·설정과 기록 파일은 지웠다.

### 5.10 웹 서버 pi-web — 휴대폰 브라우저로 쓰기 (v0.70)

**목표**: Android 휴대폰(예: 갤럭시 S25) 하나로 Pi와 GUI를 모두 쓴다. Electron은 Android에서 돌지 않으므로, main 프로세스 자리를 Node 웹 서버가 맡고 화면은 휴대폰 브라우저로 연다. VS Code의 code-server와 같은 방식이다.

```
[휴대폰 브라우저] ──HTTP(화면 파일)·WebSocket(API)──▶ [pi-web 서버 (Termux의 Node)]
   renderer 그대로                                     main의 처리기 그대로 (ipc-handlers.ts)
   window.piDesktop = WsTransport                         │ stdio
                                                    [host-agent connect] ─▶ [데몬 agentd] ─▶ pi --mode rpc
```

- **같은 코드를 쓴다**
  - 처리기: `main/ipc-handlers.ts`의 `registerHandlers(router, deps)`. Electron은 ipcMain을, 웹 서버는 `server/web-router.ts`를 Router로 넘긴다. OS 대화상자·탐색기 보이기만 deps로 다르게 준다(웹은 없음).
  - 화면 API: `shared/api-client.ts`의 `createPiDesktopApi(transport, shell)`. preload는 ipcRenderer를, 웹은 `web/ws-transport.ts`를 넘긴다.
  - 화면은 `window.piDesktop.shell`이 `"web"`이면 로컬 호스트도 앱의 폴더 탐색 창을 쓰고, "탐색기에서 보기"를 감춘다.
- **메시지** (`shared/web-protocol.ts`): JSON 한 개씩. `invoke`(id로 응답 짝짓기)·`send`·`event`. JSON은 배열 속 undefined를 null로 바꾸므로 undefined였던 인자 자리를 `u`에 적어 되살린다(settingsWrite의 baseMtime처럼 null이 다른 뜻인 인자가 있다). 오류 문구는 Electron과 같은 접두사("Error invoking remote method …")로 돌려줘 화면의 기존 처리를 그대로 쓴다.
- **보안** (`server/auth.ts`): 서버는 main 프로세스와 같은 힘(명령 실행·파일 쓰기)을 가진다.
  - 기본으로 127.0.0.1에만 연다. 휴대폰의 다른 앱도 localhost에 붙을 수 있으므로 **토큰이 꼭 필요**하다. 토큰은 처음 실행할 때 만들어 데이터 폴더에 0600으로 둔다.
  - 서버가 알려 주는 주소는 `http://127.0.0.1:8787/#token=…`. `#` 뒤는 서버로 가지 않는다. 화면이 읽어 localStorage에 두고 주소창에서 지운다. WebSocket은 `?token=`, 확인용 `/api/auth`는 Bearer로 받는다. 비교는 해시끼리 timingSafeEqual.
  - localhost에만 열었으면 Host가 localhost·127.0.0.1·[::1]이 아닌 요청을 막는다(DNS rebinding). Origin이 있으면 Host와 같아야 한다(다른 웹사이트가 브라우저를 시켜 붙는 것).
  - 화면 파일(public/)은 비밀이 없어 토큰 없이 내준다. 경로는 public 밖으로 나가지 못한다.
- **연결 끊김**: 휴대폰 브라우저는 백그라운드 탭의 WebSocket을 끊는다. WsTransport가 지수 백오프로 다시 붙고, 화면이 다시 보이거나 네트워크가 돌아오면 바로 붙는다. 다시 붙으면 화면이 연결했던 호스트마다 connectionChanged를 다시 알린다. 화면은 "connected"를 받으면 보던 세션에 마지막 순번부터 다시 붙으므로(§3.4) 끊긴 동안의 이벤트를 잃지 않는다. 끊긴 동안 기다리던 응답은 실패로 끝낸다(서버가 받았는지 모름). 서버는 30초마다 ping으로 죽은 연결을 정리한다.
  - 확인함: 서버를 껐다 켜도 열린 페이지가 다시 붙고, 데몬 아래의 Pi 세션이 그대로 이어진다.
- **내장 터미널**: node-pty는 네이티브 모듈이고 Android용 미리 빌드된 파일이 없다. 터미널은 처음 열 때 node-pty를 불러오고, 없으면 그 터미널만 안내 오류로 실패한다(다른 기능은 그대로). 설치 스크립트를 `--terminal`로 실행하면 Termux에서 빌드한다(python·make·clang, node-gyp의 `android_ndk_path` 문제는 `~/.gyp/include.gypi`로 피한다).
- **좁은 화면**(`max-width: 720px`): 사이드바는 ☰ 버튼으로 여는 서랍, 세션을 보는 동안 "새 세션 폴더" 줄은 서랍과 함께 연다. 파일 트리는 본문 위에 겹쳐 띄운다. 입력창은 한 줄 전체, 버튼은 그 아래.
- **묶음과 설치** (`scripts/build-web.mjs`, `scripts/web/`):
  - `pi-web.tar.gz`: `server.mjs`(ws까지 esbuild 한 파일, node-pty만 밖), `public/`(vite.web.config.ts), `host-agent/`, `bin/pi-web`, `package.json`. 플랫폼과 상관없는 JS라 Linux 한 곳에서 만든다(1.6MB 정도).
  - `install-termux.sh`: `pkg install nodejs-lts curl tar` → Pi가 없으면 `npm install -g` → 릴리스에서 묶음을 받아 `~/.pi-web/app`에 바꿔 넣기(데이터·토큰·빌드한 node-pty는 남긴다, 켜져 있었으면 다시 켠다) → `$PREFIX/bin/pi-web` → 켜고 브라우저 열기(`termux-open-url`). 릴리스 저장소는 빌드할 때 넣는다(GITHUB_REPOSITORY 또는 git origin). `latest/download/` 주소가 되도록 파일 이름에 버전을 넣지 않는다.
  - `pi-web`: start(백그라운드, `termux-wake-lock`)·run·stop·restart·status·url·open·log·update·uninstall. 서버를 꺼도 데몬과 Pi 세션은 계속 돈다.
  - 데이터: `~/.pi-web/data`(토큰, ssh-hosts.json, imports.json, copies.json, activity-log.jsonl, server.log). 데스크톱 앱의 userData에 해당한다. 데몬 홈(`~/.pi-desktop`)은 데스크톱과 같다.
- 앱 자동 업데이트는 웹에서 끈다(`status: "disabled"`). 웹 묶음은 `pi-web update`로 바꾼다.
- 개발: `npm run dev:web -w @pi-desktop/desktop`(mock LLM + 웹 서버, 데이터는 `.dev/pi-web`).
- 아직 하지 않은 것
  - 실제 Android 기기에서의 확인 (Linux에서 360×780 화면, 서버 재시작·재연결, 설치 스크립트를 `--file`로 확인했다)
  - 화면 복사·붙여넣기 외의 파일 올리기, PWA 오프라인(서비스 워커)
  - HTTPS (같은 기기 localhost는 브라우저가 안전한 출처로 본다. 다른 기기에서 쓰려면 Tailscale 등 VPN 뒤에 두기를 권한다)

## 6. 기술 스택

| 영역 | 선택 |
|---|---|
| 셸 | Electron + electron-vite, electron-builder (Windows 우선, macOS/Linux) |
| UI | React 19 + TypeScript + Tailwind + shadcn/ui, Zustand, TanStack Query |
| 에디터 / 터미널 | Monaco / xterm.js + node-pty |
| 채팅 렌더링 | react-markdown + shiki, diff는 `diff` + 자체 뷰어 |
| 폼 | JSON Schema 기반 자동 폼 |
| Host Agent | Node 22+, 의존성 없는 esbuild 단일 번들, JSON-RPC 2.0 over stdio |
| SSH | 시스템 `ssh`(ControlMaster), 필요 시 `ssh2` |
| 테스트 | Vitest, Playwright-Electron(E2E), **Pi 계약 테스트**(실제 `pi --mode rpc` 대상, Pi 최신 버전으로 매일 실행), WSL·SSH는 Docker sshd 컨테이너로 통합 테스트 |

## 7. 폴더 구조 (안)

```
pi-desktop/
├ apps/desktop/
│  ├ src/main/      HostManager, transports/{local,wsl,ssh}, WorkspaceManager, CatalogService, LeaseManager, ipc/
│  ├ src/preload/   contextBridge API (typed)
│  └ src/renderer/  features/{chat,sessions,context,prompts,skills,extensions,marketplace,providers,settings,pi-manager,playground,inspector,terminal}
├ packages/
│  ├ host-agent/    대상 호스트에서 도는 Agent: agentd(상주 데몬, 세션·저널) + connect(연결기)
│  ├ host-protocol/ Agent ↔ App 메시지 타입 (zod)
│  ├ pi-protocol/   Pi RPC·이벤트 타입 (관대한 파싱)
│  ├ bridge/        pi-desktop-bridge 확장
│  ├ catalog/       CatalogProvider: npm, pi.dev, github, url
│  └ harness/       Playground용 observe(session)
├ templates/        스킬·프롬프트·확장·SDK 스캐폴드
└ docs/DESIGN.md
```

## 8. 로드맵 (채팅 우선으로 재조정)

| 단계 | 범위 | 완료 기준 |
|---|---|---|
| **M0 스파이크** | 로컬 `host-agentd` + `connect` + `pi.rpc.open` + 스트리밍 채팅 1회 + 툴 이벤트 표시 | Electron 창에서 로컬 `pi`와 대화 가능. **처음부터 데몬 구조로 만든다** (나중에 바꾸면 비용이 큼) |
| **M1 Chat 완성 + WSL** | **WSL 호스트(관리형 Pi 탐색, Agent 자동 배포, 호스트 선택) — 사용자 요청으로 M3에서 앞당김**, §4.1 전체, 세션 목록·재개·트리·fork, 확장 UI 다이얼로그, 워크스페이스 탭(여러 프로젝트), Activity 사이드바, **세션 lease와 TUI 팔로우 모드**, **이벤트 저널·재연결·GUI 재시작 후 세션 복원(로컬)** | 일상 작업에서 TUI 없이 지낼 수 있다 |
| **M2 Pi Manager + Providers** | 로컬 설치·업데이트·제거·롤백, API 키 폼, OAuth용 내장 터미널, models.json | 새 PC에서 GUI만으로 Pi 설치부터 첫 대화까지 가능 |
| **M3 SSH (+ WSL 보강)** | SSH transport, Agent 부트스트랩·배포, WSL 내부 폴더 탐색, 원격 데몬 분리 실행, 원격 파일 피커, 자동 재연결, 다중 GUI writer 권한 | 원격 작업 중 GUI를 닫았다 다시 열어도 그대로 이어서 작업할 수 있다 |
| **M4 리소스 관리 + Marketplace** | AGENTS.md 계층, 프롬프트·스킬·확장 CRUD, bridge reload, 설정 폼, npm·GitHub 카탈로그 검색·설치·제거·업데이트, 호스트 간 복사(§5.9) | 클릭으로 커뮤니티 리소스를 찾아 설치하고 즉시 쓸 수 있다 |
| **M5 개발자 도구 + 다듬기** | SDK Playground, Event Inspector, Extension Dev Mode, 호스트 비교 화면, 인스톨러·자동 업데이트 | 배포 |

> M3(원격)를 M4보다 앞에 둔 이유: Host Agent 구조가 원격에서 실제로 버티는지 일찍 검증해야, 그 위에 올라가는 리소스 관리·Marketplace를 다시 만들 일이 없다.

## 9. 리스크

| 리스크 | 대응 |
|---|---|
| Pi RPC·이벤트 스키마 변경 | 관대한 파싱 + raw 폴백, 매일 계약 테스트, 설치 버전의 d.ts로 타입 생성 |
| 패키지 스코프·이름 변경 (이미 한 번 있었음) | PiLocator 후보 목록 + 사용자 지정 경로 |
| 세션 파일 동시 쓰기 | §5.4의 lease·팔로우 모드. Pi가 공식 잠금을 추가하면 그쪽으로 전환 |
| 원격 호스트에 Node 없음 또는 버전 낮음 | 부트스트랩 단계에서 감지하고 설치 마법사로 연결 |
| node-pty 네이티브 빌드 (원격) | pty 기능을 선택 사항으로 두고 `script`/python 대체 경로 사용 |
| 데몬과 GUI의 버전 불일치 | 프로토콜 버전 협상, 세션이 없을 때만 데몬 교체 (§3.4) |
| WSL 배포판 자동 종료로 데몬이 죽음 | systemd 켜진 Ubuntu에서 연결 끊김 후 생존 확인(M1). 장시간 유휴와 systemd 없는 배포판은 미확인 → 필요하면 keep-alive |
| 저널 메모리 사용량 | 세션당 링버퍼 상한(기본 1만 이벤트). 넘치면 오래된 것부터 버리고 스냅샷으로 복구 |
| 커뮤니티 확장의 악성 코드 | 설치 전 경고, 소스·의존성 요약, 프로젝트 trust 연동. 코드 실행 자체를 막지는 못한다는 점을 명시 |
| Windows 셸 (Git Bash 필요) | Pi Manager 전제 조건 점검에서 안내 |

## 10. 정리된 질문들 (v0.4)

| 질문 | 결론 |
|---|---|
| pi.dev 갤러리 공개 API | 없음. npm `pi-package` 키워드 검색을 사용한다 (§4.6) |
| GUI를 닫아도 원격 작업 유지 | 유지한다. 상주 데몬과 이벤트 저널로 재연결한다 (§3.4) |
| 호스트 간 리소스 공유 | **확정: 호스트마다 따로 관리하고, 필요할 때 복사해서 적용한다.** 자동 동기화는 넣지 않는다 (§5.9) |

## 11. 개발 방식

### 11.1 언어 규칙
- 소스 주석, 커밋 메시지(제목·본문), PR 설명, 문서는 **모두 한글**로 쓴다.
- 코드 식별자(변수·함수·타입 이름)와 로그 키는 영어로 쓴다. 사용자에게 보이는 UI 문자열은 i18n 리소스로 분리하고, 기본 언어는 한국어로 한다.

### 11.2 커밋 단위 — 코드 리뷰가 가능한 크기
- **한 커밋 = 한 가지 관심사.** 리팩터링, 기능 추가, 포맷 변경을 섞지 않는다.
- 커밋마다 빌드와 테스트가 통과해야 한다. 중간 커밋을 체크아웃해도 동작해야 한다.
- 크기는 diff 기준 대략 400줄 이하를 목표로 한다. 자동 생성 파일과 lockfile은 별도 커밋으로 분리한다.
- 새 모듈은 "타입·인터페이스 → 구현 → 테스트 → 연결(wiring)" 순서로 나눠 커밋하면 리뷰하기 쉽다.

### 11.3 커밋 메시지 형식
[Conventional Commits](https://www.conventionalcommits.org/) 타입 접두어 + 한글 설명:

```
feat(host-agent): 세션 이벤트 저널과 seq 기반 재연결 추가

- 세션마다 RPC 이벤트에 순번을 붙여 링버퍼와 디스크에 기록
- attach(sessionId, lastSeq) 호출 시 누락 이벤트를 재생
- 저널에서 잘린 경우 get_messages 스냅샷으로 복구

관련: docs/DESIGN.md §3.4
```

| 타입 | 용도 |
|---|---|
| `feat` | 기능 추가 |
| `fix` | 버그 수정 |
| `refactor` | 동작 변화 없는 구조 변경 |
| `test` | 테스트만 추가·수정 |
| `docs` | 문서 |
| `build` / `ci` | 빌드 설정, CI |
| `chore` | 그 밖의 잡무 (의존성 갱신 등) |

범위(scope)는 §7의 폴더 이름을 쓴다: `host-agent`, `pi-protocol`, `bridge`, `catalog`, `desktop-main`, `desktop-renderer` 등.

### 11.4 브랜치와 PR
- `main`은 항상 동작하는 상태를 유지한다. 작업은 `feat/<마일스톤>-<주제>` 브랜치에서 하고 PR로 합친다.
- PR 하나는 마일스톤 안의 기능 하나 단위로 만든다. 설명에는 변경 요약, 관련 설계 문서 절, 테스트 방법, 스크린샷(UI 변경 시)을 넣는다.
- 병합은 커밋 이력이 그대로 남도록 rebase merge나 merge commit을 쓴다. squash하면 리뷰 단위로 나눈 커밋이 사라지므로 쓰지 않는다.

### 11.5 main 브랜치 룰셋 ("main 보호")
GitHub 저장소 룰셋으로 위 규칙을 강제한다.

| 규칙 | 설정 |
|---|---|
| 브랜치 삭제 | 금지 |
| 강제 push | 금지 |
| 병합 | PR 필수, 허용 방식은 merge commit·rebase (squash 불가), 리뷰 스레드는 모두 해결해야 함 |
| 필수 승인 수 | 0 (1인 저장소라 본인 PR을 스스로 승인할 수 없기 때문. 협업자가 생기면 1로 올린다) |
| 필수 상태 검사 | CI 4개 작업: `ubuntu-latest / Node 22·24`, `windows-latest / Node 22·24` |
| 우회 | 저장소 관리자. 문서 변경을 main에 바로 push하는 용도로만 쓴다 |

CI 작업 이름(`.github/workflows/ci.yml`의 매트릭스)을 바꾸면 룰셋의 필수 상태 검사 이름도 함께 바꿔야 한다. 그렇지 않으면 PR이 영원히 대기 상태가 된다.
