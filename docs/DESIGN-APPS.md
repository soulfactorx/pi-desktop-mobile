# 세 앱의 역할과 데이터 경계 — 설계 문서 (v0.1)

> 관련 문서: [Pi Desktop 설계](DESIGN.md), [Pi Desktop Agent 설계](DESIGN-AGENT.md), [Pi Desktop Mate 설계](DESIGN-MATE.md), [Mate 원격 실행기](DESIGN-MATE-REMOTE.md), [개발 방식](CONTRIBUTING.md)

이 저장소의 세 앱은 같은 Pi를 엔진으로 쓰지만 하는 일이 다르다. 이 문서는 세 앱이 **무엇을 함께 쓰고 무엇을 나누는지**,
그리고 **어디서 도는지**를 정한다. 각 앱의 설계 문서가 이 문서와 어긋나면 이 문서를 따른다.

---

## 1. 역할

| 앱 | 컨셉 | 데이터의 성격 |
|---|---|---|
| **Pi Desktop** | **Pi를 GUI로 쓰는 앱.** 설치된 Pi를 그대로 보여 주고 다룬다 | 놀이터(playground). Pi의 기본 폴더를 그대로 쓰므로 터미널 `pi`와 같은 세션·스킬·설정을 본다 |
| **Pi Desktop Agent** | **혼자 독립적으로 쓰는 커스텀 Pi 하나.** Pi에 승인·기억·스킬·작업을 얹은 개인 에이전트 | 개인화된 데이터. Pi Desktop·터미널 `pi`와 섞이지 않는다 |
| **Pi Desktop Mate** | **개인화된 데이터를 능동적으로 처리하는 Pi 기반 비서.** 묻기 전에 살펴보고 알리고, 허락을 받아 처리한다 | 자기 데이터(임무·실행·대화·인박스). 사용자가 Pi로 한 일은 **읽기만** 한다 (§3.3) |

## 2. 원칙

1. **Pi 자체는 함께 쓴다.** 한 호스트의 Pi 설치본, 로그인(`auth.json`), 모델·프로바이더 설정(`models.json`, `settings.json`의 기본 모델 등), 프로젝트 신뢰(`trust.json`)는 세 앱이 같이 쓴다. 로그인과 모델 관리는 Pi Desktop이 맡는다. 한 번 로그인하면 세 앱 모두 쓴다.
2. **데이터는 함께 쓰지 않는다.** 세션, 스킬, 프롬프트, 확장, MCP 서버, 사용자 지침(`AGENTS.md`), 기억, 권한 규칙, 작업, 휴지통·아카이브는 앱마다 따로 둔다. 한 앱의 데이터가 다른 앱의 목록·문맥에 끼어들지 않는다.
3. **다른 앱의 데이터는 쓰지 않는다.** 읽는 경우는 Mate의 활동 관찰(§3.3) 하나뿐이고, 그것도 사용자가 켰을 때만 읽기만 한다.
4. **앱은 클라이언트다.** 실제로 도는 곳은 Pi가 설치된 호스트(로컬·WSL·SSH)다. 데이터도 그 호스트에 있다. 앱은 그 호스트의 데몬·실행기와 메시지만 주고받고, 호스트의 파일을 직접 읽지 않는다 (§4).

## 3. 데이터 위치 (호스트마다)

`~`는 Pi가 도는 호스트의 홈이다. 로컬이면 이 PC, WSL·SSH면 그 호스트다.

| 무엇 | Pi Desktop | Agent | Mate |
|---|---|---|---|
| Pi 설치본 | 함께 씀 | 함께 씀 | 함께 씀 |
| 로그인·모델·설정·신뢰 | `~/.pi/agent/` (함께 씀) | 같은 곳 | 같은 곳 |
| 세션(대화 기록) | `~/.pi/agent/sessions/` (Pi 기본, 터미널 `pi`와 같음) | `~/.pi-desktop-agent/sessions/` | `~/.pi-desktop-mate/sessions/`, `chat/sessions/` |
| 스킬·프롬프트 | `~/.pi/agent/skills`, `prompts` | `~/.pi-desktop-agent/skills`, `prompts` | `~/.pi-desktop-mate/skills`, `prompts` (임무마다 고름, §3.4) |
| 확장·Pi 패키지 | Pi 설정 그대로 (`settings.json`의 `packages` 포함) | agent-kit만 | mate-kit만 |
| MCP 서버 | `~/.pi/agent/mcp.json` | `~/.pi-desktop-agent/mcp.json` | `~/.pi-desktop-mate/mcp.json` (임무마다 고르고, 처음 쓰는 도구는 승인, §3.4) |
| 사용자 지침 `AGENTS.md` | `~/.pi/agent/AGENTS.md` | `~/.pi-desktop-agent/AGENTS.md` | 쓰지 않음 (임무 지시가 그 역할) |
| 작업 폴더의 `AGENTS.md`·`CLAUDE.md` | 읽음 | 읽음 | 읽음 (그 폴더의 것이지 앱의 것이 아님) |
| 앱 데이터 (기억·권한·작업·예약·피어·사용량 등) | `~/.pi-desktop/` | `~/.pi-desktop-agent/data/` | `~/.pi-desktop-mate/` |
| 휴지통 | `~/.pi-desktop/session-trash/` | `~/.pi-desktop-agent/session-trash/` | `~/.pi-desktop-mate/trash/` |
| 아카이브 | `~/.pi-desktop/archive.json` | `~/.pi-desktop-agent/archive.json` | `~/.pi-desktop-mate/archive.json` |
| 데몬·실행기 런타임 | `~/.pi-desktop/run/` | `~/.pi-desktop-agent/run/` | `~/.pi-desktop-mate/run/` |

### 3.1 Agent·Mate가 Pi를 띄우는 방법

Pi의 설정 폴더(`PI_CODING_AGENT_DIR`)는 바꾸지 않는다. 바꾸면 로그인·모델까지 갈라진다.
링크(심볼릭·하드)로 `auth.json`만 묶는 방법도 쓰지 않는다. Pi Desktop의 데몬이 임시 파일을 쓴 뒤 이름을 바꾸는 방식으로 저장하므로 링크가 끊어진다.
대신 Pi를 띄울 때 **데이터가 들어오는 길만 바꾼다** (Pi CLI 옵션, Pi docs/cli.md):

| 옵션 | 효과 |
|---|---|
| `--session-dir <앱 홈>/sessions` | 세션을 앱 폴더에 쓴다 |
| `-ns --skill <앱 홈>/skills` | Pi 기본 폴더·Pi 패키지의 스킬을 끄고 앱의 스킬만 올린다 |
| `-np --prompt-template <앱 홈>/prompts` | 프롬프트 템플릿도 같은 방식 |
| `-ne -e <kit 확장들> -e builtin:codemode -e builtin:tool-search` | Pi 기본·패키지 확장을 끄고 앱의 확장만 올린다. 내장 MCP(`builtin:mcp`)는 올리지 않는다 |
| `-nc` | Pi의 문맥 파일 찾기를 끈다. 사용자 수준 `~/.pi/agent/AGENTS.md`가 끼어들지 않게 하기 위해서다 |

- **MCP**: Pi의 내장 MCP는 Pi 설정 폴더의 `mcp.json`만 읽는다(`loadMcpConfig({ agentDir })`). 그래서 Agent와 Mate는 Pi SDK의 `createMcpExtension({ loadConfig, logPath })`로 **자기 `mcp.json`을 읽는 MCP 확장**을 쓴다. 두 앱이 같은 코드를 쓰므로 `packages/pi-isolation`에 두고, 앱이 kit 확장과 함께 `-e`로 올린다. 앱 홈은 `PI_ISOLATION_HOME`으로 알린다. 로그는 앱 홈의 `mcp.log`에 쓴다. 프로젝트의 `.pi/mcp.json`은 읽지 않는다.
  - **아직 남은 것**: OAuth로 로그인하는 MCP 서버의 자격 증명(`mcp-auth.json`)은 Pi 설정 폴더의 것을 쓴다. Pi SDK가 자격 증명 저장소(`McpOAuthCredentialStore`)를 공개하지 않아 위치를 바꿀 수 없다. 서버 이름·주소로 나뉘므로 다른 앱의 다른 서버와 섞이지는 않는다. Pi가 공개하면 앱 홈으로 옮긴다.
- **문맥 파일**: `-nc`로 끈 대신, pi-isolation의 확장이 Pi와 같은 규칙(작업 폴더에서 위로 올라가며 폴더마다 `AGENTS.override.md`·`AGENTS.md`·`CLAUDE.md` 중 하나)으로 작업 폴더의 파일을 찾고, 앱 홈의 `AGENTS.md`를 앞에 더해 Pi와 같은 자리(project_context)에 붙인다. Pi처럼 프로젝트 신뢰와 관계없이 읽는다 (Pi docs/configuration.md "Context-file discovery does not require project trust").
- **Pi Desktop**은 위 옵션을 쓰지 않는다. Pi를 있는 그대로 보여 주는 것이 컨셉이기 때문이다.

### 3.2 휴지통·아카이브

- **휴지통**: 지운 세션(Mate는 실행 기록·대화·임무)을 바로 지우지 않고 앱 홈의 휴지통으로 옮긴다. 원래 자리를 함께 적어 되살릴 수 있다. "비우기"를 해야 정말 지운다. 앱마다 따로다.
- **아카이브**: 파일은 그대로 두고 앱 목록에서만 숨긴다. 아카이브 화면에서 보고 되돌린다. Pi Desktop에서 아카이브해도 터미널 `pi`의 `/resume`에는 계속 보인다 (Pi의 파일을 옮기지 않으므로 분기·이어 열기가 깨지지 않는다).
- Pi Desktop·Agent는 데몬이 맡는다 (WSL·SSH에서도 같은 코드). Mate는 실행기가 맡는다.

### 3.3 Mate의 활동 관찰

사용자가 켰을 때만, 같은 호스트에서 **Pi Desktop·터미널 `pi`의 세션(`~/.pi/agent/sessions`)과 Agent의 세션(`~/.pi-desktop-agent/sessions`)을 읽기만** 한다.
요약(요청 앞부분, 고친 파일, 명령, 오류)만 Mate 홈에 남기고, 그 세션 파일을 옮기거나 고치지 않는다.

### 3.4 Mate의 스킬·프롬프트·MCP

비서로 일하려면 임무에 따라 스킬(예: 웹 글 요약 방법), 프롬프트(여러 임무가 함께 쓰는 지시), MCP 서버(GitHub·Slack·캘린더 등)가 필요하다.
Agent와 같은 방식으로 Mate 홈에 따로 두고, Pi Desktop의 것은 섞지 않는다. 다만 Mate는 사람이 지켜보지 않을 때 돌므로 권한을 더 좁게 둔다.

| 항목 | 규칙 |
|---|---|
| 스킬 | `~/.pi-desktop-mate/skills`. 임무마다 쓸 스킬을 고른다 (기본: 전부). 스킬은 지침일 뿐이라 권한을 넓히지 않는다. 스킬이 시키는 명령도 bash 허용 목록·권한 요청을 그대로 따른다 |
| 프롬프트 | `~/.pi-desktop-mate/prompts`. 임무 지시와 Mate 대화에서 `/이름`으로 부른다 |
| MCP 서버 | `~/.pi-desktop-mate/mcp.json`. 임무마다 쓸 서버를 고른다 (기본: 없음). 고른 서버의 도구만 모델에 선언한다 |
| MCP 도구 권한 | Mate는 MCP 도구가 읽기인지 쓰기인지 알 수 없다. 그래서 **처음 쓰는 도구는 막고 묻는다.** 막힌 bash 명령의 권한 요청(DESIGN-MATE.md §4)과 같은 흐름이다: 막힌 도구 이름을 남기고 → 실행이 끝나면 대화로 "허용하고 다시 실행"을 묻고 → 허용하면 그 임무의 `grants`에 `mcp__<서버>__<도구>`를 더해 다시 실행한다. 서버 전체를 한 번에 허용하지는 않는다 |
| Mate 대화 | 같은 스킬·프롬프트를 쓴다. MCP는 Mate 설정에서 대화에 쓸 서버를 고르고, 도구마다 같은 승인 규칙을 따른다 |
| 관리 화면 | Mate에 스킬·MCP 탭을 둔다. Agent의 스킬·MCP 화면을 가져다 쓴다 |

**Mate가 제안해서 만들기·추가하기.** 사용자가 직접 관리하는 것과 별도로, Mate는 임무를 하다가 필요한 스킬이나 MCP 서버가 없으면 **만들거나 찾아서 제안하고, 승인을 받은 뒤에만** Mate 홈에 넣는다. 직접 설치하지 않는다.

| 제안 | Mate가 하는 일 | 승인하면 | 지키는 선 |
|---|---|---|---|
| 스킬 초안 | 임무에 쓸 지침이 없으면(예: HN 글 요약 규칙) `SKILL.md` 초안을 써서 인박스 카드로 올린다 | 내용을 확인하고 적용하면 `skills/<이름>/`에 저장하고, 그 임무가 쓰게 한다 | 지침 파일만 만든다. 스크립트·실행 파일은 넣지 않는다. 내용을 그대로 보여 준다 |
| MCP 서버 추가 | 외부 서비스가 필요하면(예: GitHub PR 정리) **정해 둔 목록**에서 맞는 서버를 골라 카드로 올린다. 목록은 Agent의 MCP 미리 설정과 같은 것을 쓴다 | `mcp.json`에 넣고 그 임무에서 고른다. 토큰·로그인은 사용자가 직접 넣는다 | 목록 밖의 서버(인터넷에서 찾은 것)는 제안하지 않는다. 서버를 띄우는 명령과 접근하는 서비스를 카드에 보인다. 추가해도 그 도구는 처음 쓸 때 다시 허용을 묻는다 |
| 다른 앱에서 복사 | Pi Desktop·Agent에 쓸 만한 스킬이 있으면 알리고 복사를 묻는다 | Mate 홈으로 **복사**한다 (공유하지 않음, §2) | 다른 앱의 파일은 읽기만 한다. MCP 설정은 토큰이 섞일 수 있어 복사하지 않고 위의 "추가"로 한다 |

- 제안은 모델이 `mate_propose`에 `install` 정보(종류·이름·내용 또는 목록의 서버 id)를 붙여 남긴다. 실제 저장은 실행기가 승인을 받은 뒤 한다. 모델이 직접 Mate 홈에 쓰지 않는다 (보고·제안 단계는 파일을 쓰지 못한다).
- 같은 제안은 다시 올리지 않고, 버린 제안은 기억한다 (인박스의 중복 제거 규칙, DESIGN-MATE.md §5).
- 휴대폰에서도 카드로 보고 승인할 수 있다. MCP 서버 추가처럼 토큰이 필요한 것은 휴대폰에서 승인해도 PC의 Mate에서 토큰을 넣어야 쓸 수 있다.

### 3.5 관리 코드는 함께 쓴다 (`packages/pi-resources`)

데이터는 앱마다 따로 두지만(§2), **관리하는 기능은 세 앱이 같은 코드를 쓴다.** 같은 기능을 앱마다 따로 만들면 고칠 곳이 셋이 되기 때문이다.
공용 코드는 **어느 홈을 관리하는지**만 받아서 돌고, 그 홈 밖은 건드리지 않는다.

| 앱 | 관리하는 홈 |
|---|---|
| Pi Desktop | `~/.pi/agent` (Pi 기본) |
| Agent | `~/.pi-desktop-agent` |
| Mate | `~/.pi-desktop-mate` |

- `resourceHome({ home, … })`: 한 홈의 스킬(`skills/`)·MCP(`mcp.json`)를 보고 만들고 고치고 지우는 메서드. 데몬(Agent)·실행기(Mate)가 앱 API로 내보낸다. 스킬을 지우는 곳(휴지통)과 연결 확인에 쓸 Pi만 앱이 정한다.
- `pi-resources/react`: 관리 화면의 상태와 동작(`useSkills`, `useMcp`). 앱은 자기 API를 넘기고 **모양(마크업·CSS)만** 그린다.
- 낮은 단계의 저장 코드(스킬 저장, MCP 설정 읽기)는 Pi가 실행 중에 소스 그대로 불러오는 확장(agent-kit의 `skill_save`, pi-isolation의 MCP 확장)과 함께 그 패키지에 남긴다. pi-resources는 앱이 번들해 쓴다.
- 다른 앱의 것을 쓰고 싶으면 공유하지 않고 **복사**한다 (§3.4 "다른 앱에서 복사"와 같은 규칙).
- **Pi 패키지(확장)** (2단계): Agent·Mate도 자기 홈에 Pi 패키지를 설치한다.
  - 설치·제거: 그때만 설정 폴더를 앱 홈으로 바꿔 `pi install|remove`를 돌린다 (`PI_CODING_AGENT_DIR=<앱 홈>`). 목록은 `<앱 홈>/settings.json`, 설치본은 `<앱 홈>/npm|git/`.
  - 설치 폴더는 설치·제거 뒤 `pi list`로 받아 `<앱 홈>/package-paths.json`에 적는다. 세션을 열 때는 이 파일만 읽어 폴더마다 `-e <폴더>`로 올린다 (`-ne`는 그대로라 Pi Desktop의 패키지는 섞이지 않는다).
  - Agent: 새 대화부터 올라간다. 다른 호스트(WSL·SSH)는 그 호스트의 파일을 앱이 읽을 수 없어 아직 올리지 않는다.
  - Mate: Pi는 `--tools`에 없는 도구를 아예 올리지 않으므로, 설치할 때 패키지마다 도구 이름을 알아 둔다(`<앱 홈>/package-tools.json`. 작은 확장을 넣어 Pi를 RPC로 띄우고 세션이 시작될 때 도구 목록만 받는다. 모델은 부르지 않는다). 실행·대화 때 그 이름을 `--tools`에 더하고 mate-guard에 알린다(`PI_DESKTOP_MATE_PACKAGES`). MCP 도구처럼 **처음 쓸 때 막고 허용을 묻는다.** 허용 이름은 `ext__<도구>`로 bash 명령 허용과 나눈다.
- **에이전트로 관리하기** (3단계): 사람이 화면에서 하는 일을 에이전트에게 대화로 맡길 수 있다. 각 앱의 에이전트는 **자기 홈만** 고치고, 고치기 전에 승인을 받는다.
  - Pi Desktop·Agent: `pi-resources/extensions/manage.ts` 확장 하나를 데몬이 `-e`로 넣는다(데몬 번들에 문자열로 들어 있다가 bridge처럼 파일로 써 둔다. node 내장 모듈과 typebox만 import). 툴은 `resources_list`(읽기), `resource_save`·`resource_delete`(스킬·프롬프트, 지운 것은 `<홈>/resources-trash/`), `mcp_server`(넣기·켜기·끄기·빼기, API 키는 받지 않음), `pi_package`(설치·제거, 지금 도는 Pi로 `PI_CODING_AGENT_DIR=<홈>`).
  - 관리하는 홈: `PI_RESOURCES_HOME`. 없으면 Pi 설정 폴더(Pi Desktop). Agent는 앱 홈을 주고, 스킬 저장은 기존 `skill_save`가 맡는다(`PI_RESOURCES_NO_SKILL=1`).
  - 승인: Pi Desktop은 확장이 `ctx.ui.confirm`으로 묻는다. Agent는 permissions 확장이 툴마다 묻으므로 확장은 묻지 않는다(`PI_RESOURCES_CONFIRM=0`). MCP·패키지는 매번 묻는다.
  - Mate: 모델이 직접 쓰지 않고 `mate_propose`의 `install`로 제안한다(§3.4). 스킬·MCP 미리 설정·다른 앱 스킬 복사에 더해 **프롬프트**(`kind: prompt`)와 **Pi 패키지**(`kind: package`)를 제안할 수 있다. 패키지는 앱에서 적용할 때만 설치한다(휴대폰 메시지로는 적용하지 않음).
- **웹 검색 켜기** (4단계): Mate 대화의 "웹 검색 켜기"(`enable_web`)는 특정 서비스를 정해 넣지 않는다. 이미 있는 것부터 선택지로 보인다: ① Mate에 설치한 확장의 웹 도구(이름에 search·fetch·web), ② mcp.json에 넣어 둔 검색 서버(키가 필요한 서버는 키가 있을 때만), ③ 아무 검색 서버가 없을 때만 키 없이 쓰는 Exa. 고를 것이 하나면 예·아니요로, 여럿이면 선택지마다 버튼으로 묻는다(`permission.choices`). 키가 필요한 서버·다른 패키지는 방법만 알린다. 대화로 만드는 임무(`web: true`)는 대화에서 켠 웹 검색(서버·허용한 도구)을 그대로 쓰고, 꺼져 있으면 임무를 만들지 않고 먼저 켤지 묻는다.
- **다른 앱에서 가져오기** (2단계): 스킬은 폴더째 복사하고(같은 이름이 있으면 하지 않음), 패키지는 같은 출처를 이 앱에 새로 설치한다. MCP는 토큰이 섞일 수 있어 가져오지 않는다.
- 단계: 1) 스킬·MCP를 이 패키지로 모은다 (Agent·Mate). 2) Agent·Mate에서 Pi 패키지(확장) 설치와 "다른 앱에서 가져오기". 3) 세 앱의 에이전트가 같은 관리 툴로 자기 홈을 관리한다 (고치기 전에 승인). 4) Mate의 웹 검색 켜기가 특정 서버(Exa)를 정해 넣지 않게 한다.

## 4. 어디서 도는가 — 클라이언트와 호스트

```
앱(클라이언트, 이 PC) ──메시지──▶ 호스트(로컬·WSL·SSH)
                                  ├ Pi Desktop: host-agent 데몬(~/.pi-desktop) → pi --mode rpc
                                  ├ Agent:      host-agent 데몬(~/.pi-desktop-agent) → pi --mode rpc -e agent-kit
                                  └ Mate:       mate-runner(~/.pi-desktop-mate) → pi --mode json -e mate-kit
```

| 앱 | 지금 | 바꿀 것 |
|---|---|---|
| Pi Desktop | 이미 이 구조다. 호스트마다 데몬을 띄우고 메시지로만 다룬다 (DESIGN.md §3.2~3.4) | 없음 |
| Agent | 대화·지난 대화·닫기는 데몬을 거친다. 하지만 로컬 데몬 하나뿐이고, 기억·권한·작업·예약·네트워크·사용량·스킬·MCP 등 10여 화면은 앱이 이 PC의 파일을 직접 읽는다 | ① Pi Desktop의 호스트 연결(로컬·WSL·SSH 고르기, 원격 배포)을 가져온다. 원격 데몬 홈을 `~/.pi-desktop-agent`로 띄우게 한다. ② agent-kit을 그 호스트에 올리고 `-e` 경로를 그 호스트 기준으로 바꾼다. ③ 앱이 직접 읽던 데이터를 데몬 명령으로 옮긴다 (agent 데이터 전용 메서드). ④ 스케줄러 세션은 호스트마다 하나 |
| Mate | 앱과 실행기가 이 PC의 같은 폴더 파일로 주고받는다. 데몬을 쓰지 않는다 | ① 실행기를 호스트에 올리고 띄운다 (Pi Desktop의 원격 배포 방식 재사용). ② 앱 ↔ 실행기 통신을 파일 감시 대신 **실행기의 JSON-RPC**로 바꾼다 (host-agent의 `connect`처럼 stdio로 이어 WSL·SSH에서도 같은 경로). ③ 활동 관찰·작업 공간(worktree)·텔레그램은 그 호스트에서 돈다 |

## 5. 지금 데이터를 어떻게 하나

지금까지 Agent와 Mate에서 나눈 대화는 모두 시험용이었으므로 **옮기지 않는다.**

- Agent는 새 폴더(`~/.pi-desktop-agent/sessions`, `data/` 등)에서 빈 상태로 시작한다. 예전 Agent 대화는 `~/.pi/agent/sessions`에 남아 Pi Desktop 기록에 보인다. 필요 없으면 Pi Desktop의 휴지통으로 지운다.
- 예전 agent-kit 상태(`~/.pi/agent/pi-desktop-agent/`)와 Pi 기본 폴더의 Agent용 스킬·MCP 설정은 읽지 않는다. 앱이 지우지도 않는다 (사용자의 파일이므로).

## 6. 단계

| 단계 | 내용 | 비고 |
|---|---|---|
| **D1 데이터 분리** | Agent: 세션·스킬·프롬프트·MCP·AGENTS.md·앱 데이터를 앱 홈으로, §3.1의 실행 옵션, 자체 MCP 확장과 문맥 파일 확장. Mate: §3.1의 실행 옵션(스킬·프롬프트는 Mate 홈에서), 관찰 대상에 Agent 세션 추가 | **완료** (#117·#118) |
| **D2 휴지통·아카이브** | Pi Desktop·Agent: 데몬에 휴지통 목록·되살리기·비우기, 아카이브·되돌리기. 지금 삭제가 남긴 백업도 휴지통에 보인다. Mate: 실행 기록·지난 대화·임무 (200개 넘는 실행 기록 정리도 휴지통을 거침) | **완료** (#119·#120) |
| **D2.5 Mate 스킬·MCP** | §3.4: 스킬·MCP 탭, 임무별 스킬·MCP 서버 고르기, MCP 도구 권한 요청, 대화에서 쓸 MCP 서버, Mate가 제안하는 스킬 초안·MCP 서버 추가·다른 앱에서 복사 | **완료** (#121·#122·#123). Mate의 MCP 도구는 codemode 대신 바로 선언(direct)해 도구마다 허용한다 |
| **D3 Agent 호스트 선택** | 호스트 연결을 가져와 대화·지난 대화·휴지통·아카이브를 WSL·SSH에서 쓴다 | **완료**. 한 번에 한 호스트에 붙고 설정에서 바꾼다. kit은 그 호스트의 `~/.pi-desktop-agent/kits/<내용 해시>/`에 올린다 |
| **D4 Agent 화면의 데몬 이전** | 앱이 직접 읽던 화면을 데몬 명령으로 하나씩 옮긴다. 다 옮기면 원격에서 모든 화면이 된다 | **완료** (#125·#126). 함수 표는 agent-kit `src/app-api.ts`, 데몬은 `agent.call` 하나로 부른다 |
| **D5 Mate 원격 실행기** | 실행기 배포·JSON-RPC 통신·원격 관찰. 세부 설계: [DESIGN-MATE-REMOTE.md](DESIGN-MATE-REMOTE.md) (D5-1 실행기 RPC → D5-2 공용 배포 패키지 → D5-3 호스트 고르기 → D5-4 원격 텔레그램) | 가장 큼 |
