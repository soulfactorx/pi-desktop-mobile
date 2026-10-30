import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findContextFiles } from "../src/context-files";
import { isolationHome } from "../src/paths";

/**
 * 앱 홈의 `AGENTS.md`와 작업 폴더의 문맥 파일을 시스템 안내에 붙인다 (설계 DESIGN-APPS.md §3.1).
 * Pi가 붙이는 것과 같은 자리(project_context)에 넣는다. 실행마다 다시 읽어 고친 내용이 바로 반영된다.
 * 앱 홈을 모르면(PI_ISOLATION_HOME 없음) 아무것도 하지 않는다.
 */
export default function context(pi: ExtensionAPI): void {
  const home = isolationHome();
  if (!home) return;
  pi.on("before_agent_start", (event, ctx) => {
    event.systemPromptOptions.contextFiles = findContextFiles(home, ctx.cwd);
    return undefined;
  });
}
