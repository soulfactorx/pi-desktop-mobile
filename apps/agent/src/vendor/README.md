# vendor — Pi Desktop에서 복사한 모듈

`apps/desktop`(Pi Desktop)의 연결·채팅 모듈을 **복사**해 둔 것이다. 출처: `main` `1491e07`. chat-state·ChatView·ToolCards·format은 메시지 시각·토큰 표시 때 다시 가져왔다 (styles.css는 필요한 규칙만 덧붙임).

처음(P0)에는 `@desktop` 별칭으로 Pi Desktop 소스를 직접 가져다 썼다. 그러면 Pi Desktop을 고칠 때
에이전트 빌드가 깨지고, Pi Desktop PR의 CI까지 실패할 수 있다. Pi Desktop은 건드리지 않는다는 원칙(설계 DESIGN-AGENT.md §0)에 맞춰
P1에서 복사로 바꿨다. 공용 패키지로 옮기는 방식은 Pi Desktop을 고쳐야 하므로 택하지 않았다.

| 폴더 | 원본 |
|---|---|
| `main/` | `apps/desktop/src/main/` — host-connection, agent-build, reconnect-policy, node-runtime, replay-collector, dev-overrides. 원격 배포(remote-agent·wsl·ssh·ssh-hosts)는 D5-2에서 공용 패키지 `packages/host-deploy`로 옮겼다 |
| `renderer/` | `apps/desktop/src/renderer/` — chat-state, ChatView, ToolCards, tool-view, ExtensionUi, extension-ui-state, run-status, format, markdown/, styles.css. D3에서 FolderBrowser, folder-browser를 더 가져왔다 (출처 `ade26d1`) |
| `shared/api.ts` | `apps/desktop/src/shared/api.ts`의 `ConnectionState`만 (`SshHostConfig`는 host-deploy) |

규칙
- 복사한 파일은 되도록 고치지 않는다. Pi Desktop에서 고친 내용을 다시 가져올 때 비교하기 쉽도록.
- 에이전트에 맞게 바꿔야 하면 이 폴더 밖에 새 모듈을 만들어 감싸거나, 고친 곳에 `// agent:` 주석을 단다.
- 다시 가져올 때는 출처 커밋을 이 문서에 갱신한다.
