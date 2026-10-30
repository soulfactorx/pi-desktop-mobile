import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dataDir } from "../permissions/store";
import {
  compactionProblem,
  effectiveCompaction,
  isLocalBaseUrl,
  shrink,
  suggestedCompaction,
  toolResultChars,
  type CompactionSettings,
} from "./budget";
import { probeOllama } from "./probe";

/** 지금 쓰는 로컬 모델의 상태. 로컬이 아니면 없다 */
interface LocalState {
  modelKey: string;
  /** 예산 계산에 쓰는 창. 서버 실측이 설정보다 작으면 실측 */
  contextWindow: number;
  thinking: boolean;
}

const SETUP_COMMAND = "agent:local-setup";

/**
 * 로컬 모델 대응 (설계 DESIGN-AGENT.md §4). 모델 주소가 로컬 서버일 때만 동작한다.
 *
 * - 첫 요청 전에 Ollama에 실제 창과 사고 지원 여부를 묻고, 설정과 다르면 알린다.
 * - 압축 설정이 창에 맞지 않으면 알리고, `/agent:local-setup`으로 이 모델용 설정을 저장하게 한다.
 * - 도구 결과가 창의 1/4을 넘으면 앞부분만 보내고, 전문은 파일로 남겨 필요한 부분만 다시 읽게 한다.
 * - 사고를 지원하는 모델인데 사고 수준이 off면 요청에 reasoning_effort: "none"을 넣어 사고 토큰을 끈다.
 *
 * 경고는 첫 요청 때 낸다. 세션을 막 열었을 때 낸 알림은 앱이 붙기 전이라 놓칠 수 있다.
 */
export default function localModel(pi: ExtensionAPI): void {
  let state: LocalState | undefined;
  /** 이미 확인한 모델 (모델별로 한 번만 묻고 알린다) */
  let checkedFor: string | undefined;

  const modelKeyOf = (ctx: ExtensionContext) => (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);

  async function refresh(ctx: ExtensionContext): Promise<void> {
    const key = modelKeyOf(ctx);
    if (key === checkedFor) return;
    checkedFor = key;
    state = undefined;
    const model = ctx.model;
    if (!model || !key || !isLocalBaseUrl(model.baseUrl)) return;

    const configured = model.contextWindow;
    const probe = await probeOllama(model.baseUrl, model.id);
    const contextWindow = probe.contextLength ? Math.min(configured, probe.contextLength) : configured;
    state = { modelKey: key, contextWindow, thinking: probe.thinking === true };

    const warnings: string[] = [];
    if (probe.contextLength && probe.contextLength !== configured) {
      warnings.push(
        `서버가 연 창(${probe.contextLength})이 models.json의 contextWindow(${configured})와 다릅니다. ` +
          (probe.contextLength < configured
            ? "프롬프트가 서버에서 조용히 잘릴 수 있으니 contextWindow를 맞추거나 OLLAMA_CONTEXT_LENGTH를 올리세요."
            : "창을 다 쓰지 못하고 있으니 contextWindow를 올리세요."),
      );
    }
    const problem = compactionProblem(contextWindow, effectiveCompaction(pi.getSettings(), key));
    if (problem) warnings.push(`${problem}. /${SETUP_COMMAND}로 이 모델에 맞는 압축 설정을 저장할 수 있습니다.`);
    for (const warning of warnings) ctx.ui.notify(`로컬 모델 ${key}: ${warning}`, "warning");
  }

  pi.on("before_agent_start", async (_event, ctx) => {
    await refresh(ctx);
    return undefined;
  });

  pi.on("model_select", async () => {
    // 다음 요청 때 새 모델을 다시 확인한다
    checkedFor = undefined;
    state = undefined;
  });

  pi.on("before_provider_request", async (event, ctx) => {
    if (!state?.thinking || ctx.model?.api !== "openai-completions" || pi.getThinkingLevel() !== "off") return undefined;
    const payload = event.payload as Record<string, unknown> | undefined;
    if (!payload || payload.reasoning_effort !== undefined) return undefined;
    return { ...payload, reasoning_effort: "none" };
  });

  pi.on("tool_result", async (event) => {
    if (!state) return undefined;
    const budget = toolResultChars(state.contextWindow);
    const text = event.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    const cut = shrink(text, budget);
    if (!cut) return undefined;

    let note: string;
    if (event.toolName === "read") {
      // 파일은 이미 디스크에 있다. 다시 저장하지 않고 범위를 좁혀 읽게 한다
      note = `[결과가 커서(${cut.total}자) 앞부분만 보냈다. offset/limit로 범위를 좁혀(예: 100줄씩) 필요한 부분만 다시 읽어라.]`;
    } else {
      const path = await saveFullOutput(event.toolCallId, text);
      note = path
        ? `[결과가 커서(${cut.total}자) 앞부분만 보냈다. 전문은 ${path} 에 저장했다. read 도구에 offset/limit를 줘서 필요한 부분만 읽어라.]`
        : `[결과가 커서(${cut.total}자) 앞부분만 보냈다. 범위를 좁혀 다시 실행하라.]`;
    }
    const images = event.content.filter((part) => part.type !== "text");
    return { content: [{ type: "text" as const, text: `${cut.preview}\n\n${note}` }, ...images] };
  });

  pi.registerCommand(SETUP_COMMAND, {
    description: "Pi Desktop Agent: 지금 로컬 모델의 창에 맞는 압축 설정을 settings.json에 저장합니다",
    handler: async (_args, ctx) => {
      checkedFor = undefined;
      await refresh(ctx);
      if (!state) {
        ctx.ui.notify("지금 모델은 로컬 서버가 아니라 바꿀 것이 없습니다.", "info");
        return;
      }
      const next = suggestedCompaction(state.contextWindow);
      const ok = await ctx.ui.confirm(
        `${state.modelKey}의 압축 설정을 저장할까요?`,
        `창 ${state.contextWindow} 기준: reserveTokens ${next.reserveTokens}, keepRecentTokens ${next.keepRecentTokens}\n` +
          `settings.json의 compaction.modelOverrides["${state.modelKey}"]에 저장합니다. 새 세션부터 적용됩니다.`,
      );
      if (!ok) return;
      try {
        await saveCompactionOverride(state.modelKey, next);
        ctx.ui.notify(`${state.modelKey}의 압축 설정을 저장했습니다. 새 세션부터 적용됩니다.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}

/** 잘라 낸 도구 결과의 전문을 agent-kit 상태 폴더에 남긴다. 실패하면 undefined */
async function saveFullOutput(toolCallId: string, text: string): Promise<string | undefined> {
  try {
    const dir = join(dataDir(), "outputs");
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${toolCallId.replace(/[^A-Za-z0-9_.-]/g, "_")}.txt`);
    await writeFile(path, text, "utf8");
    return path;
  } catch {
    return undefined;
  }
}

/** Pi 전역 settings.json의 compaction.modelOverrides에 이 모델의 설정을 합쳐 쓴다 (다른 설정은 그대로) */
async function saveCompactionOverride(modelKey: string, value: CompactionSettings): Promise<void> {
  const dir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const path = join(dir, "settings.json");
  let raw: string | undefined;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    // 없으면 새로 만든다
  }
  let settings: Record<string, unknown> = {};
  if (raw !== undefined && raw.trim()) {
    try {
      settings = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // 읽지 못하는 파일을 덮어쓰면 사용자의 다른 설정이 사라진다
      throw new Error(`${path}을 읽을 수 없어 저장하지 않았습니다. 파일을 고친 뒤 다시 시도하세요.`);
    }
  }
  const compaction = (settings.compaction as Record<string, unknown> | undefined) ?? {};
  const overrides = (compaction.modelOverrides as Record<string, unknown> | undefined) ?? {};
  settings.compaction = { ...compaction, modelOverrides: { ...overrides, [modelKey]: value } };
  await mkdir(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}
