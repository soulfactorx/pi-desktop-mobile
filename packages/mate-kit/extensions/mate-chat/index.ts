import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendChatQuestion, appendChatAction } from "../../src/chat";
import { ASK_TOOL, DO_TOOL, MATE_ENV } from "../../src/shared";

/**
 * Mate 대화 도구 (설계 DESIGN-MATE.md §13).
 * - mate_ask: 임무·관찰자 실행이 사용자에게 대화로 묻는다 (선택지 버튼). 앱 대화 탭과 휴대폰에 뜬다
 * - mate_do: 대화 중 Mate가 실행기에 할 일을 맡긴다 (임무 실행·살펴보기·고치기·제안 처리·임무 만들기·일시 정지)
 * 환경 변수가 없으면(터미널 pi에 설치) 등록하지 않는다.
 */
export default function mateChatExtension(pi: ExtensionAPI): void {
  const chat = process.env[MATE_ENV.chat];
  const actions = process.env[MATE_ENV.actions];
  const profile = process.env[MATE_ENV.profile];

  if (chat && (profile === "propose" || profile === "act")) {
    pi.registerTool(
      defineTool({
        name: ASK_TOOL,
        label: "Mate 질문",
        description:
          "사용자의 판단이 필요할 때 대화로 짧게 묻는다 (예: 테스트를 추가할까요?). 사용자는 나중에 답한다. " +
          "답을 기다리지 않으니, 물은 뒤에는 할 수 있는 만큼만 하고 끝낸다. 같은 것을 두 번 묻지 않는다.",
        parameters: Type.Object({
          question: Type.String({ description: "한두 문장 질문" }),
          options: Type.Optional(Type.Array(Type.String(), { description: "버튼으로 보일 짧은 답 (2~4개, 예: [\"예, 맡길게\", \"아니요\"])", maxItems: 4 })),
        }),
        async execute(_id, params) {
          const added = await appendChatQuestion(chat, {
            text: params.question,
            ...(params.options?.length ? { options: params.options.slice(0, 4) } : {}),
            ...(process.env[MATE_ENV.dutyId] ? { dutyId: process.env[MATE_ENV.dutyId] } : {}),
            ...(process.env[MATE_ENV.runId] ? { runId: process.env[MATE_ENV.runId] } : {}),
            cwd: process.cwd(),
          });
          return {
            content: [{ type: "text", text: added ? "사용자에게 물었습니다. 답은 나중에 대화로 옵니다." : "이미 물은 질문이라 다시 묻지 않았습니다." }],
            details: { added },
          };
        },
      }),
    );
  }

  if (actions && profile === "chat") {
    pi.registerTool(
      defineTool({
        name: DO_TOOL,
        label: "Mate 할 일",
        description:
          "사용자가 원하는 일을 Mate 실행기에 맡긴다. 이 대화가 끝난 뒤 실행되고 결과는 대화로 알린다. " +
          "run_duty(임무 실행), ask(폴더를 읽기만 하며 살펴보기), fix(폴더를 별도 작업 공간에서 고치기 — 적용은 사용자가 다시 승인), " +
          "accept/dismiss(제안 확인함·버리기), delegate(제안의 맡길 일 실행), create_duty(임무 만들기), pause/resume(자동 실행 멈춤·다시). " +
          "사용자가 분명히 원할 때만 쓰고, 애매하면 먼저 물어본다.",
        parameters: Type.Object({
          action: Type.Union(
            ["run_duty", "ask", "fix", "accept", "dismiss", "delegate", "create_duty", "pause", "resume"].map((a) => Type.Literal(a)),
          ),
          duty: Type.Optional(Type.String({ description: "run_duty: 임무 id 또는 이름" })),
          folder: Type.Optional(Type.String({ description: "ask·fix·create_duty: 폴더 이름(마지막 폴더명) 또는 경로" })),
          prompt: Type.Optional(Type.String({ description: "ask·fix·create_duty: 구체적인 지시" })),
          item: Type.Optional(Type.String({ description: "accept·dismiss·delegate: 인박스 항목 id" })),
          name: Type.Optional(Type.String({ description: "create_duty: 임무 이름" })),
          schedule: Type.Optional(
            Type.String({ description: "create_duty: \"manual\", \"daily HH:MM\", \"weekdays HH:MM\", \"every N minutes\", \"on-commit\", \"after-session\"" }),
          ),
          profile: Type.Optional(Type.Union([Type.Literal("observe"), Type.Literal("propose"), Type.Literal("act")], { description: "create_duty: 보고·제안·고치기 (기본 제안)" })),
        }),
        async execute(_id, params) {
          await appendChatAction(actions, params as Record<string, unknown>);
          return { content: [{ type: "text", text: `할 일로 넣었습니다 (${params.action}). 대화가 끝나면 실행기가 처리하고 결과를 알립니다.` }], details: undefined };
        },
      }),
    );
  }
}
