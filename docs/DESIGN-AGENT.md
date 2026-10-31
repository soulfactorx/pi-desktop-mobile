# Pi Desktop Agent — 설계 문서 (v0.3)

> **데이터 경계는 [세 앱의 역할과 데이터 경계](DESIGN-APPS.md)를 따른다.** 이 문서의 v0.3까지는 Pi Desktop·터미널 `pi`와 세션·스킬·MCP를 함께 쓴다고 적었지만, Agent는 혼자 쓰는 커스텀 Pi이므로 데이터를 나눈다 (§1·§2.2·§3을 그에 맞게 고쳤다).
>
> 관련 문서: [Pi Desktop 설계](DESIGN.md) — 이 문서는 그 위에 올라가는 두 번째 앱을 다룬다. [Pi Desktop Mate 설계](DESIGN-MATE.md), [개발 방식](CONTRIBUTING.md). 사용법은 [apps/agent/README.md](../apps/agent/README.md)

Pi Desktop이 "설치된 Pi를 그대로 GUI로 쓰는 앱"이라면, Pi Desktop Agent는 **Pi를 엔진으로 삼아 내가 원하는 기능을 가진
데스크톱 에이전트**다. 사용자가 채팅으로 요청하면 에이전트가 LLM과 로컬 도구를 조합해 처리하되,
**데스크톱 자원에 손대는 일은 사용자 승인을 거친다.**

이전에 따로 만들던 `desktop-agent`(Vercel AI SDK 기반 자체 루프)의 기능과 설계를 Pi 위에서 처음부터 다시 구현한다.
기존 코드·데이터는 가져오지 않는다. 데이터 형식, 루프, 세션, 설정은 모두 Pi 것을 그대로 쓴다.

---

## 0. 확정된 결정

| 항목 | 결정 |
|---|---|
| 저장소 | **pi-desktop 모노레포에 추가한다.** `apps/agent`(Electron 앱) + `packages/agent-kit`(기능 = Pi 패키지) |
| 엔진 | 수정하지 않은 `pi`. Host Agent 데몬이 `pi --mode rpc`로 띄운다 (DESIGN.md §3.4 그대로) |
| 기능 구현 위치 | **Pi 확장·스킬**(`agent-kit`). 앱은 Pi 프런트엔드일 뿐이다 |
| 데몬 | Pi Desktop과 **같은 Host Agent 코드, 다른 데몬 홈**(`~/.pi-desktop-agent`). 두 앱이 서로의 데몬을 교체하지 않게 한다 |
| 제품 이름 | Pi Desktop Agent (`@pi-desktop/agent`). 단, Host Agent 실행 파일 이름이 이미 `pi-desktop-agent`이므로 문서·로그에서는 "에이전트 앱"과 "Host Agent"를 구분해 쓴다 |
| Pi 관리 | 에이전트 앱은 Pi 설치·업데이트·로그인·프로바이더·모델 관리 화면을 두지 않는다. **Pi Desktop이 맡는다** (Mate와 같은 방식). 에이전트는 데몬의 `pi.status`·`pi.models`로 상태를 보여 주고, 문제가 있으면 Pi Desktop을 열거나 Latest 릴리스에서 설치하게 안내한다. 대화 화면에서 바꾸는 모델은 그 대화(세션)에만 적용된다 |
| Pi Desktop Mate와의 분리 | 같은 저장소의 다른 앱(`apps/mate`, `packages/mate-*`, 별도 세션에서 진행). 폴더·데이터 홈(`~/.pi-desktop-mate`)·개발 포트(Mate 18913, Agent 18912)·태그(`mate-v*`)가 모두 다르다. Agent 작업은 Mate 파일을 고치지 않는다 |
| Pi Desktop과의 분리 | `apps/desktop`은 고치지 않는다 (루트 README는 세 앱 공통 안내라, 앱 구성이 바뀔 때만 고친다). 겹치는 파일은 `package-lock.json`뿐이다. 작업은 별도 worktree(`../pi-desktop-agent`)의 `feat/agent-*` 브랜치에서 한다 |
| 릴리스 | **이 저장소(pi-desktop)의 GitHub Releases**에 올린다. Pi Desktop의 `v*`, Pi Desktop Mate의 `mate-v*`와 섞지 않고 `agent-v*` 태그와 별도 워크플로(`.github/workflows/release-agent.yml`)를 쓴다. Agent 릴리스는 **Latest로 표시하지 않는다** (Pi Desktop 자동 업데이트가 Latest 릴리스의 latest.yml을 보기 때문). **자동 업데이트(v0.1.2~)**: 앱이 릴리스 목록에서 가장 높은 `agent-v*`를 찾아 그 릴리스의 내려받기 주소를 generic 방식으로 쓴다 (Mate와 같은 방식). 릴리스에 latest.yml·latest-linux.yml·blockmap을 함께 올린다. Windows·AppImage는 내려받아 설치, 서명 없는 macOS·deb는 알리기만 |
| 기존 desktop-agent | 자동 업데이트로 배포된 상태라 그 저장소에서 갈아엎지 않는다. 기능 목록과 설계 근거를 참고하는 용도로만 남긴다 |

## 1. 핵심 원칙

| 원칙 | 의미 |
|---|---|
| **Zero-fork** | Pi 소스를 수정하지 않는다. 확장 API, RPC, 설정 파일만 쓴다 (DESIGN.md §1) |
| **Pi 형식 그대로, 데이터는 따로** | 세션 JSONL·스킬·`AGENTS.md`·`mcp.json`은 Pi 형식 그대로 쓰되, Pi 기본 폴더가 아니라 앱 홈(`~/.pi-desktop-agent`)에 둔다. Pi Desktop·터미널 `pi`의 세션·스킬·확장이 끼어들지 않는다. 로그인·모델·설정만 Pi와 함께 쓴다 (DESIGN-APPS.md §2) |
| **기능은 확장으로, 어디서나 동작** | `agent-kit`의 확장은 `ctx.ui`로만 사용자와 대화한다. 앱 전용 경로(풍부한 승인 화면 등)는 있으면 쓰고, 없으면 `ctx.ui`로 대체한다. 그래서 터미널 `pi`에 설치해도 동작한다 |
| **사람이 없으면 안전한 쪽으로** | `ctx.hasUI`가 false인 실행(예약 작업, 피어 요청)에서는 승인이 필요한 도구를 거부한다 |
| **승인은 동의 절차이지 보안 경계가 아니다** | Pi security.md가 밝히듯 확장 hook은 경계가 아니다. 강한 격리는 샌드박스 옵션으로 따로 제공한다 |

Pi와 의도적으로 다른 점은 하나다. Pi는 기본적으로 도구 실행 전에 묻지 않지만, 이 앱은 **승인 확장을 기본으로 켠다.**
이것도 Pi가 열어 둔 `tool_call` hook으로 구현하므로 Zero-fork 원칙과 충돌하지 않는다.

## 2. 구조

```
┌ apps/agent (Electron) ─────────────────────────────────────────────┐
│ Renderer: 채팅(Pi 세션 이벤트) · 승인 모달 · 기억 · 스케줄 · 작업     │
│   └ Pi Desktop의 chat-state·ChatView·ToolCards·ExtensionUi 재사용    │
│ Main: HostConnection(로컬) · agent-kit 경로 결정 · IPC                │
│   └ Pi Desktop의 host-connection·node-runtime·agent-build 재사용     │
└──────────────┬─────────────────────────────────────────────────────┘
               │ stdio JSON-RPC (packages/host-protocol)
┌──────────────▼──────────── host-agent connect → host-agentd ────────┐
│ PI_DESKTOP_HOME=~/.pi-desktop-agent  (Pi Desktop 데몬과 분리)         │
│   ├ pi --mode rpc -e <agent-kit 확장들>   (세션 A)                    │
│   └ pi --mode rpc -e <agent-kit 확장들>   (세션 B, 워커 …)            │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.1 agent-kit을 불러오는 방법

DESIGN.md §5.3의 bridge 확장과 같은 방식이다. 세션을 열 때 `session.open`의 `piArgs`에 `-e <확장 파일>`을 넣는다.
사용자 `settings.json`의 `packages`에는 기록하지 않는다. 그래서

- 에이전트 앱에서 연 세션에만 agent-kit이 올라가고, 터미널 `pi`나 Pi Desktop의 세션에는 영향이 없다.
- 터미널에서도 쓰고 싶으면 사용자가 직접 `pi install`로 설치하면 된다 (`package.json`의 `pi.extensions`가 그대로 쓰인다).

앱은 확장 목록을 `agent-kit/package.json`의 `pi.extensions`에서 읽어 확장마다 `-e`를 붙인다.
보내기 전에 `get_commands`에 `agent:status`가 있는지로 agent-kit이 실제로 올라갔는지 확인한다.

### 2.2 데몬 홈을 나누는 이유

Host Agent 연결기는 떠 있는 데몬의 빌드 식별자가 자기 번들과 다르면, 세션이 없을 때 데몬을 교체한다(agent-build.ts).
두 앱이 따로 배포되면 번들이 달라지므로 같은 데몬을 쓰면 서로 교체하려 든다.
에이전트 앱은 연결기 환경에 `PI_DESKTOP_HOME`을 주어 데몬·소켓·저널을 따로 쓴다.
Pi 설치본·로그인·모델·설정(`~/.pi/agent`)은 함께 쓰고, 세션·스킬·프롬프트·확장·MCP·`AGENTS.md`는 앱 홈에 둔다. Pi를 띄울 때 `--session-dir`·`-ns --skill`·`-np --prompt-template`·`-ne -e`·`-nc`로 들어오는 길을 바꾼다 (DESIGN-APPS.md §3.1).

### 2.3 재사용 경계

| 가져다 쓰는 것 | 위치 | 방식 |
|---|---|---|
| Host Agent 데몬·연결기 | `packages/host-agent` | 빌드 결과(`dist/host-agent.mjs`)를 그대로 실행 |
| 앱 ↔ 데몬 메시지 | `packages/host-protocol` | 워크스페이스 패키지 |
| 연결 관리, Node 런타임 찾기, 빌드 식별자 | `apps/desktop/src/main` | **복사** (`apps/agent/src/vendor/main`) |
| 채팅 상태·화면, 도구 카드, 확장 UI | `apps/desktop/src/renderer` | **복사** (`apps/agent/src/vendor/renderer`) |

P0는 `@desktop` 별칭으로 Pi Desktop 소스를 직접 가져다 썼다. 처음에는 P1에서 공용 패키지(`packages/desktop-core`·`chat-ui`)로
옮길 계획이었지만, 그러려면 Pi Desktop을 고쳐야 해서 "Pi Desktop은 건드리지 않는다"(§0)와 맞지 않는다.
직접 import를 그대로 두면 Pi Desktop을 고칠 때 에이전트 빌드와 Pi Desktop PR의 CI가 함께 깨진다.
그래서 **P1에서 복사로 바꿨다** (v0.2). 출처 커밋과 다시 가져오는 규칙은 `apps/agent/src/vendor/README.md`에 있다.

## 3. 데이터 위치

| 무엇 | 어디 | 비고 |
|---|---|---|
| 로그인·모델·설정·신뢰 | `~/.pi/agent/` | Pi Desktop·터미널 `pi`와 함께 씀 (Pi Desktop이 관리) |
| 세션 | `~/.pi-desktop-agent/sessions/` | Pi 형식 그대로. Pi Desktop·터미널 `pi`와 섞이지 않음 |
| 스킬·프롬프트·`AGENTS.md`·`mcp.json` | `~/.pi-desktop-agent/` | Pi 형식 그대로. MCP는 agent-kit의 MCP 확장이 읽음 (DESIGN-APPS.md §3.1) |
| agent-kit 상태 (승인 정책, 감사 로그, 기억, 스케줄, 피어, 사용량) | `~/.pi-desktop-agent/data/` | 확장이 쓰는 파일. 사람이 읽고 고칠 수 있는 JSON·JSONL·Markdown. 예전 위치(`~/.pi/agent/pi-desktop-agent/`)는 읽지 않는다 |
| 휴지통·아카이브 | `~/.pi-desktop-agent/session-trash/`, `archive.json` | 데몬이 맡음 |
| 세션 안의 확장 상태 | 세션 JSONL의 `custom` 엔트리 | LLM에 보이지 않음 (예: 이 세션 한정 승인) |
| 모델이 알아야 하는 주입 내용 | 세션 JSONL의 `custom_message` 엔트리 | 예: 작업 완료 알림, 피어 응답 |
| 데몬·저널 | `~/.pi-desktop-agent/` | Host Agent 런타임 파일 |
| 창 배치 등 앱 전용 상태 | Electron `userData` | DESIGN.md §1과 같은 규칙 |

API 키는 Pi의 방식(`auth.json`, 환경 변수, `models.json`의 `$ENV` 참조)을 따른다.
API 키·프로바이더 로그인은 **Pi Desktop**에서 넣는다 (Pi 설정의 auth.json). 에이전트는 따로 키를 받지 않는다. (P3-④에서 만든 OS 키체인 보관은 키 관리를 Pi Desktop 한 곳으로 모으면서 v0.1.2에서 없앴다.)

## 4. 기능 배치

desktop-agent에 있던 기능을 Pi의 어느 부분으로 옮길지 정한다.

| 기능 | 위치 | 구현 |
|---|---|---|
| 파일 읽기·쓰기, 셸 | **Pi 기본 도구** | `read`/`write`/`edit`/`grep`/`find`/`ls`/`bash`, Windows는 `powershell`도 |
| 승인 게이트, 정책, 감사, 위험 명령 차단 | 확장 `permissions` | `tool_call`에서 block. 앱이 있으면 풍부한 승인 화면, 없으면 `ctx.ui.select`. `hasUI` false면 거부 |
| 권한 상승 | 확장 `elevation` + `permissions` | 도구 `shell_exec_elevated`(desktop-agent DESIGN-PRIVILEGE-ELEVATION.md를 옮김). 자유 문자열이 아니라 작업(op: package_install·remove·update, service, copy_file, raw argv)을 받아 플랫폼별 argv로 바꾸고(`compile.ts`), 셸 없이 OS 상승 경로(Linux pkexec, macOS Authorization Services, Windows UAC `Start-Process -Verb RunAs`)로 한 번 실행한다. 비밀번호는 OS 창만 받는다. 기본 꺼짐(`pi-desktop-agent/elevation.json`, 앱 설정에서 켬), 켜도 사람이 지켜보는 대화에서만 `setActiveTools`로 모델에게 보이고 워커·예약에는 보이지 않는다. 승인은 실행될 argv 그대로 "이번만 허용·거부"로만 묻고 규칙·세션 허용을 쓰지 않는다. argv 안의 sudo·runas 등과 잘못된 이름·상대 경로는 묻지 않고 막는다. bash의 sudo는 계속 막고 이 도구를 안내한다 |
| 웹 페이지 읽기, 웹 검색 | 확장 `web` + **Pi 기본**(MCP) | `web_fetch`(주소 하나의 본문을 글로)만 만든다. 검색은 Pi 방식대로 검색 MCP 서버(`mcp.json`)에 맡긴다. `web_fetch`는 주소에 데이터를 실어 내보낼 수 있어 "네트워크" 승인(사이트 단위 패턴) |
| 웹 검색·MCP 설정 화면 | 앱 | Pi의 사용자 MCP 설정(`<Pi 설정 폴더>/mcp.json`)을 고친다. 미리 정한 웹 검색 서버: Exa(원격 `https://mcp.exa.ai/mcp`, 키 없음), Brave(`npx -y @brave/brave-search-mcp-server`, `BRAVE_API_KEY`), Tavily(`npx -y tavily-mcp`, `TAVILY_API_KEY`). 키는 그 서버의 `env`에 넣고 화면으로 다시 보내지 않는다. 켜고 끄기는 `enabled`만, 빼기는 그 서버만 바꾸고 모르는 칸은 둔다. 깨진 파일은 덮어쓰지 않는다. 연결 확인은 `pi mcp list`(세션 없이). 바꾼 설정은 새 대화부터 적용 |
| 메인/워커 분리, 작업 위임 | 확장 `tasks` | 워커는 확장이 띄우는 자식 `pi --mode rpc`(같은 모델·`-e` 확장·환경). 워커의 다이얼로그는 부모 `ctx.ui`로 넘기고, 완료는 `[작업 알림]` custom message + `triggerTurn`으로 주입 |
| 예약·주기 작업 | 확장 `schedule` + 데몬의 상주 세션 | Host Agent(Pi Desktop과 공유)는 고치지 않는다. 대신 앱이 데몬에 **스케줄러 세션** 하나를 띄워 두고, 그 세션의 확장이 타이머를 돌려 도래한 예약을 "사람 없는" 워커로 실행한다. 데몬은 돌고 있는 세션이 있으면 꺼지지 않으므로 앱을 닫아도 돈다 (PC를 다시 켜면 앱을 한 번 열어야 다시 돈다) |
| 지식베이스 (회상·추출·교훈) | 확장 `memory` + 앱 | desktop-agent의 지식베이스를 옮겼다. 항목 하나 = `pi-desktop-agent/memory/<id>.md`(frontmatter: type·title·tags·pinned·status·origin·unverified·created·updated·reviewed·source, 본문 Markdown). 종류는 사용자(user)·요구사항(requirement)·교훈(lesson)·참조(reference). 예전 형식(kind·한 줄)은 읽을 때 바꿔 읽는다(preference→고정 user, fact→user). 회상(`before_agent_start`): 전체 목록 한 줄씩 + 고정 항목 본문 + 요청과 관련된 항목 본문(2-gram, 제목·태그 가중), 예산은 클라우드 8,000자·로컬 창의 10%. 회상 횟수는 `recall-stats.json`에 따로 둔다. 도구: `memory_save`(같은 제목이면 고침)·`memory_read`·`memory_search`·`memory_forget`(보관), 모두 승인 없이 하고 알린다. 턴 뒤 추출은 같은 형식으로 남기고, 도구로 확인한 것이 없는 대화에서 나온 항목에 "확인 안 됨"을 붙인다. 앱의 지식베이스 화면: 목록(찾기·종류·태그·보관함), 고치기, 일괄(보관·되살리기·고정·태그·합치기·지우기→forgotten/), 점검 대기함(중복 의심·30일 안 쓰임·재발 방지 없는 교훈·확인 안 됨, 합치기·확인함), 통계·주입 미리보기, Markdown 내보내기. 피어 답변·카드 초안에는 user 항목과 `공유제외` 태그를 쓰지 않는다 |
| 사용자 지침·선호 | **Pi 기본** | `AGENTS.md` |
| 스킬, MCP | **Pi 기본** | `skills/`, `mcp.json` |
| 스킬 화면·저장 | 확장 `skills` + 앱 | Pi 스킬 형식(`<Pi 설정 폴더>/skills/<이름>/SKILL.md`, frontmatter name·description·disable-model-invocation) 그대로. 앱의 스킬 화면에서 보고·만들고·고치고(이름 바꾸면 폴더째)·지운다(agent-kit 상태 폴더 `skills-trash/`로). `~/.agents/skills`는 보기만. "대화에서 쓰기"는 입력창에 `/skill:이름 `을 채운다. 대화에서는 `skill_save`(쓰기 승인, 사용자 스킬 폴더 단위로 계속 허용 가능, 같은 이름은 replace일 때만)로 저장한다. desktop-agent의 "반복 실행을 보고 자동으로 스킬 만들기"는 옮기지 않았다 |
| 큰 입력 처리 | 확장 `documents` | 원문은 파일로, `read`의 offset/limit로 읽기. 분할 요약·번역은 워커 세션 |
| 첨부 (문서·PDF·이미지) | 앱 + 확장 `documents` | 문서는 내용 대신 `[첨부] 경로`를 메시지에 적고, 모델이 read(텍스트)나 `process_document`(.docx·.pdf·큰 문서)로 읽는다. PDF는 의존성 없이 `node:zlib`로 읽는다(`documents/pdf.ts`: FlateDecode·객체 스트림·페이지 트리·상속 Resources·ToUnicode CMap. 암호화·스캔 이미지·Form XObject 안 글은 못 읽고 이유를 알린다). 이미지(png·jpeg·gif·webp, 5MB까지)는 모델이 이미지를 받으면(`model.input`) RPC `prompt`의 `images`로 함께 보내고, 받지 못하면 경로로 둔다. 입력창에 붙여 넣은 이미지(화면 캡처)도 같다 |
| 되묻기 | 확장 `ask-user` | `ask_user` 도구. 선택지가 있으면 `ctx.ui.select`(+"직접 입력"), 없으면 `input`. 바깥을 바꾸지 않아 승인 없이, 사람이 없으면 묻지 못한다고 돌려준다 |
| 로컬 모델 대응 | 확장 `local-model` + `models.json` | 도구 결과 축소(`tool_result`), 서버 창 크기·사고 지원 실측, 사고 끄기(`reasoning_effort: "none"`), 압축 설정(`compaction.modelOverrides`)을 창에 맞게. 도구 줄이기는 하지 않는다 — Pi 기본 도구가 4개뿐이라 desktop-agent처럼 정의만으로 창을 먹지 않는다 |
| 반복·제자리 돌기 차단 | 확장 `loop-guard` (+ `permissions`) | `tool_call`에서 같은 조회 반복 차단, `turn_end`에서 문단 반복 감지, 신호가 쌓이면 멈춤. 거부한 호출의 반복은 `permissions`가 다시 묻지 않고 거부 |
| 에이전트 네트워크(A2A) | 확장 `peers` + 스케줄러 세션 + 앱 | desktop-agent DESIGN-AGENT-NETWORK.md의 N1~N3(카드·페어링·질문)을 옮겼다. 지식은 옮기지 않고 답만 준다. **수신 서버는 스케줄러 세션**(데몬에 늘 떠 있는 Pi)이 `peers/settings.json`을 30초마다 읽어 켜고 끈다(기본 꺼짐, 포트 7811, 앱을 닫아도 데몬이 떠 있으면 받음). A2A 모양: 카드 `GET /.well-known/agent-card.json`(인증 없음), 질문 `POST /a2a` `message/send`(피어 토큰). 페어링은 이 앱의 확장: `POST /pair`로 요청이 쌓이고 사람이 앱에서 승인하면 토큰을 발급, 요청자는 `/pair/status`로 결과를 가져가 양쪽이 서로의 토큰을 갖는다. 질문은 피어 정책(받기·하루 상한)과 홉 상한(2, 순환 금지)을 지나 **도구 없는 워커**(`--no-tools`, 선호 기억 제외, 개인정보·파일·자격증명을 답하지 말라는 지시)가 답한다. 대화에는 `list_peers`(묻지 않음)·`ask_peer`("피어에게 묻기" 승인, 피어 단위로 계속 허용 가능)와 피어 요약 섹션을 준다. 중계 서버(N5)는 아직. 카드 초안: 네트워크 화면의 "기억으로 초안 만들기"가 사실·교훈 기억과 사용자가 붙인 대화 이름(내용은 안 씀)을 stdin으로 넘겨 Pi를 한 번 부르고(`--print --no-tools --no-extensions --no-skills --no-context-files`) 소개·잘하는 것 초안을 채운다. 공개되는 글이라 저장은 사람이 확인한 뒤에만, 선호 기억·키처럼 보이는 글은 재료와 결과에서 뺀다 |
| 피어 작업 맡기기 (N4) | 확장 `peers` + `permissions` + 스케줄러 세션 + 앱 | `delegate_to_peer`("피어에게 작업 맡기기" 승인, 제목·지시를 그대로 보임)가 `message/send`(taskType task)로 보낸다. 받는 쪽은 `tasks/<id>.json`에 origin `peer-in`·status `waiting`·approval `pending`으로 쌓기만 하고 OS 알림을 띄운다. 사람이 네트워크 화면에서 **폴더를 골라 승인**해야 스케줄러 세션이 그 폴더에 갇힌 무인 워커로 돌린다: `PI_DESKTOP_AGENT_CONFINE`이면 permissions가 경로 도구(read·grep·find·ls·write·edit·process_document)를 폴더 밖이면 막고(읽기도, 읽은 것이 상대에게 가므로), 폴더 안 쓰기는 묻지 않고 허용하며, 기억 바꾸기를 막는다. 실행·네트워크·MCP는 무인 실행이라 거부, 선호 기억은 안 실린다. 맡긴 쪽은 origin `peer-out` 기록에 상대 작업 id를 두고 `tasks/get`으로 상태·결과를 가져온다(대화가 15초마다 확인해 끝나면 `[작업 알림]`으로 한 턴, 스케줄러도 30초마다 기록을 맞춤). `cancel_task`는 원격 작업에 `tasks/cancel`을 보낸다. 피어 정책에 `task: ask|deny`, 하루 상한은 질문과 함께 센다. 구현 메모: 도구 실행 중에 건 `setInterval`은 Pi RPC에서 돌지 않아 `session_start`에서 건다 |
| 작업 폴더 | 앱 | 대화 하나 = Pi 세션 하나이고, 작업 폴더(cwd)는 세션마다 고정이다(상대 경로·`AGENTS.md`·`.pi/`·세션 저장 위치가 모두 이것을 따른다). 새 대화는 마지막 폴더 또는 최근 폴더 6개·홈·다른 폴더 중에서 고른다. **대화 중 폴더를 바꾸면** 지금 세션 파일에서 분기(`pi --fork`)한 새 세션을 그 폴더에서 열어 지금까지의 대화를 이어 가고, 원래 대화는 남는다(빈 대화는 분기하지 않고 새로 연 뒤 닫는다). 사이드바는 폴더별로 묶는다 |
| 지난 대화 | **Pi 기본** + 앱 | 목록은 데몬의 `session.history`(Pi SDK의 세션 목록, 스케줄러 세션 제외). 이름·첫 메시지·폴더는 화면에서 바로 거르고, 본문 검색은 앱이 세션 파일의 사용자·에이전트 글(도구 결과·사고 제외)을 읽어 모든 낱말이 든 것을 찾는다(색인 없음). 누르면 `session.open`의 `sessionFile`로 그 파일을 이어서 연다. 이미 열린 대화면 새로 열지 않고 그 대화로 간다. 세션 폴더는 Pi Desktop·TUI와 같이 써서 그쪽 대화도 보인다. 다른 앱이 지금 쓰고 있는 세션을 함께 이어 쓰면 기록이 섞일 수 있다(같은 데몬 안에서만 막는다) |
| 사용량 | **Pi 기본** + 앱 | 세션 파일의 assistant `usage`를 읽어 집계한다(따로 모으지 않음, Pi Desktop·TUI 대화도 같은 세션 폴더라 함께 셈). 세션에 남지 않는 호출(턴 뒤 기억 추출, 문서 조각 처리, `--no-session` 워커)만 `pi-desktop-agent/usage.jsonl`에 한 줄씩 적는다. 화면은 오늘(시간별)·7일·30일(일별)·12개월(월별)로 토큰·비용·호출 수와 모델별·쓰임새별 표를 보인다. 고친 때가 기간보다 이른 세션 파일은 열지 않는다 |

## 5. 단계

| 단계 | 범위 | 완료 기준 |
|---|---|---|
| **P0 골격** | `agent-kit` 패키지와 `agent-core` 확장(`/agent:status`), `apps/agent`가 분리된 데몬에 붙어 agent-kit을 올린 로컬 세션으로 채팅, 확장 다이얼로그 응답, mock LLM 개발 실행 | `npm run dev:mock -w @pi-desktop/agent`로 대화하고, 실제 Pi 계약 테스트로 agent-kit이 올라가는 것을 확인 |
| | **구현 메모 (P0 완료)**: 실제 Pi 1.3.0 계약 테스트(`packages/agent-kit/test/real-pi.test.ts`)와 dev:mock 앱에서 데몬 연결 → agent-kit 확인 → `/agent:status` 알림 → 스트리밍 응답 → read 도구 카드까지 확인. 프로젝트 신뢰는 묻지 않으므로(RPC) 처음 연 폴더의 `.pi/` 리소스는 건너뛴다. 설치본 묶음(extraResources의 agent-kit·host-agent)은 아직 없음 | |
| **P1 승인** | `permissions` 확장, 앱 승인 화면, Pi Desktop 모듈 복사(§2.3) | 승인 없이는 쓰기·실행이 일어나지 않는다 |
| | **구현 메모 (P1 완료)**: 읽기 도구(read·grep·find·ls)는 묻지 않고, 쓰기(write·edit)·실행(bash·powershell·모르는 도구)은 `ctx.ui.select`로 묻는다. 선택지는 이번만·이 세션에서 계속·항상(규칙 저장)·거부이고, 취소와 시간 초과는 거부다. 위험 명령과 권한 상승은 묻지 않고 막는다. 규칙은 `permissions.json`, 판단은 `audit.jsonl`. 앱은 select 제목의 승인 형식(`agent-kit/approval`)을 읽어 전용 화면을 띄운다. 실제 Pi 계약 테스트(`permissions-real-pi.test.ts`)와 dev:mock 앱에서 허용·거부 흐름을 확인 | |
| **P2 로컬 모델** | `local-model`, `loop-guard`, 압축 설정 | qwen3.5:9b로 desktop-agent와 같은 시나리오 비교 |
| | **구현 메모 (P2, 실측 전)**: loop-guard는 실행 단위로 같은 읽기 조회(성공한 것만, 쓰기·실행 성공 시 잊음)와 30자 이상 문단 반복을 세고, 3번 쌓이면 남은 호출을 terminate로 막은 뒤 알리고 멈춘다. permissions는 같은 실행에서 거부한 호출을 다시 묻지 않는다(repeat-deny). local-model은 첫 요청 때 Ollama `/api/ps`·`/api/show`로 실제 창·사고 지원을 묻고 설정과 다르면 알린다. 결과는 창의 1/4(토큰당 3글자 어림)을 넘으면 앞부분만 보내고, read는 범위를 좁혀 다시 읽게, 그 밖은 전문을 `pi-desktop-agent/outputs/`에 남긴다. `/agent:local-setup`은 확인 뒤 창의 25%·35%를 reserve·keepRecent로 저장한다. Ollama를 흉내 낸 스크립트 LLM으로 계약 테스트를 했고, **이 개발 PC에는 Ollama가 없어 qwen3.5:9b 실측은 아직이다** (아래 절차) | |
| **P3 기본 기능** | `memory`, `documents`, `attachments`, `ask-user`, `web`, 키체인 연동 | PR을 기능 단위로 나눈다: ① ask-user·web ② memory ③ documents·attachments ④ 키체인 |
| | **구현 메모 (P3-①)**: `ask_user`·`web_fetch` 도구와 승인 위험도 "네트워크"를 추가. 실제 Pi 계약 테스트로 선택지·직접 입력·네트워크 승인·본문 추출·HTTP 오류를 확인 | |
| | **구현 메모 (P3-②, 지식베이스로 바뀌기 전)**: 기억 하나 = `pi-desktop-agent/memory/<id>.md`(frontmatter `kind`·`created`). SQLite·벡터 대신 사람이 고칠 수 있는 파일. 매 요청 전 `before_agent_start`에서 선호는 늘, 사실·교훈은 요청과 글자 2-gram이 겹치는 것만 골라 `agent_memory` 섹션으로 싣는다(Pi가 시스템 메시지 하나를 고쳐 보내므로 대화에 쌓이지 않음). 로컬 모델은 창의 10%만. 도구 `memory_save`·`memory_forget`(승인 없이, 할 때마다 알림), 명령 `/agent:remember`·`/agent:memories`. 잊은 기억은 `forgotten/`으로 옮겨 되돌릴 수 있다. desktop-agent의 "턴 뒤 LLM으로 기억 뽑기"와 실패 교훈 자동 기록은 아직 옮기지 않았다 → 아래 메모에서 옮김 | |
| | **구현 메모 (턴 뒤 기억 추출)**: `agent_end`의 메시지를 받아 두었다가 `agent_settled`(중단 아님)에서 대화 기록·실패 신호(실패한 도구 결과, 승인 거부)로 정리하고, 지금 모델(`ctx.modelRegistry.complete`)에 기존 기억 목록과 함께 보내 `{"ops":[create·update·forget]}`를 받는다. 기다리지 않고 한 번에 하나씩 돌리며, 저장·고침·지움마다 알린다. 관찰 도구(read·grep·find·ls·bash·web_fetch 등)가 하나도 성공하지 않은 실행은 "사용자가 직접 말한 것만" 규칙을 덧붙인다. 사고 블록·코드 펜스·끊긴 JSON을 관대하게 읽고, 모르는 id와 키·토큰처럼 보이는 글은 버린다. JSON이 아예 없는 답은 "저장할 것 없음"으로 본다. 자동 기억은 frontmatter `source: auto`, 고치면 `updated`. 워커·예약·중단 실행에서는 뽑지 않고, 기억 화면의 체크(`memory/settings.json`의 `autoLearn`)나 `PI_DESKTOP_AGENT_LEARN=0`으로 끈다 | |
| | **구현 메모 (P3-③)**: `process_document`는 창의 30%(토큰당 2글자) 크기로 문단 경계에서 나눠 조각마다 `ctx.modelRegistry.complete`로 지금 모델을 부른다. transform(번역·교정)은 결과를 `<이름>.result.md`(또는 output)로 쓰고 그 경로로 "쓰기" 승인, reduce(요약·질문)는 조각별로 뽑아 한 번 더 모아 답하며 묻지 않는다. .docx는 의존성 없이 zip에서 `word/document.xml`만 풀어 본문을 뽑는다(PDF는 아직). 앱의 "파일 첨부"는 내용 대신 `[첨부] <경로>`를 메시지에 싣는다. 조각 처리 요청에는 local-model의 사고 끄기가 적용되지 않는다 | |
| | **구현 메모 (P3-④)**: 앱의 `KeyStore`(safeStorage 암호화)와 "API 키" 화면을 만들었으나, v0.1.2에서 키 관리를 Pi Desktop으로 모으며 없앴다(§3) | |
| **P4 백그라운드** | `tasks`(워커 세션), 스케줄러, 알림 | 앱을 닫아도 예약 작업이 돈다. PR을 나눈다: ① tasks ② 스케줄러 ③ 앱 작업 목록·알림 |
| | **구현 메모 (P4-①)**: `delegate_task`·`list_tasks`·`cancel_task`. 워커는 자식 Pi(`process.argv`의 cli와 `-e`를 물려받음, `PI_DESKTOP_AGENT_WORKER=1`이라 위임 도구 없음). 승인 제목 첫 줄 끝에 `(작업 <id>)`. 동시 2개, 결과는 대화에 4000자까지(전문은 `tasks/<id>.json`). RPC는 `hasUI`가 늘 true라 사람이 없는 실행은 `PI_DESKTOP_AGENT_UNATTENDED=1`로 알리고 permissions·ask_user가 따른다 | |
| | **구현 메모 (P4-②)**: 앱이 데몬에 붙을 때마다 `<데몬 홈>/scheduler` 폴더의 세션이 돌고 있는지 보고 없으면 `PI_DESKTOP_AGENT_SCHEDULER=1`로 연다. 그 세션의 schedule 확장이 30초마다 `schedules.json`을 보고 도래한 예약(놓친 것은 한 번)을 사람 없는 워커로 돌려 `tasks/<id>.json`에 남긴다. 대화 세션의 `schedule_task`는 "쓰기"로 승인. dev:mock 앱으로 앱 창을 모두 닫은 뒤에도 예약이 도는 것을 확인했다. PC를 다시 켜면 데몬이 없으므로 앱을 한 번 열어야 다시 돈다(OS 스케줄러 연동은 하지 않음) | |
| | **알림 (대화)**: 창을 보고 있지 않으면 대화의 소식을 OS 알림으로 띄운다 (`main/session-notify.ts`). 답이 끝남(`agent_settled`), 승인 요청(`[승인 요청]` select), 답을 기다리는 대화상자(select·confirm·input·editor). 제목에 대화 폴더 이름. 예약을 돌리는 스케줄러 세션은 작업 알림이 맡으므로 알리지 않는다. 누르면 창을 앞으로 가져온다 | |
| | **구현 메모 (P4-③)**: 앱 메인의 `TaskWatcher`가 `tasks/`를 5초마다 읽어 새로 끝난 작업을 Electron Notification으로 알린다(창을 보고 있으면 생략, 앱을 켤 때 이미 끝난 것은 알리지 않음). "작업" 화면에서 예약 켜기·끄기·지우기와 최근 작업 결과를 본다. 로컬 호스트만 지원(앱이 상태 폴더를 직접 읽음). P4 완료 | |
| P5 확장 | `peers`/네트워크, 권한 상승, 배포 설정 | |
| | **구현 메모 (P5 진행 중)**: 네트워크(카드·페어링·질문 N1~N3, 피어 작업 맡기기 N4)와 권한 상승은 §4 표에 적은 대로 들어갔다. 중계 서버(N5)는 보류하고 설계만 남겼다(§8) | |

## 6. 리스크

| 리스크 | 대응 |
|---|---|
| Pi 변경이 빠름 (1.x에서 주 2회 수준 릴리스) | 저장소의 Pi devDependency로 계약 테스트. agent-kit이 쓰는 이벤트만 검사한다 |
| RPC 확장 UI의 표현력이 낮음 (문자열 선택지 수준) | P1은 승인 정보를 select 제목에 정해진 형식으로 싣고, agent-kit의 같은 함수로 만들고 읽는다. 터미널 pi에서도 그대로 읽힌다. 더 많은 정보가 필요해지면 앱 전용 경로를 검토 |
| 복사한 Pi Desktop 모듈이 원본과 멀어짐 | 되도록 고치지 않고, 고친 곳에는 `// agent:` 주석. 다시 가져올 때 출처 커밋을 갱신 (vendor/README.md) |
| Windows 셸 | Pi 기본 `bash`는 Git Bash가 필요하다. `powershell` 도구를 기본으로 켤지는 실측 때 함께 본다 (P2에서는 바꾸지 않음) |
| 9B 로컬 모델의 지시 따르기 | 엔진을 바꿔도 해결되지 않는다. `loop-guard`처럼 코드로 강제하는 장치를 유지하고, 아래 절차로 측정한다 |

## 7. 로컬 모델 실측 절차 (P2)

Ollama가 있는 PC에서 한다. desktop-agent 실측과 같은 조건(qwen3.5:9b, `OLLAMA_CONTEXT_LENGTH=8192`)으로 맞춘다.

1. `~/.pi/agent/models.json`에 Ollama를 등록한다. 사고 지원 모델이지만 `reasoning`은 두지 않는다(사고 수준 off → local-model이 사고를 끈다).
   ```json
   { "providers": { "ollama": { "baseUrl": "http://localhost:11434/v1", "api": "openai-completions", "apiKey": "ollama",
     "models": [{ "id": "qwen3.5:9b", "contextWindow": 8192 }] } } }
   ```
2. 에이전트 앱에서 이 모델로 세션을 열고 아무 말이나 보낸다. 경고가 뜨면 `/agent:local-setup`으로 압축 설정을 저장하고 새 세션을 연다.
3. desktop-agent에서 실패했던 시나리오를 그대로 돌린다: 디렉터리 목록에 답이 있는데 없는 경로를 다시 찾던 과제, 같은 문단을 되풀이하던 과제, 거부한 명령을 다시 시도하던 과제, 큰 파일 요약.
4. 볼 것: 감사 로그(`audit.jsonl`)의 repeat-deny, loop-guard 멈춤 알림 횟수, 답이 문장 중간에서 끊기는지, 압축이 매 턴 일어나지 않는지, 응답 시간.


## 8. 중계 서버 (N5, 보류 — 설계만)

지금 피어는 같은 네트워크(사내망·VPN)에서 `http://IP:7811`로 직접 닿는다. 다른 네트워크·NAT 너머의 에이전트끼리 연결하려면 중계 서버가 필요하다. 사용자 결정(2026-10-30)으로 구현은 미루고 설계만 남긴다. 그 전까지는 Tailscale 같은 VPN으로 같은 네트워크에 두는 것이 방법이다.

**목표**: 방화벽·NAT 뒤의 에이전트끼리 연결, TLS, 오프라인일 때 잠깐 쌓아 두기, 카드 디렉터리(찾기). 지금의 원칙(지식은 옮기지 않음, 양쪽 사람 승인, 받는 쪽 정책·폴더 가두기)은 그대로 둔다. 중계는 **봉투만 나른다**.

**구성**

| 부분 | 위치 | 하는 일 |
|---|---|---|
| 중계 서버 | 이 저장소의 별도 앱(예: `apps/relay`, Node 단일 프로세스) | 에이전트 등록, WebSocket 상시 연결, 메시지 전달, 오프라인 큐, 카드 디렉터리. TLS는 앞단 프록시(Caddy·nginx)나 클라우드 LB |
| 전송 추상화 | agent-kit `peers` | 지금의 HTTP 호출(`fetchCard`·`pair`·`a2a`)을 `PeerTransport` 뒤로 옮긴다. `DirectHttpTransport`(지금 것)와 `RelayTransport`(WebSocket) |
| 수신 | 스케줄러 세션 | 중계를 쓰면 포트를 열지 않고, 스케줄러가 중계에 바깥 방향 WebSocket을 유지하고 들어온 요청을 지금의 `peerRequestHandler`에 그대로 넘긴다 |

**주소와 신원**
- 피어 주소는 `relay://<중계 호스트>/<agentId>` 꼴이다. 피어 레코드에는 주소만 있으므로 상위 로직(정책·작업·승인)은 바뀌지 않는다.
- `agentId`는 에이전트가 처음 등록할 때 만든 키쌍(Ed25519)의 공개키 지문으로 한다. 중계는 등록 때 서명으로 소유를 확인하고, 그 뒤로는 연결마다 짧은 세션 토큰을 쓴다.
- 피어끼리의 토큰(지금의 `myToken`·`theirToken`)은 중계를 지나도 그대로 쓴다. 중계는 봉투의 대상만 보고 내용은 보지 않는 것이 목표다. 2단계에서 피어 공개키로 내용을 암호화(종단간)한다.

**메시지 흐름**
1. A의 스케줄러가 `wss://relay/agents/A`에 연결해 둔다. B도 같다.
2. A가 B에게 질문하면 `{ to: B, from: A, id, body: <지금의 JSON-RPC 본문> }` 봉투를 중계로 보낸다.
3. 중계는 B 연결이 있으면 바로 넘기고, 없으면 큐에 둔다(질문은 짧게 1분, 작업 요청은 길게 24시간).
4. B는 지금의 서버 처리기로 처리하고 같은 id로 답 봉투를 돌려보낸다.
5. 작업(N4)은 지금처럼 `tasks/get`으로 확인하므로 상태 알림을 따로 만들 필요가 없다. 나중에 중계가 상태 변화를 밀어 주게 바꿀 수 있다.

**카드 디렉터리**: 중계에 카드를 올릴지는 에이전트마다 고른다(기본 올리지 않음). 올리면 같은 중계를 쓰는 사람이 이름·잘하는 것으로 찾아 페어링을 요청할 수 있다. 페어링 승인은 지금과 같이 양쪽 사람이 한다.

**운영**: 사용자가 사내 서버나 클라우드에 직접 띄운다. 필요한 것은 도메인, TLS 인증서, 포트 하나(443). 중계 자체에는 대화 내용이 남지 않게 하고, 큐는 메모리(재시작하면 사라짐)로 시작한다. 등록 수·메시지 크기·속도에 상한을 둔다.

**단계 (구현할 때)**
1. `PeerTransport` 추상화로 지금 코드를 옮긴다 (동작 변화 없음)
2. 중계 서버 최소판: 등록·연결·전달 (큐·디렉터리 없음), `RelayTransport`
3. 오프라인 큐, 카드 디렉터리
4. 종단간 암호화
