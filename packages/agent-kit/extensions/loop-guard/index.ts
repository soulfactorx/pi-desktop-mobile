import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RunGuard } from "./guard";

/**
 * 제자리 돌기 차단 (설계 DESIGN-AGENT.md §4).
 *
 * - 같은 실행 안에서 똑같은 읽기 조회를 다시 하면 막고, 앞선 결과를 쓰라고 돌려준다.
 * - 이미 쓴 문단을 다시 쓰면 신호로 센다.
 * - 신호가 SPIN_LIMIT만큼 쌓이면 실행을 멈추고 사용자에게 알린다. 그러지 않으면 사람이 손으로 멈출 때까지 돈다.
 *
 * 실행(run) 단위로 센다. 사용자가 새로 말을 걸면 처음부터 다시 센다.
 */
export default function loopGuard(pi: ExtensionAPI): void {
  const guard = new RunGuard();
  let stoppedNotified = false;

  pi.on("agent_start", async () => {
    guard.reset();
    stoppedNotified = false;
  });

  pi.on("tool_call", async (event) => {
    const reason = guard.checkCall(event.toolName, (event.input ?? {}) as Record<string, unknown>);
    if (guard.stopped) {
      return { block: true, terminate: true, reason: "같은 일을 되풀이하고 있어 작업을 멈췄다. 지금까지 알아낸 것만으로 답하라." };
    }
    return reason ? { block: true, reason } : undefined;
  });

  pi.on("tool_result", async (event) => {
    guard.recordResult(event.toolName, event.input ?? {}, event.isError);
    return undefined;
  });

  pi.on("turn_end", async (event, ctx) => {
    const message = event.message as { role?: string; content?: unknown };
    if (message.role === "assistant" && Array.isArray(message.content)) {
      const text = message.content
        .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n\n");
      guard.recordText(text);
    }
    if (guard.stopped && !stoppedNotified) {
      stoppedNotified = true;
      ctx.ui.notify("같은 일을 되풀이하고 있어 작업을 멈췄습니다. 요청을 더 구체적으로 다시 말해 주세요.", "warning");
      ctx.abort();
    }
    return undefined;
  });
}
