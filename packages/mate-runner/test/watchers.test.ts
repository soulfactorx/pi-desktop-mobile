import { describe, expect, it } from "vitest";
import { changeReadyAt, isDue } from "../src/schedule";
import type { Duty, RunnerState, Trigger } from "../src/types";
import { ChangeWatchers, isIgnoredPath, noteFileChange, noteSignature, pollCommandError, watchKey, type Exec } from "../src/watchers";

function duty(trigger: Trigger, id = "d"): Duty {
  return { id, name: id, enabled: true, cwd: "/repo", prompt: "p", profile: "propose", trigger, createdAt: 0 };
}

describe("변화 기록", () => {
  it("처음 본 값은 기준만 잡고, 바뀌면 기다리는 변화가 된다", () => {
    const base = noteSignature({ key: "k" }, "main@a1", "커밋 a1", 1);
    expect(base).toEqual({ key: "k", signature: "main@a1" });
    expect(noteSignature(base, "main@a1", "커밋 a1", 2)).toBe(base);
    const changed = noteSignature(noteSignature(base, "main@b2", "커밋 b2", 3), "main@c3", "커밋 c3", 4);
    expect(changed.pending).toEqual({ since: 3, lastAt: 4, cause: "커밋 c3", count: 2 });
  });

  it("파일 변경은 묶어서 파일 수로 세고 마지막 시각을 늦춘다", () => {
    const once = noteFileChange({ key: "k" }, "src/a.ts", 10);
    expect(once.pending).toEqual({ since: 10, lastAt: 10, cause: "파일 바뀜: src/a.ts", count: 1, files: ["src/a.ts"] });
    // 저장 한 번에 이벤트가 여러 번 와도 같은 파일은 한 번
    const again = noteFileChange(once, "src/a.ts", 15);
    expect(again.pending).toMatchObject({ lastAt: 15, count: 1, cause: "파일 바뀜: src/a.ts" });
    expect(noteFileChange(again, "src/b.ts", 20).pending).toMatchObject({ since: 10, lastAt: 20, cause: "파일 2개 바뀜 (src/a.ts, src/b.ts)", count: 2 });
    let many = again;
    for (const f of ["b", "c", "d"]) many = noteFileChange(many, `${f}.ts`, 30);
    expect(many.pending?.cause).toBe("파일 4개 바뀜 (src/a.ts, b.ts, c.ts 등)");
  });

  it("빌드 결과·의존성·.git은 파일 변경으로 보지 않는다", () => {
    expect(isIgnoredPath(".git/index")).toBe(true);
    expect(isIgnoredPath("packages\\a\\node_modules\\x.js")).toBe(true);
    expect(isIgnoredPath("apps/mate/out/main/index.js")).toBe(true);
    expect(isIgnoredPath("src/outline.ts")).toBe(false);
  });

  it("확인 명령은 읽기 허용 목록을 통과하는 명령 하나만", () => {
    expect(pollCommandError("gh run list --limit 5")).toBeUndefined();
    expect(pollCommandError("git log -1 | head")).toMatch(/하나만/);
    expect(pollCommandError("npm install")).toMatch(/허용 목록/);
  });
});

describe("변화 계기의 실행 시각", () => {
  const pending = (lastAt: number) => ({ key: "k", pending: { since: lastAt, lastAt, cause: "c", count: 1 } });

  it("기다리는 변화가 없으면 돌지 않는다", () => {
    expect(isDue(duty({ kind: "git" }), undefined, 1e9, { key: "k", signature: "x" })).toBe(false);
  });

  it("git: 마지막 실행 뒤 쉬는 시간(기본 15분)이 지나야", () => {
    const t: Trigger = { kind: "git", cooldownMinutes: 15 };
    expect(changeReadyAt(t, undefined, pending(100))).toBe(100);
    expect(changeReadyAt(t, 0, pending(100))).toBe(15 * 60_000);
    expect(isDue(duty(t), 0, 15 * 60_000 - 1, pending(100))).toBe(false);
    expect(isDue(duty(t), 0, 15 * 60_000, pending(100))).toBe(true);
  });

  it("files: 마지막 변경 뒤 잠잠해야", () => {
    const t: Trigger = { kind: "files", quietSeconds: 60, cooldownMinutes: 5 };
    expect(changeReadyAt(t, undefined, pending(1_000))).toBe(61_000);
  });
});

describe("ChangeWatchers.refresh", () => {
  function fakeExec(outputs: Record<string, string>): Exec & { calls: string[] } {
    const calls: string[] = [];
    const exec: Exec = async (command, args) => {
      const key = [command, ...args].join(" ");
      calls.push(key);
      return { code: 0, stdout: outputs[key] ?? "" };
    };
    return Object.assign(exec, { calls });
  }

  it("git: 커밋이 바뀌면 기다리는 변화로 기록한다", async () => {
    const outputs: Record<string, string> = { "git rev-parse --short HEAD": "a1\n", "git rev-parse --abbrev-ref HEAD": "main\n" };
    const watchers = new ChangeWatchers(fakeExec(outputs));
    const state: RunnerState = { duties: {}, today: { date: "", count: 0 } };
    const duties = [duty({ kind: "git" })];
    await watchers.refresh(duties, () => state, 1);
    expect(state.duties.d?.watch).toEqual({ key: watchKey(duties[0]!), signature: "main@a1" });
    outputs["git rev-parse --short HEAD"] = "b2\n";
    await watchers.refresh(duties, () => state, 2);
    expect(state.duties.d?.watch?.pending).toMatchObject({ cause: "커밋 b2 (main)", lastAt: 2 });
  });

  it("poll: 간격마다만 명령을 돌리고, 계기가 바뀌면 기준을 다시 잡는다", async () => {
    const exec = fakeExec({ "gh run list": "ok" });
    const watchers = new ChangeWatchers(exec);
    const state: RunnerState = { duties: {}, today: { date: "", count: 0 } };
    const poll = duty({ kind: "poll", command: "gh run list", minutes: 15 });
    await watchers.refresh([poll], () => state, 0);
    await watchers.refresh([poll], () => state, 60_000);
    expect(exec.calls).toEqual(["gh run list"]);
    await watchers.refresh([poll], () => state, 15 * 60_000);
    expect(exec.calls).toHaveLength(2);
    expect(state.duties.d?.watch?.pending).toBeUndefined();

    state.duties.d!.watch!.pending = { since: 1, lastAt: 1, cause: "x", count: 1 };
    await watchers.refresh([{ ...poll, trigger: { kind: "git" } }], () => state, 16 * 60_000);
    expect(state.duties.d?.watch?.pending).toBeUndefined();
    await watchers.refresh([], () => state, 17 * 60_000);
    expect(state.duties.d?.watch).toBeUndefined();
  });
});
