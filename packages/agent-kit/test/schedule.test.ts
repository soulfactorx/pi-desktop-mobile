import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeSchedule, dueSchedules, invalidReason, markStarted, nextRunAfter, type Schedule } from "../extensions/schedule/plan";
import { classify } from "../extensions/permissions/rules";
import { startPi, type RpcPi } from "./helpers/rpc-pi";
import { startScriptLlm, type ScriptLlm } from "./helpers/script-llm";

const now = new Date("2026-10-29T10:00:00");
const base: Schedule = { id: "s1", title: "t", instruction: "i", cwd: ".", kind: "interval", minutes: 30, enabled: true, createdAt: "" };

describe("예약 계산", () => {
  it("입력을 검증한다", () => {
    expect(invalidReason({ kind: "once", at: "2026-10-29T09:00:00" }, now)).toContain("지난");
    expect(invalidReason({ kind: "once" }, now)).toContain("at");
    expect(invalidReason({ kind: "interval", minutes: 3 }, now)).toContain("5분");
    expect(invalidReason({ kind: "daily", time: "25:00" }, now)).toContain("HH:MM");
    expect(invalidReason({ kind: "daily", time: "09:30" }, now)).toBeUndefined();
  });

  it("다음 실행 시각", () => {
    expect(nextRunAfter({ kind: "interval", minutes: 30 }, now)?.getTime()).toBe(now.getTime() + 30 * 60_000);
    expect(nextRunAfter({ kind: "daily", time: "09:00" }, now)?.toISOString()).toBe(new Date("2026-10-30T09:00:00").toISOString());
    expect(nextRunAfter({ kind: "daily", time: "11:00" }, now)?.toISOString()).toBe(new Date("2026-10-29T11:00:00").toISOString());
    expect(nextRunAfter({ kind: "once", at: "2026-10-29T09:00:00" }, now)).toBeUndefined();
  });

  it("도래한 것만 고르고, 시작하면 다음 시각으로 옮기고 once는 끈다", () => {
    const past = new Date(now.getTime() - 1000).toISOString();
    const list = [
      { ...base, nextRun: past },
      { ...base, id: "s2", nextRun: new Date(now.getTime() + 60_000).toISOString() },
      { ...base, id: "s3", nextRun: past, enabled: false },
    ];
    expect(dueSchedules(list, now).map((s) => s.id)).toEqual(["s1"]);
    expect(markStarted(list[0]!, now, "t1")).toMatchObject({ lastTaskId: "t1", enabled: true, nextRun: new Date(now.getTime() + 30 * 60_000).toISOString() });
    expect(markStarted({ ...base, kind: "once", at: past }, now, "t2")).toMatchObject({ enabled: false, nextRun: undefined });
    expect(describeSchedule({ kind: "daily", time: "09:00" })).toBe("매일 09:00");
  });

  it("등록은 묻고, 조회·지우기는 묻지 않는다", () => {
    expect(classify("schedule_task", { kind: "daily", time: "09:00", instruction: "메일 요약" }).request).toMatchObject({
      risk: "write",
      target: "매일 09:00: 메일 요약",
    });
    expect(classify("list_schedules", {})).toEqual({ risk: "read" });
  });
});

/** 파일이 생길 때까지 기다린다 (스케줄러는 타이머로 돈다) */
async function waitForFile<T>(read: () => T | undefined, timeoutMs = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error("기다리던 파일이 생기지 않았다");
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe("스케줄러 세션 (실제 Pi + 사람 없는 워커)", () => {
  let llm: ScriptLlm;
  let pi: RpcPi;
  let dataDir: string;

  beforeAll(async () => {
    llm = await startScriptLlm("mock-model");
    llm.route((text) => text.includes("SCHEDULED-JOB"), [{ tool: "bash", args: { command: "echo should-not-run" } }, { text: "예약 결과: 읽기만 했다" }]);
    const due: Schedule = {
      ...base,
      title: "아침 정리",
      instruction: "SCHEDULED-JOB: 정리해서 알려라",
      cwd: tmpdir(),
      kind: "once",
      at: new Date(Date.now() - 60_000).toISOString(),
      nextRun: new Date(Date.now() - 60_000).toISOString(),
    };
    ({ pi, dataDir } = await startPi(llm.baseUrl, {
      env: { PI_DESKTOP_AGENT_SCHEDULER: "1", PI_DESKTOP_AGENT_SCHEDULER_TICK_MS: "300" },
      dataFiles: { "schedules.json": JSON.stringify({ schedules: [due] }) },
    }));
  });

  afterAll(async () => {
    pi?.close();
    await llm?.close();
  });

  it("놓친 예약을 사람 없는 워커로 실행하고 결과를 작업 기록에 남긴다 (쓰기·실행은 거부)", async () => {
    const record = await waitForFile(() => {
      const dir = join(dataDir, "tasks");
      if (!existsSync(dir)) return undefined;
      for (const name of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
        const task = JSON.parse(readFileSync(join(dir, name), "utf8"));
        if (task.status !== "running") return task;
      }
      return undefined;
    });
    expect(record).toMatchObject({ origin: "schedule", title: "아침 정리", status: "done", result: "예약 결과: 읽기만 했다" });

    const schedules = JSON.parse(readFileSync(join(dataDir, "schedules.json"), "utf8")).schedules;
    expect(schedules[0]).toMatchObject({ enabled: false, lastTaskId: record.id });
    const audit = readFileSync(join(dataDir, "audit.jsonl"), "utf8");
    expect(audit).toContain('"decision":"unattended"');
    void pi;
  }, 60_000);
});

describe("schedule_task (실제 Pi)", () => {
  let llm: ScriptLlm;
  let pi: RpcPi;
  let dataDir: string;

  beforeAll(async () => {
    llm = await startScriptLlm("mock-model");
    ({ pi, dataDir } = await startPi(llm.baseUrl));
  });

  afterAll(async () => {
    pi?.close();
    await llm?.close();
  });

  it("승인 뒤 예약을 schedules.json에 등록한다", async () => {
    llm.setScript([{ tool: "schedule_task", args: { title: "점검", instruction: "디스크를 점검", kind: "interval", minutes: 60 } }, { text: "예약했다" }]);
    const from = pi.mark;
    await pi.request({ type: "prompt", message: "한 시간마다 점검해" });
    const asked = await pi.waitFor((r) => r.type === "extension_ui_request" && r.method === "select", from);
    expect(String(asked.title)).toContain("60분마다: 디스크를 점검");
    pi.write({ type: "extension_ui_response", id: asked.id, value: (asked.options as string[])[0] });
    await pi.waitFor((r) => r.type === "agent_settled", from);
    const schedules = JSON.parse(readFileSync(join(dataDir, "schedules.json"), "utf8")).schedules;
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({ title: "점검", kind: "interval", minutes: 60, enabled: true, model: "mock-model" });
    expect(Date.parse(schedules[0].nextRun)).toBeGreaterThan(Date.now() + 55 * 60_000);
  });
});
