import { execFile } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { RunnerConnection, type RunnerConnectionState } from "../../src/main/runner-connection";

/**
 * 앱 ↔ 실행기 연결 (설계 DESIGN-MATE-REMOTE.md §2): 번들된 실행기를 실제로 띄워 붙고,
 * 바뀌었다는 알림을 받고, 실행기를 멈추면 다시 띄워 붙는지 본다.
 */
const script = resolve(__dirname, "../../../../packages/mate-runner/dist/mate-runner.mjs");
const home = mkdtempSync(join(tmpdir(), "mate-conn-"));
const env = { ...process.env, MATE_HOME: home, PI_DESKTOP_MATE_KIT: resolve(__dirname, "../../../../packages/mate-kit"), PI_DESKTOP_DAEMON_SPAWN: "direct" };

const runner = (command: string) => new Promise<void>((done) => execFile(process.execPath, [script, command], { env }, () => done()));
const until = async (check: () => boolean, ms = 20_000) => {
  for (const end = Date.now() + ms; Date.now() < end && !check(); ) await new Promise((r) => setTimeout(r, 100));
  return check();
};

describe.skipIf(!existsSync(script))("RunnerConnection", () => {
  const states: RunnerConnectionState["status"][] = [];
  let changes = 0;
  const connection = new RunnerConnection({
    launch: async () => ({ command: process.execPath, args: [script, "connect"], env }),
    onChanged: () => changes++,
    onState: (state) => states.push(state.status),
  });

  afterAll(async () => {
    connection.dispose();
    await runner("stop");
  });

  it("붙어서 부르고, 바뀌면 알림을 받고, 실행기가 멈추면 다시 띄워 붙는다", async () => {
    connection.start();
    const overview = await connection.call<{ home: string }>("overview");
    expect(overview.home).toBe(home);
    expect(states).toContain("connected");

    const before = changes;
    await connection.call("saveDuty", { name: "확인", enabled: true, cwd: home, prompt: "봐", profile: "observe", trigger: { kind: "manual" } });
    expect(await until(() => changes > before)).toBe(true);

    await runner("stop");
    expect(await until(() => states.includes("disconnected"))).toBe(true);
    // 다시 붙으면 connect가 실행기를 새로 띄운다
    const again = await connection.call<{ duties: unknown[] }>("overview");
    expect(again.duties).toHaveLength(1);
  }, 60_000);

  it("끝낸 뒤에는 상태 알림을 보내지 않는다 (앱을 닫을 때 창이 이미 없을 수 있다)", async () => {
    const count = states.length;
    connection.dispose();
    await new Promise((r) => setTimeout(r, 1000));
    expect(states.length).toBe(count);
  });
});
