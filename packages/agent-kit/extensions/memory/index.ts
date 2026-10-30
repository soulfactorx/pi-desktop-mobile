import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { isLocalBaseUrl } from "../local-model/budget";
import { dataDir } from "../permissions/store";
import { attended, isPeerAnswer, isScheduler, isWorker, learning } from "../../src/runtime";
import { recordUsage } from "../../src/usage";
import { digestRun, EXTRACT_SYSTEM, extractPrompt, parseOps, UNVERIFIED_RULE, type RunDigest } from "./extract";
import { buildKnowledgeSection, relevance } from "./recall";
import {
  archiveEntry,
  getEntry,
  loadAutoLearn,
  loadEntries,
  MEMORY_TYPES,
  memoryDir,
  NO_SHARE_TAG,
  recordRecall,
  TYPE_LABEL,
  updateEntry,
  upsertByTitle,
  type KnowledgeEntry,
} from "./store";

/** 시스템 프롬프트에서 지식베이스가 들어가는 섹션 이름 (XML 태그 이름이 된다) */
export const MEMORY_SECTION = "agent_memory";

/**
 * 지식베이스 (설계 DESIGN-AGENT.md §4 "지식베이스", desktop-agent의 지식베이스를 옮김).
 *
 * - 매 요청 전에 전체 목록(한 줄씩)·고정 항목 본문·관련 항목 본문을 시스템 프롬프트 섹션으로 싣는다. 로컬 모델이면 창의 10%만.
 * - 모델은 memory_save(같은 제목이면 고침)·memory_read·memory_search·memory_forget(보관)으로 다룬다.
 *   에이전트 자신의 상태라 승인 없이 하되, 저장·보관할 때마다 알린다. 사람은 앱의 지식베이스 화면에서 고치고 정리한다.
 * - 실행이 끝나면(agent_settled) 지금 모델을 한 번 더 불러 이번 대화에서 남길 것을 뽑는다. 실패 신호(도구 오류·승인 거부)는
 *   교훈 후보로 넘기고, 도구로 확인한 것이 없는 대화에서 나온 항목에는 "확인 안 됨"을 붙인다. 기다리지 않고 돌린다.
 *   사람이 없는 실행(워커·예약)과 중단된 실행에서는 뽑지 않는다. 지식베이스 화면의 설정이나 PI_DESKTOP_AGENT_LEARN=0으로 끈다.
 * - 피어 질문에 답하는 워커에는 사용자(user) 항목과 "공유제외" 태그 항목을 싣지 않는다.
 */
export default function memory(pi: ExtensionAPI): void {
  const dir = memoryDir(dataDir());
  /** 마지막 실행의 메시지 (agent_end에서 받아 agent_settled에서 쓴다) */
  let lastRun: readonly unknown[] | undefined;
  /** 추출은 하나씩 차례로 (앞 추출이 만든 항목을 다음 추출이 보고 중복을 피하게) */
  let queue: Promise<void> = Promise.resolve();

  const shareable = (e: KnowledgeEntry) => !isPeerAnswer() || (e.type !== "user" && !e.tags.includes(NO_SHARE_TAG));

  pi.on("agent_end", (event) => {
    lastRun = event.messages;
    return undefined;
  });

  pi.on("agent_settled", (event, ctx) => {
    const messages = lastRun;
    lastRun = undefined;
    if (event.aborted || !messages || !learning() || isWorker() || isScheduler() || !attended(ctx.hasUI)) return undefined;
    const digest = digestRun(messages);
    if (!digest.hasUser) return undefined;
    queue = queue.then(() => learnFrom(ctx, digest)).catch(() => undefined);
    return undefined;
  });

  /** 이번 실행에서 남길 것을 뽑아 저장하고 알린다. 실패는 삼키지 않고 경고로 알린다 */
  async function learnFrom(ctx: ExtensionContext, digest: RunDigest): Promise<void> {
    const model = ctx.model;
    if (!model || !(await loadAutoLearn(dir))) return;
    try {
      const existing = await loadEntries(dir);
      const reply = await ctx.modelRegistry.complete(model, {
        systemPrompt: digest.verified ? EXTRACT_SYSTEM : EXTRACT_SYSTEM + UNVERIFIED_RULE,
        messages: [{ role: "user", content: extractPrompt(existing, digest, extractBudgetChars(ctx)), timestamp: Date.now() }],
      });
      // 이 호출은 세션에 남지 않으므로 사용량을 따로 적는다
      await recordUsage(dataDir(), "memory", model, reply.usage);
      if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage ?? "모델 호출이 실패했다");
      const text = reply.content.map((part) => (part.type === "text" ? part.text : "")).join("");
      const ops = parseOps(text, new Set(existing.map((m) => m.id)));
      const source = ctx.sessionManager?.getSessionFile?.();
      for (const op of ops) {
        if (op.op === "create") {
          const { entry, op: done } = await upsertByTitle(dir, {
            type: op.type,
            title: op.title,
            content: op.content,
            tags: op.tags,
            origin: "agent",
            ...(digest.verified ? {} : { unverified: true }),
            ...(source ? { source } : {}),
          });
          notify(ctx, `지식베이스에 ${done === "create" ? "남겼습니다" : "고쳤습니다"}: [${TYPE_LABEL[entry.type]}] ${entry.title}`, "info");
        } else if (op.op === "update") {
          // 확인된 대화의 갱신은 "확인 안 됨"을 걷어 내고, 확인 없는 대화의 갱신은 붙인다
          const entry = await updateEntry(dir, op.id, {
            content: op.content,
            ...(op.type ? { type: op.type } : {}),
            ...(op.title ? { title: op.title } : {}),
            ...(op.tags ? { tags: op.tags } : {}),
            unverified: !digest.verified,
          });
          if (entry) notify(ctx, `지식베이스를 고쳤습니다: ${entry.title}`, "info");
        } else {
          const entry = await archiveEntry(dir, op.id);
          if (entry) notify(ctx, `맞지 않게 된 항목을 보관했습니다: ${entry.title}`, "info");
        }
      }
    } catch (error) {
      notify(ctx, `지식 추출 실패: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  }

  pi.on("before_agent_start", async (event, ctx) => {
    const prompt = event.messageType === "user" ? event.prompt : "";
    const entries = (await loadEntries(dir)).filter(shareable);
    const { text, injected } = buildKnowledgeSection(entries, prompt, budgetChars(ctx));
    const sections = event.systemPromptOptions.sections;
    if (text) sections[MEMORY_SECTION] = text;
    else delete sections[MEMORY_SECTION];
    await recordRecall(dir, injected);
    return undefined;
  });

  pi.registerTool({
    name: "memory_save",
    label: "지식베이스에 남기기",
    description:
      "다음 대화에서도 알아야 할 것을 지식베이스에 남긴다. 사용자가 기억하라고 하거나, 앞으로도 쓰일 정보(자료 위치, 선호, 규칙, 요구사항, 실수에서 배운 것)가 나오면 쓴다. " +
      "같은 제목이 있으면 고친다. type: user(사용자 역할·환경·선호), requirement(진행 중인 일·목표·제약·결정), lesson(실수와 재발 방지, 본문에 상황·실수·원인·재발 방지), reference(자료·문서 위치). " +
      "검증되지 않은 진단·해결책은 사실로 쓰지 말고, 확정된 것과 아닌 것을 구분해 적어라. 이번 대화에만 필요한 것은 남기지 않는다.",
    promptSnippet: "memory_save: 앞으로도 쓰일 선호·요구사항·교훈·자료 위치를 지식베이스에 남긴다",
    parameters: Type.Object({
      type: StringEnum(MEMORY_TYPES, { description: "user·requirement·lesson·reference 중 하나" }),
      title: Type.String({ description: "한 줄 요약 (목록에 이것만 보인다)" }),
      content: Type.String({ description: "본문 (Markdown)" }),
      tags: Type.Optional(Type.Array(Type.String(), { description: "찾기 쉬운 낱말 몇 개" })),
      pinned: Type.Optional(Type.Boolean({ description: "늘 본문까지 실을지 (사용자가 꼭 지키라고 한 규칙)" })),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const source = ctx.sessionManager?.getSessionFile?.();
      const { entry, op } = await upsertByTitle(dir, { ...params, origin: "agent", ...(source ? { source } : {}) });
      ctx.ui.notify(`지식베이스에 ${op === "create" ? "남겼습니다" : "고쳤습니다"}: [${TYPE_LABEL[entry.type]}] ${entry.title}`, "info");
      return { content: [{ type: "text", text: `${op === "create" ? "남겼다" : "고쳤다"} (id: ${entry.id})` }], details: { id: entry.id, op } };
    },
  });

  pi.registerTool({
    name: "memory_read",
    label: "지식 읽기",
    description: "지식베이스 항목의 본문 전체를 읽는다. 목록에는 제목만 있으니 내용이 필요하면 id로 읽어라.",
    parameters: Type.Object({ id: Type.String({ description: "항목 id" }) }),
    async execute(_toolCallId, params) {
      const entry = await getEntry(dir, params.id);
      if (!entry || !shareable(entry)) throw new Error(`그런 항목이 없다: ${params.id}`);
      await recordRecall(dir, [entry.id]);
      const head = `[${TYPE_LABEL[entry.type]}] ${entry.title}${entry.unverified ? " (확인 안 됨)" : ""}${entry.status === "archived" ? " (보관됨)" : ""}`;
      return { content: [{ type: "text", text: `${head}\n태그: ${entry.tags.join(", ") || "없음"}\n\n${entry.content}` }], details: { id: entry.id } };
    },
  });

  pi.registerTool({
    name: "memory_search",
    label: "지식 찾기",
    description: "지식베이스에서 관련 항목을 찾는다 (제목·태그·본문). 목록에 다 보이지 않을 때 쓴다.",
    parameters: Type.Object({ query: Type.String({ description: "찾을 말" }) }),
    async execute(_toolCallId, params) {
      const found = (await loadEntries(dir))
        .filter(shareable)
        .map((e) => ({ e, score: relevance(e, params.query) }))
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);
      const text =
        found.length === 0
          ? "관련 항목이 없다."
          : found.map(({ e }) => `- [${TYPE_LABEL[e.type]}] ${e.title} (id: ${e.id})\n  ${e.content.replace(/\s+/g, " ").slice(0, 160)}`).join("\n");
      return { content: [{ type: "text", text }], details: { count: found.length } };
    },
  });

  pi.registerTool({
    name: "memory_forget",
    label: "지식 보관",
    description: "틀렸거나 더는 맞지 않는 항목을 보관한다 (지우지 않고 회상에서 뺀다). 지식베이스 목록의 id를 준다.",
    parameters: Type.Object({ id: Type.String({ description: "보관할 항목 id" }) }),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const entry = await archiveEntry(dir, params.id);
      if (!entry) throw new Error(`그런 항목이 없다: ${params.id}`);
      ctx.ui.notify(`지식베이스에서 보관했습니다: ${entry.title}`, "info");
      return { content: [{ type: "text", text: `보관했다 (id: ${params.id})` }], details: { id: params.id } };
    },
  });

  pi.registerCommand("agent:remember", {
    description: "Pi Desktop Agent: 꼭 지킬 선호·규칙을 지식베이스에 고정으로 남깁니다 (예: /agent:remember 답은 짧게)",
    handler: async (args, ctx) => {
      const text = args.trim();
      if (!text) {
        ctx.ui.notify("남길 내용을 함께 적어 주세요. 예: /agent:remember 답은 짧게", "warning");
        return;
      }
      const { entry } = await upsertByTitle(dir, { type: "user", title: text.slice(0, 60), content: text, pinned: true, origin: "user" });
      ctx.ui.notify(`지식베이스에 고정으로 남겼습니다: ${entry.title}`, "info");
    },
  });

  pi.registerCommand("agent:memories", {
    description: "Pi Desktop Agent: 지식베이스 목록과 저장 위치를 보여 줍니다",
    handler: async (_args, ctx) => {
      const entries = await loadEntries(dir);
      const lines = entries.slice(0, 30).map((m) => `- [${TYPE_LABEL[m.type]}]${m.pinned ? "📌" : ""} ${m.title} (${m.id})`);
      ctx.ui.notify(entries.length === 0 ? `지식베이스가 비어 있습니다. (${dir})` : `지식베이스 ${entries.length}개 (${dir})\n${lines.join("\n")}`, "info");
    },
  });
}

/** 세션이 닫힌 뒤라 알릴 곳이 없으면 조용히 넘어간다 */
function notify(ctx: ExtensionContext, message: string, level: "info" | "warning"): void {
  try {
    ctx.ui.notify(message, level);
  } catch {
    // 알리지 못해도 지식은 저장됐다
  }
}

/** 추출 요청에 쓸 글자 수. 로컬 모델은 창의 40%(토큰당 2글자 어림)로 출력 자리를 남긴다 */
function extractBudgetChars(ctx: ExtensionContext): number {
  const model = ctx.model;
  if (model && isLocalBaseUrl(model.baseUrl)) return Math.max(1500, Math.floor(model.contextWindow * 0.4 * 2));
  return 16000;
}

/** 지식베이스에 쓸 글자 수. 로컬 모델은 창의 10%(토큰당 3글자 어림), 그 밖은 넉넉히 */
function budgetChars(ctx: ExtensionContext): number {
  const model = ctx.model;
  if (model && isLocalBaseUrl(model.baseUrl)) return Math.max(600, Math.floor(model.contextWindow * 0.1 * 3));
  return 8000;
}
