import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { dataDir } from "../permissions/store";
import { isScheduler, isWorker } from "../../src/runtime";
import { newTaskId, saveTask, tasksDir, type TaskRecord } from "../tasks/store";
import { runWorker } from "../tasks/worker";
import { describeSchedule, dueSchedules, firstRun, invalidReason, markStarted, type Schedule, type ScheduleKind } from "./plan";
import { loadSchedules, newScheduleId, schedulesPath, updateSchedules } from "./store";

/** 스케줄러가 예약을 확인하는 간격 */
const DEFAULT_TICK_MS = 30_000;
/** 스케줄러가 동시에 돌리는 예약 실행 수 */
const MAX_RUNNING = 2;

/**
 * 예약 실행 (설계 DESIGN-AGENT.md §4 "예약·주기 작업").
 *
 * - 대화 세션: schedule_task·list_schedules·cancel_schedule 도구로 schedules.json을 고친다.
 * - 스케줄러 세션(PI_DESKTOP_AGENT_SCHEDULER=1): 앱이 데몬에 하나 띄워 두는 상주 세션이다. 확장이 타이머를 돌려
 *   도래한 예약을 "사람이 없는" 워커로 실행하고, 결과를 tasks/<id>.json에 남긴다. 데몬은 돌고 있는 세션이 있으면
 *   꺼지지 않으므로 앱을 닫아도 예약이 돈다. Host Agent(Pi Desktop과 공유)는 고치지 않는다.
 * 사람이 없는 워커에서는 쓰기·실행·네트워크가 모두 거부되므로, 예약 실행은 읽고 정리해 알리는 일에 맞다.
 */
export default function schedule(pi: ExtensionAPI): void {
  if (isWorker()) return;
  const dir = dataDir();
  const path = schedulesPath(dir);

  if (isScheduler()) {
    runScheduler(pi, dir, path);
    return;
  }

  pi.registerTool({
    name: "schedule_task",
    label: "예약하기",
    description:
      "정해진 때에 할 일을 예약한다. kind=once(한 번, at에 ISO 시각), interval(minutes분마다, 5분 이상), daily(매일 time HH:MM). " +
      "예약 실행에는 사람이 없어 파일 쓰기·명령 실행·웹 요청은 거부된다. 읽고 정리해 결과를 남기는 일만 맡긴다. " +
      "instruction은 실행할 때 이 대화를 모른다고 보고 혼자 끝낼 수 있게 쓴다. 앱이 켜진 적이 있어야 돈다(앱을 닫아도 돈다).",
    promptSnippet: "schedule_task: 정해진 때에 할 일을 예약한다",
    parameters: Type.Object({
      title: Type.String({ description: "예약을 알아볼 짧은 이름" }),
      instruction: Type.String({ description: "실행할 때 할 일 (혼자 끝낼 수 있게 구체적으로)" }),
      kind: StringEnum(["once", "interval", "daily"], { description: "once·interval·daily" }),
      at: Type.Optional(Type.String({ description: "once: 실행 시각 ISO 8601 (시간대 포함, 예: 2026-10-30T15:00:00+09:00)" })),
      minutes: Type.Optional(Type.Number({ description: "interval: 몇 분마다 (5 이상)" })),
      time: Type.Optional(Type.String({ description: "daily: HH:MM (이 PC의 시간대)" })),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const now = new Date();
      const input = { kind: params.kind as ScheduleKind, at: params.at, minutes: params.minutes, time: params.time };
      const invalid = invalidReason(input, now);
      if (invalid) throw new Error(invalid);
      const created: Schedule = {
        id: newScheduleId(now),
        title: params.title.trim() || "예약",
        instruction: params.instruction,
        cwd: ctx.cwd,
        ...input,
        enabled: true,
        nextRun: firstRun(input, now)?.toISOString(),
        provider: ctx.model?.provider,
        model: ctx.model?.id,
        createdAt: now.toISOString(),
      };
      await updateSchedules(path, (all) => [...all, created]);
      return {
        content: [{ type: "text", text: `예약 ${created.id}(${created.title}, ${describeSchedule(created)})를 등록했다. 다음 실행: ${created.nextRun}` }],
        details: created,
      };
    },
  });

  pi.registerTool({
    name: "list_schedules",
    label: "예약 목록",
    description: "등록된 예약과 다음 실행 시각을 본다.",
    parameters: Type.Object({}),
    async execute() {
      const all = await loadSchedules(path);
      const text =
        all.length === 0
          ? "예약이 없다."
          : all.map((s) => `- ${s.id} [${s.enabled ? "켜짐" : "꺼짐"}] ${s.title} — ${describeSchedule(s)}, 다음: ${s.nextRun ?? "없음"}`).join("\n");
      return { content: [{ type: "text", text }], details: { count: all.length } };
    },
  });

  pi.registerTool({
    name: "cancel_schedule",
    label: "예약 지우기",
    description: "예약을 지운다.",
    parameters: Type.Object({ id: Type.String({ description: "지울 예약 id" }) }),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      let found = false;
      await updateSchedules(path, (all) => all.filter((s) => (s.id === params.id ? ((found = true), false) : true)));
      if (!found) throw new Error(`그런 예약이 없다: ${params.id}`);
      return { content: [{ type: "text", text: `예약 ${params.id}를 지웠다.` }], details: { id: params.id } };
    },
  });
}

function runScheduler(pi: ExtensionAPI, dir: string, path: string): void {
  const tasks = tasksDir(dir);
  const running = new Set<string>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let fallbackModel: { provider?: string; model?: string } = {};

  const tick = async () => {
    const now = new Date();
    const due = dueSchedules(await loadSchedules(path), now).filter((s) => !running.has(s.id));
    for (const schedule of due.slice(0, Math.max(0, MAX_RUNNING - running.size))) {
      const taskId = newTaskId(now);
      await updateSchedules(path, (all) => all.map((s) => (s.id === schedule.id ? markStarted(s, now, taskId) : s)));
      running.add(schedule.id);
      const record: TaskRecord = {
        id: taskId,
        title: schedule.title,
        instruction: schedule.instruction,
        origin: "schedule",
        status: "running",
        cwd: schedule.cwd,
        startedAt: now.toISOString(),
      };
      await saveTask(tasks, record);
      runWorker({
        label: `예약 ${schedule.title}`,
        prompt: schedule.instruction,
        cwd: schedule.cwd,
        provider: schedule.provider ?? fallbackModel.provider,
        model: schedule.model ?? fallbackModel.model,
      })
        .then((result) => {
          record.status = "done";
          record.result = result.text;
        })
        .catch((error: unknown) => {
          record.status = "failed";
          record.error = error instanceof Error ? error.message : String(error);
        })
        .finally(async () => {
          record.finishedAt = new Date().toISOString();
          running.delete(schedule.id);
          await saveTask(tasks, record);
        });
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    fallbackModel = { provider: ctx.model?.provider, model: ctx.model?.id };
    const tickMs = Number(process.env.PI_DESKTOP_AGENT_SCHEDULER_TICK_MS) || DEFAULT_TICK_MS;
    timer = setInterval(() => void tick().catch(() => undefined), tickMs);
    void tick().catch(() => undefined);
  });

  pi.on("session_shutdown", async () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  });
}
