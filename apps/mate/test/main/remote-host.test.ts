import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { prepareRemote } from "@pi-desktop/host-deploy";
import { mateRemoteApp } from "../../src/main/hosts";
import { RunnerConnection } from "../../src/main/runner-connection";
import { startMockLlm, type MockLlm } from "../../../../packages/host-agent/test/fixtures/mock-llm";

/**
 * 원격 호스트 흉내 (설계 DESIGN-MATE-REMOTE.md §7): 이 PC의 sh를 원격 셸로, HOME을 임시 폴더로 바꿔
 * 실행기 번들과 mate-kit·pi-isolation을 올리고, connect로 붙어 임무를 실제 Pi(mock 모델)로 돌린다.
 */
const repo = resolve(__dirname, "../../../..");
const runnerScript = join(repo, "packages/mate-runner/dist/mate-runner.mjs");
const kitDir = join(repo, "packages/mate-kit");
const piCli = join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");

describe.skipIf(process.platform === "win32" || !existsSync(runnerScript))("원격 호스트 (sh로 흉내)", () => {
  const home = mkdtempSync(join(tmpdir(), "mate-remote-home-"));
  const piDir = mkdtempSync(join(tmpdir(), "mate-remote-pi-"));
  /** "원격" 셸의 환경: HOME과 그 호스트의 Pi 위치·설정 */
  const remoteEnv = { ...process.env, HOME: home, PI_DESKTOP_PI_CLI: piCli, PI_CODING_AGENT_DIR: piDir, PI_DESKTOP_DAEMON_SPAWN: "direct" };
  let llm: MockLlm | undefined;
  let connection: RunnerConnection | undefined;

  const run = (script: string, input?: Buffer) =>
    new Promise<string>((done, fail) => {
      const child = spawn("sh", ["-c", script], { env: remoteEnv, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
      child.stderr.on("data", (c: Buffer) => (err += c.toString("utf8")));
      child.on("exit", (code) => (code === 0 ? done(out) : fail(new Error(err))));
      child.stdin.end(input);
    });

  afterAll(async () => {
    await connection?.call("stopRunner").catch(() => undefined);
    connection?.dispose();
    await llm?.close();
  });

  it("실행기·kit을 올리고 connect로 붙어, 임무가 그 호스트의 Mate 홈에서 돈다", async () => {
    llm = await startMockLlm();
    writeFileSync(join(piDir, "models.json"), JSON.stringify({ providers: { mock: { baseUrl: llm.baseUrl, api: "openai-completions", apiKey: "mock", models: [{ id: "mock-model" }] } } }));
    const prepared = await prepareRemote("흉내", run, (script) => ({ command: "sh", args: ["-c", script] }), "", mateRemoteApp({ runnerScript, version: "0.0.0", kitDir }));
    expect(prepared.placed.appHome).toBe(`${home}/.pi-desktop-mate`);
    expect(existsSync(join(prepared.placed.kitBase, "mate-kit", "extensions", "mate-guard", "index.ts"))).toBe(true);
    expect(existsSync(join(prepared.placed.kitBase, "pi-isolation", "extensions", "context.ts"))).toBe(true);

    connection = new RunnerConnection({
      launch: async () => ({ command: prepared.spec.command, args: prepared.spec.args, env: remoteEnv }),
      onChanged: () => {},
    });
    connection.start();
    const overview = await connection.call<{ home: string }>("overview");
    expect(overview.home).toBe(`${home}/.pi-desktop-mate`);

    await connection.call("saveConfig", { model: "mock/mock-model" });
    const duty = await connection.call<{ id: string }>("saveDuty", { name: "원격 시험", enabled: true, cwd: home, prompt: "안녕", profile: "observe", trigger: { kind: "manual" } });
    await connection.call("runNow", duty.id);
    let summary: string | undefined;
    for (let i = 0; i < 120 && !summary; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const runs = (await connection.call<{ runs: Array<{ dutyId: string; status: string; summary?: string }> }>("overview")).runs;
      const done = runs.find((r) => r.dutyId === duty.id && r.status !== "running");
      if (done) summary = `${done.status}: ${done.summary ?? ""}`;
    }
    expect(summary).toBe("done: echo: 안녕");
    // 실행 세션은 그 호스트의 Mate 홈에 남는다
    expect(readdirSync(join(home, ".pi-desktop-mate", "sessions")).length).toBeGreaterThan(0);
  }, 120_000);
});
