import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createJsonlReader, encodeJsonl, JsonRpcPeer, Methods, Notifications, type SessionOpenResult, type StoredSession } from "@pi-desktop/host-protocol";
import { prepareRemote } from "@pi-desktop/host-deploy";
import { agentRemoteApp, hostPathsOf } from "../src/main/hosts";
import { sessionParamsFor, sessionsDirFor } from "../src/main/host-session";
import { startMockLlm, type MockLlm } from "../../../packages/host-agent/test/fixtures/mock-llm";
import { PI_CLI } from "../../../packages/host-agent/test/helpers/real-pi";

/**
 * 원격 호스트 흉내 (설계 DESIGN-APPS.md §6 D3): 이 PC의 sh를 원격 셸로, HOME을 임시 폴더로 바꿔
 * Host Agent·kit을 올리고, 그 데몬에 원격 경로로 세션을 열어 대화가 "원격" Agent 홈에 남는지 본다.
 */
const repo = resolve(__dirname, "../../..");
const agentScript = join(repo, "packages/host-agent/dist/host-agent.mjs");
const kitDir = join(repo, "packages/agent-kit");
const isolationDir = join(repo, "packages/pi-isolation");

function run(home: string, script: string, input?: Buffer): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn("sh", ["-c", script], { env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (err += c.toString("utf8")));
    child.on("exit", (code) => (code === 0 ? done(out) : fail(new Error(err))));
    child.stdin.end(input);
  });
}

describe.skipIf(process.platform === "win32" || !existsSync(agentScript))("원격 호스트 (sh로 흉내)", () => {
  let llm: MockLlm | undefined;
  let child: ChildProcessWithoutNullStreams | undefined;
  let peer: JsonRpcPeer | undefined;

  afterAll(async () => {
    await peer?.request(Methods.daemonShutdown).catch(() => undefined);
    child?.kill();
    await llm?.close();
  });

  it("Host Agent·kit을 올리고 Agent 홈으로 데몬에 붙어, 원격 경로로 연 대화가 그 홈에 남는다", async () => {
    const home = mkdtempSync(join(tmpdir(), "agent-remote-home-"));
    const remote = await prepareRemote(
      "흉내",
      (script, input) => run(home, script, input),
      (script) => ({ command: "sh", args: ["-c", script] }),
      "",
      agentRemoteApp({ agentScript, agentVersion: "0.0.0", kitDir, isolationDir }),
    );
    const prepared = { spec: remote.spec, paths: hostPathsOf(remote.placed) };
    expect(prepared.paths).toMatchObject({ remote: true, home: `${home}/.pi-desktop-agent`, userHome: home });
    expect(existsSync(join(prepared.paths.kitDir, "extensions/agent-core/index.ts"))).toBe(true);
    expect(prepared.spec.args.join(" ")).toContain("PI_DESKTOP_HOME=");

    llm = await startMockLlm();
    const piDir = mkdtempSync(join(tmpdir(), "agent-remote-pi-"));
    writeFileSync(join(piDir, "models.json"), JSON.stringify({ providers: { mock: { baseUrl: llm.baseUrl, api: "openai-completions", apiKey: "mock", models: [{ id: "mock-model" }] } } }));

    child = spawn(prepared.spec.command, prepared.spec.args, { env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
    const connected = new JsonRpcPeer({ send: (m) => child!.stdin.write(encodeJsonl(m)), defaultTimeoutMs: 30_000 });
    peer = connected;
    const reader = createJsonlReader((r) => connected.receive(r));
    child.stdout.on("data", (c: Buffer) => reader.push(c));
    let settled = false;
    connected.on(Notifications.sessionEvent, (n) => {
      if ((n as { event?: { type?: string } }).event?.type === "agent_settled") settled = true;
    });

    const params = await sessionParamsFor({ paths: prepared.paths, localKitDir: kitDir, cwd: home, extraEnv: { PI_CODING_AGENT_DIR: piDir, PI_DESKTOP_AGENT_LEARN: "0" } });
    const opened = await connected.request<SessionOpenResult>(Methods.sessionOpen, { ...params, piCliPath: PI_CLI, piArgs: ["--provider", "mock", "--model", "mock-model", ...(params.piArgs ?? [])] });
    const sessionId = opened.session.sessionId;
    const commands = await connected.request<{ data: { commands: Array<{ name: string }> } }>(Methods.sessionSend, { sessionId, command: { type: "get_commands" } });
    expect(commands.data.commands.map((c) => c.name)).toContain("agent:status");

    await connected.request(Methods.sessionAttach, { sessionId, lastSeq: 0 });
    await connected.request(Methods.sessionSend, { sessionId, command: { type: "prompt", message: "안녕" } });
    for (let i = 0; i < 300 && !settled; i++) await new Promise((r) => setTimeout(r, 100));
    expect(settled).toBe(true);

    // 대화와 데몬 런타임은 "원격" Agent 홈에 있다
    expect(readdirSync(join(home, ".pi-desktop-agent", "sessions")).length).toBeGreaterThan(0);
    expect(existsSync(join(home, ".pi-desktop-agent", "run"))).toBe(true);
    expect(existsSync(join(home, ".pi-desktop"))).toBe(false);
    const stored = await connected.request<StoredSession[]>(Methods.sessionHistory, { sessionDir: sessionsDirFor(prepared.paths), piCliPath: PI_CLI });
    expect(stored).toHaveLength(1);

    // 기억·스킬 같은 Agent 데이터도 그 호스트의 데몬이 그 Agent 홈에서 다룬다 (D4)
    await connected.request(Methods.agentCall, { name: "kbSave", args: [undefined, { type: "user", title: "원격 기억", content: "그 호스트에 남는다", tags: [] }] });
    expect(existsSync(join(home, ".pi-desktop-agent", "data", "memory"))).toBe(true);
    const list = await connected.request<Array<{ title: string }>>(Methods.agentCall, { name: "kbList", args: [false] });
    expect(list.map((e) => e.title)).toEqual(["원격 기억"]);
  }, 90_000);
});
