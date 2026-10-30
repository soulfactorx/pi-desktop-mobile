# 개발 방식

이 저장소의 세 앱(Pi Desktop·Pi Desktop Agent·Pi Desktop Mate)과 공용 패키지에 함께 적용하는 규칙이다.
처음에는 [DESIGN.md](DESIGN.md) §11에 있었고, 앱이 늘면서 여기로 옮겼다.

## 1. 언어 규칙

- 소스 주석, 커밋 메시지(제목·본문), PR 설명, 문서는 **모두 한글**로 쓴다.
- 코드 식별자(변수·함수·타입 이름)와 로그 키는 영어로 쓴다. 사용자에게 보이는 UI 문자열의 기본 언어는 한국어로 한다.

## 2. 커밋 단위 — 코드 리뷰가 가능한 크기

- **한 커밋 = 한 가지 관심사.** 리팩터링, 기능 추가, 포맷 변경을 섞지 않는다.
- 커밋마다 빌드와 테스트가 통과해야 한다. 중간 커밋을 체크아웃해도 동작해야 한다.
- 크기는 diff 기준 대략 400줄 이하를 목표로 한다. 자동 생성 파일과 lockfile은 별도 커밋으로 분리한다.
- 새 모듈은 "타입·인터페이스 → 구현 → 테스트 → 연결(wiring)" 순서로 나눠 커밋하면 리뷰하기 쉽다.

## 3. 커밋 메시지 형식

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
| `perf` | 성능 개선 |
| `test` | 테스트만 추가·수정 |
| `docs` | 문서 |
| `style` | 화면 스타일·포맷 |
| `build` / `ci` | 빌드 설정, CI |
| `chore` | 그 밖의 잡무 (의존성 갱신 등) |

범위(scope)는 고친 앱·패키지 이름을 쓴다. 앱 안에서 한쪽만 고쳤으면 `-main`·`-renderer`를 붙여도 된다.

| 영역 | scope |
|---|---|
| `apps/desktop` | `desktop` |
| `apps/agent` | `agent`, `agent-main`, `agent-renderer` |
| `apps/mate` | `mate`, `mate-main`, `mate-renderer` |
| `packages/host-agent`, `packages/host-protocol` | `host-agent`, `host-protocol` |
| `packages/agent-kit` | `agent-kit` |
| `packages/mate-kit`, `packages/mate-runner` | `mate-kit`, `mate-runner` |
| `packages/pi-isolation` | `pi-isolation` |

## 4. 브랜치와 PR

- `main`은 항상 동작하는 상태를 유지한다. 작업은 `feat/<주제>`·`fix/<주제>`·`docs/<주제>` 브랜치에서 하고 PR로 합친다. 앱이 드러나게 `feat/mate-…`, `feat/agent-…`처럼 앞에 앱 이름을 붙인다.
- PR 하나는 기능 하나 단위로 만든다. 설명에는 변경 요약, 관련 설계 문서 절, 테스트 방법, 스크린샷(UI 변경 시)을 넣는다.
- 한 앱의 작업은 다른 앱의 폴더를 고치지 않는다. 공용 패키지(`host-agent`·`host-protocol`)를 고치면 그것을 쓰는 앱(Pi Desktop·Agent)을 함께 확인한다.
- 병합은 커밋 이력이 그대로 남도록 merge commit을 쓴다. squash하면 리뷰 단위로 나눈 커밋이 사라지므로 쓰지 않는다.

## 5. main 브랜치 룰셋 ("main 보호")

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

## 6. 릴리스

세 앱은 같은 저장소의 GitHub Releases에 올리되 태그와 워크플로를 나눈다.

| 앱 | 태그 | 워크플로 | Latest 표시 |
|---|---|---|---|
| Pi Desktop | `v*` (예: `v0.1.18`) | `.github/workflows/release.yml` | 한다 (자동 업데이트가 Latest의 latest.yml을 봄) |
| Pi Desktop Agent | `agent-v*` | `.github/workflows/release-agent.yml` | 하지 않는다 |
| Pi Desktop Mate | `mate-v*` | `.github/workflows/mate-release.yml` | 하지 않는다 |

- 지난 태그 이후 바뀐 경로로 릴리스할 앱을 고른다. 문서만 바뀌었으면 릴리스하지 않는다.
- 같은 앱의 릴리스를 겹쳐 돌리지 않는다. 앞 빌드가 끝난 뒤 다음 태그를 붙인다.
- 태그는 주석 태그로 붙인다: `git tag -a mate-v0.5.2 -m "Pi Desktop Mate v0.5.2"`.
- Actions 탭에서 워크플로를 손으로 돌리면 만들기만 하고 올리지 않는다 (릴리스 전 미리 확인).
