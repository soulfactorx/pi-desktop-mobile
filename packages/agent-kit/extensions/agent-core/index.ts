import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { KIT_VERSION, STATUS_COMMAND } from "../../src/constants";

/**
 * agent-kit의 기본 확장.
 *
 * 지금은 agent-kit이 세션에 올라갔는지 확인하는 `/agent:status`만 둔다.
 * 앱 없이 터미널 pi에 설치해도 같은 명령이 동작한다 (설계 DESIGN-AGENT.md §1 "기능은 확장으로, 어디서나 동작").
 */
export default function agentCore(pi: ExtensionAPI): void {
  pi.registerCommand(STATUS_COMMAND, {
    description: "Pi Desktop Agent: agent-kit 버전을 알려 줍니다",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`agent-kit ${KIT_VERSION}`, "info");
    },
  });
}
