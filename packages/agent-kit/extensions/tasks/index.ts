import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { dataDir } from "../permissions/store";
import { attended, isWorker } from "../../src/runtime";
import { loadTasks, newTaskId, saveTask, tasksDir, type TaskRecord } from "./store";
import { runWorker } from "./worker";

/** 한 세션에서 동시에 돌릴 워커 수 */
export const MAX_RUNNING = 2;
/** 대화에 들어가는 작업 결과의 최대 글자 수. 전문은 작업 기록 파일에 있다 */
const RESULT_CHARS = 4000;

export const TASK_MESSAGE = "agent-task";

/**
 * 작업 위임 (설계 DESIGN-AGENT.md §4 "메인/워커 분리").
 *
 * 오래 걸리는 일을 워커(자식 Pi)에 맡기고 대화는 바로 돌아온다. 워커의 승인 요청은 이 세션의 다이얼로그로 뜬다.
 * 끝나면 결과를 "[작업 알림]" 메시지로 대화에 넣고 한 턴을 일으켜, 모델이 결과를 보고 이어서 답하게 한다.
 * 워커 안에서는 이 도구들을 등록하지 않는다 (일을 다시 맡기며 끝없이 퍼지지 않게).
 */
export default function tasks(pi: ExtensionAPI): void {
  if (isWorker()) return;
  const dir = tasksDir(dataDir());
  const running = new Map<string, { record: TaskRecord; abort: AbortController }>();

  pi.on("session_shutdown", async () => {
    for (const { abort } of running.values()) abort.abort();
  });

  const start = (ctx: ExtensionContext, title: string, instruction: string): TaskRecord => {
    const record: TaskRecord = {
      id: newTaskId(),
      title,
      instruction,
      origin: "delegate",
      status: "running",
      cwd: ctx.cwd,
      startedAt: new Date().toISOString(),
    };
    const abort = new AbortController();
    running.set(record.id, { record, abort });
    void saveTask(dir, record);
    const ui = attended(ctx.hasUI) ? ctx.ui : undefined;
    runWorker({
      label: `작업 ${record.id}`,
      prompt: instruction,
      cwd: ctx.cwd,
      provider: ctx.model?.provider,
      model: ctx.model?.id,
      ui,
      signal: abort.signal,
    })
      .then((result) => {
        record.status = result.aborted ? "cancelled" : "done";
        record.result = result.text;
      })
      .catch((error: unknown) => {
        record.status = "failed";
        record.error = error instanceof Error ? error.message : String(error);
      })
      .finally(async () => {
        record.finishedAt = new Date().toISOString();
        running.delete(record.id);
        await saveTask(dir, record);
        pi.sendMessage(
          { customType: TASK_MESSAGE, content: taskNotice(record), display: true, details: { id: record.id, status: record.status } },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      });
    return record;
  };

  pi.registerTool({
    name: "delegate_task",
    label: "작업 맡기기",
    description:
      "여러 단계가 필요하거나 오래 걸리는 일을 백그라운드 워커에 맡긴다. 맡긴 뒤 대화는 바로 이어지고, 끝나면 결과가 [작업 알림]으로 들어온다. " +
      "instruction은 워커가 이 대화를 모른다고 보고 혼자 끝낼 수 있게 구체적으로 쓴다 (경로·기준·결과 형식). 결과가 오기 전에 결과를 지어내지 마라.",
    promptSnippet: "delegate_task: 오래 걸리는 일을 백그라운드 워커에 맡긴다",
    parameters: Type.Object({
      title: Type.String({ description: "작업을 알아볼 짧은 이름" }),
      instruction: Type.String({ description: "워커가 혼자 끝낼 수 있는 구체적인 지시" }),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (running.size >= MAX_RUNNING) {
        throw new Error(`이미 작업 ${running.size}개가 돌고 있다. 끝나기를 기다리거나 cancel_task로 하나를 멈춰라.`);
      }
      const record = start(ctx, params.title.trim() || "작업", params.instruction);
      return {
        content: [{ type: "text", text: `작업 ${record.id}(${record.title})를 시작했다. 끝나면 결과가 [작업 알림]으로 들어온다. 그 전에 결과를 지어내지 마라.` }],
        details: { id: record.id },
      };
    },
  });

  pi.registerTool({
    name: "list_tasks",
    label: "작업 목록",
    description: "맡긴 작업과 최근 작업의 상태를 본다.",
    parameters: Type.Object({}),
    async execute() {
      const recent = (await loadTasks(dir)).slice(0, 10);
      const text = recent.length === 0 ? "작업이 없다." : recent.map((t) => `- ${t.id} [${t.status}] ${t.title}`).join("\n");
      return { content: [{ type: "text", text }], details: { count: recent.length } };
    },
  });

  pi.registerTool({
    name: "cancel_task",
    label: "작업 멈추기",
    description: "돌고 있는 작업을 멈춘다. 사용자가 그만하라고 하면 쓴다.",
    parameters: Type.Object({ id: Type.String({ description: "멈출 작업 id" }) }),
    async execute(_toolCallId, params) {
      const task = running.get(params.id);
      if (!task) {
        // 피어에게 맡긴 작업이면 상대에게 취소를 보낸다
        const record = (await loadTasks(dir)).find((t) => t.id === params.id && t.origin === "peer-out");
        if (record && record.status !== "done" && record.status !== "failed" && record.status !== "cancelled") {
          const { cancelRemoteTask } = await import("../peers/tasks");
          const { loadPeers } = await import("../peers/store");
          const next = await cancelRemoteTask(dataDir(), record, await loadPeers(dataDir()));
          return { content: [{ type: "text", text: `${record.peer?.name ?? "피어"}에게 맡긴 작업 ${params.id}를 멈추게 했다 (상태: ${next.status}).` }], details: { id: params.id } };
        }
        throw new Error(`돌고 있는 작업이 아니다: ${params.id}`);
      }
      task.abort.abort();
      return { content: [{ type: "text", text: `작업 ${params.id}를 멈추게 했다.` }], details: { id: params.id } };
    },
  });
}

export function taskNotice(record: TaskRecord): string {
  const head = `[작업 알림] ${record.title} (${record.id}) — ${STATUS_LABEL[record.status]}`;
  if (record.status === "failed") return `${head}\n오류: ${record.error ?? "알 수 없음"}`;
  if (record.status === "cancelled") return `${head}\n${record.result ? `멈추기 전까지: ${clip(record.result)}` : ""}`.trim();
  return `${head}\n${record.result ? clip(record.result) : "(워커가 글로 된 답을 남기지 않았다)"}`;
}

const STATUS_LABEL: Record<TaskRecord["status"], string> = { waiting: "승인 기다림", running: "실행 중", done: "완료", failed: "실패", cancelled: "취소됨" };

function clip(text: string): string {
  return text.length > RESULT_CHARS ? `${text.slice(0, RESULT_CHARS)}\n[결과가 길어 앞부분만 넣었다. 전문은 작업 기록에 있다]` : text;
}
