import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { attended } from "../../src/runtime";

/** 선택지 끝에 붙여 사용자가 직접 답을 쓸 수 있게 한다 */
export const FREE_ANSWER = "직접 입력";

/**
 * 되묻기 도구 (설계 DESIGN-AGENT.md §4 "되묻기").
 *
 * 요청이 모호할 때 모델이 추측으로 진행하지 않고 사용자에게 묻게 한다. `ctx.ui`로만 묻기 때문에
 * 앱에서는 확장 다이얼로그로, 터미널 pi에서는 TUI 선택지로 뜬다. 사람이 없는 실행에서는 묻지 못한다고 돌려준다.
 * 바깥을 바꾸지 않으므로 permissions 확장은 이 도구를 묻지 않는다.
 */
export default function askUser(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ask_user",
    label: "사용자에게 묻기",
    description:
      "요청이 모호하거나, 고를 수 있는 방법이 여럿이고 어느 쪽인지에 따라 결과가 크게 달라질 때 사용자에게 묻는다. " +
      "추측으로 진행하기 전에 쓴다. 고를 수 있는 답이 정해져 있으면 options에 2~6개를 준다.",
    promptSnippet: "ask_user: 모호한 요청을 추측하지 말고 사용자에게 묻는다",
    parameters: Type.Object({
      question: Type.String({ description: "사용자에게 할 질문 한두 문장" }),
      options: Type.Optional(Type.Array(Type.String(), { description: "고를 수 있는 답 (2~6개). 없으면 자유롭게 답을 받는다" })),
    }),
    // 질문 창은 한 번에 하나만 띄운다
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!attended(ctx.hasUI)) {
        throw new Error("지금은 사람이 지켜보지 않는 실행이라 물을 수 없다. 가장 그럴듯한 가정을 밝히고 진행하거나, 할 수 없다고 답하라.");
      }
      const options = (params.options ?? []).map((o) => o.trim()).filter(Boolean).slice(0, 6);
      let answer: string | undefined;
      if (options.length >= 2) {
        answer = await ctx.ui.select(params.question, [...options, FREE_ANSWER]);
        if (answer === FREE_ANSWER) answer = await ctx.ui.input(params.question);
      } else {
        answer = await ctx.ui.input(params.question);
      }
      const text = answer?.trim()
        ? `사용자의 답: ${answer.trim()}`
        : "사용자가 답하지 않았다. 같은 질문을 되풀이하지 말고, 할 수 있는 만큼 진행하거나 무엇이 필요한지 설명하라.";
      return { content: [{ type: "text", text }], details: { answer: answer ?? null } };
    },
  });
}
