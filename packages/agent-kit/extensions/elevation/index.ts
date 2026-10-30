import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { attended, isScheduler, isWorker } from "../../src/runtime";
import { dataDir } from "../permissions/store";
import { argvLine, compileElevated, ELEVATED_OPS, ELEVATED_TOOL, SERVICE_ACTIONS, type ElevatedInput } from "./compile";
import { linuxPackageManager, runElevated } from "./run";
import { loadElevationEnabled } from "./store";

/**
 * 권한 상승 (설계 DESIGN-AGENT.md §4 "권한 상승", desktop-agent docs/DESIGN-PRIVILEGE-ELEVATION.md).
 *
 * - 에이전트는 관리자 권한도, 그것을 얻는 수단(비밀번호)도 갖지 않는다. OS 인증 창이 비밀번호를 받는다.
 * - 별도 도구로만 한다. bash의 sudo·runas 등은 permissions가 막는다.
 * - 기본은 꺼짐. 켜도 사람이 지켜보는 대화에서만 모델에게 보인다(setActiveTools). 워커·예약에는 보이지 않는다.
 * - 승인은 매번, 한 번만. 규칙으로 저장되지 않는다 (permissions가 "이번만 허용·거부"로만 묻는다).
 */
export default function elevation(pi: ExtensionAPI): void {
  const dir = dataDir();

  /** 지금 이 세션에서 쓸 수 있는가 */
  const usable = async (ctx: ExtensionContext) => !isWorker() && !isScheduler() && attended(ctx.hasUI) && (await loadElevationEnabled(dir));

  /** 쓸 수 있을 때만 모델에게 보이게 한다. 설정은 실행마다 다시 읽어 바로 반영한다 */
  const syncActive = async (ctx: ExtensionContext) => {
    const want = await usable(ctx);
    const active = pi.getActiveTools();
    const has = active.includes(ELEVATED_TOOL);
    if (want && !has) pi.setActiveTools([...active, ELEVATED_TOOL]);
    else if (!want && has) pi.setActiveTools(active.filter((name) => name !== ELEVATED_TOOL));
  };

  pi.on("session_start", async (_event, ctx) => {
    await syncActive(ctx);
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    await syncActive(ctx);
    return undefined;
  });

  pi.registerTool({
    name: ELEVATED_TOOL,
    label: "관리자 권한 실행",
    description:
      "관리자(root) 권한이 필요한 작업을 한 번 실행한다. OS 인증 창이 떠서 사용자가 직접 비밀번호를 넣어야 하고, 매번 사용자 승인이 필요하다. " +
      "꼭 필요할 때만, 한 번에 하나씩 요청하라. 권한이 필요 없는 명령은 bash를 쓴다. " +
      "op: package_install·package_remove(names), package_update, service(action, unit), copy_file(from, to 절대 경로), raw(argv: 실행 파일과 인자를 하나씩, 셸을 거치지 않는다).",
    promptSnippet: "shell_exec_elevated: 관리자 권한이 꼭 필요한 작업을 OS 인증 창을 거쳐 한 번 실행한다",
    parameters: Type.Object({
      op: StringEnum(ELEVATED_OPS, { description: "작업 종류" }),
      names: Type.Optional(Type.Array(Type.String(), { description: "package_* 의 패키지 이름들" })),
      action: Type.Optional(StringEnum(SERVICE_ACTIONS, { description: "service의 동작" })),
      unit: Type.Optional(Type.String({ description: "service의 서비스 이름" })),
      from: Type.Optional(Type.String({ description: "copy_file의 원본 절대 경로" })),
      to: Type.Optional(Type.String({ description: "copy_file의 대상 절대 경로" })),
      argv: Type.Optional(Type.Array(Type.String(), { description: "raw의 argv. argv[0]은 실행 파일, 인자 하나당 원소 하나" })),
    }),
    defaultActive: false,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // 승인은 permissions가 받았다. 여기서는 켜짐·사람 있음을 한 번 더 확인한다 (숨긴 도구를 이름으로 부르는 경우)
      if (!(await usable(ctx))) throw new Error("관리자 권한 실행이 꺼져 있거나 사람이 지켜보지 않는 실행이라 쓸 수 없다");
      const argv = compileElevated(params as ElevatedInput, process.platform, linuxPackageManager());
      const result = await runElevated(argv);
      if (result.cancelled) throw new Error(`${result.stderr} 같은 요청을 되풀이하지 말고 사용자에게 물어라`);
      const text = [`실행: ${argvLine(argv)}`, `종료 코드: ${result.exitCode}`, result.stdout && `출력:\n${result.stdout}`, result.stderr && `오류 출력:\n${result.stderr}`]
        .filter(Boolean)
        .join("\n");
      return { content: [{ type: "text", text }], details: { argv, exitCode: result.exitCode } };
    },
  });
}
