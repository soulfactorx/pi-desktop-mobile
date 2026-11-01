import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendProposal, installError, makeProposal } from "../../src/proposal";
import { MATE_ENV, PROPOSE_TOOL, type InstallProposal, type Severity } from "../../src/shared";

/**
 * `mate_propose`: 사용자에게 알릴 것·제안할 일을 Mate 인박스에 남긴다 (설계 DESIGN-MATE.md §5).
 * 실제로 파일을 바꾸거나 명령을 실행하지 않는다. 사용자는 앱을 켰을 때 인박스에서 본다.
 * 인박스 위치 환경 변수가 없으면(터미널 pi에 설치) 도구를 등록하지 않는다.
 */
export default function mateProposeExtension(pi: ExtensionAPI): void {
  const inbox = process.env[MATE_ENV.inbox];
  if (!inbox) return;
  const ids = { dutyId: process.env[MATE_ENV.dutyId] ?? "manual", runId: process.env[MATE_ENV.runId] ?? "manual" };
  const topic = process.env[MATE_ENV.topic];

  pi.registerTool(
    defineTool({
      name: PROPOSE_TOOL,
      label: "Mate 제안",
      description:
        "사용자에게 알릴 발견이나 제안할 다음 행동을 인박스에 남긴다. 사용자는 나중에 읽고 받아들이거나 버린다. " +
        "알릴 만한 것이 있을 때만, 하나의 주제당 한 번 쓴다. 파일을 바꾸거나 명령을 실행하지 않는다. " +
        "임무에 필요한 스킬·프롬프트·MCP 서버·Pi 패키지가 없으면 install을 붙여 설치를 제안할 수 있다. 사용자가 적용해야 들어간다.",
      parameters: Type.Object({
        title: Type.String({ description: "한 줄 제목 (예: CI 실패: unit-tests)" }),
        summary: Type.String({ description: "무엇을 발견했고 무엇을 하면 좋은지 2~3문장" }),
        detail: Type.Optional(Type.String({ description: "근거: 파일·줄, 명령 출력, 제안 패치 (Markdown)" })),
        followUp: Type.Optional(
          Type.String({
            description: "사용자가 \"Mate에게 맡기기\"를 누르면 이 폴더에서 실행할 고치기 지시 (구체적으로). 고칠 일이 아니면 비운다",
          }),
        ),
        severity: Type.Optional(
          Type.Union([Type.Literal("info"), Type.Literal("warn"), Type.Literal("action")], {
            description: "info: 참고, warn: 살펴볼 문제, action: 사용자가 할 일",
          }),
        ),
        install: Type.Optional(
          Type.Union(
            [
              Type.Object({
                kind: Type.Literal("skill"),
                name: Type.String({ description: "스킬 이름 (영어 소문자·숫자·하이픈)" }),
                content: Type.String({ description: "SKILL.md 전체: ---로 감싼 name·description 다음에 지시(Markdown). 스크립트는 넣지 않는다" }),
              }),
              Type.Object({ kind: Type.Literal("mcp"), preset: Type.String({ description: "시스템 안내에 적힌 MCP 서버 목록의 id" }) }),
              Type.Object({
                kind: Type.Literal("copy"),
                from: Type.Union([Type.Literal("pi-desktop"), Type.Literal("agent")]),
                name: Type.String({ description: "시스템 안내에 적힌 다른 앱의 스킬 이름" }),
              }),
              Type.Object({
                kind: Type.Literal("prompt"),
                name: Type.String({ description: "프롬프트 이름 (영어 소문자·숫자·하이픈, /이름으로 부른다)" }),
                content: Type.String({ description: "prompts/<이름>.md 전체: ---로 감싼 description 다음에 지시(Markdown)" }),
              }),
              Type.Object({
                kind: Type.Literal("package"),
                source: Type.String({ description: "Pi 패키지 (npm:이름, git:주소, https 주소). 사용자가 원했거나 꼭 필요할 때만. 코드를 실행하므로 무엇인지 summary에 밝힌다" }),
              }),
            ],
            { description: "설치 제안: 새 스킬 초안, 목록의 MCP 서버 추가, 다른 앱 스킬 복사, 프롬프트, Pi 패키지 중 하나" },
          ),
        ),
      }),
      async execute(_toolCallId, params) {
        const install = params.install as InstallProposal | undefined;
        const invalid = install ? installError(install) : undefined;
        if (invalid) throw new Error(`설치 제안이 잘못되었다: ${invalid}`);
        const item = makeProposal(
          {
            title: params.title,
            summary: params.summary,
            detail: params.detail,
            severity: params.severity as Severity | undefined,
            ...(topic ? { topic } : {}),
            ...(params.followUp ? { followUp: { prompt: params.followUp, cwd: process.cwd() } } : {}),
            ...(install ? { install } : {}),
          },
          ids,
        );
        const added = await appendProposal(inbox, item);
        return {
          content: [{ type: "text", text: added ? `인박스에 남겼습니다: ${item.title}` : "이미 알린 제안이라 다시 남기지 않았습니다." }],
          details: { id: item.id, added },
        };
      },
    }),
  );
}
