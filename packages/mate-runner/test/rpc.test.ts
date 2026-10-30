import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createJsonlReader, encodeJsonl, JsonRpcPeer } from "@pi-desktop/host-protocol";
import type { Overview } from "../src/view-types";

/**
 * 앱이 실행기에 붙는 길 (설계 DESIGN-MATE-REMOTE.md §2): mate-runner connect → 실행기 소켓 → mate.call.
 * 번들된 실행기(dist/mate-runner.mjs)를 실제로 띄운다. 테스트 전에 npm run build가 돈다.
 */
const script = resolve(__dirname, "../dist/mate-runner.mjs");
const home = mkdtempSync(join(tmpdir(), "mate-rpc-"));
/** 가짜 텔레그램: 받은 요청 경로만 남기고 빈 결과를 돌려준다 */
const telegramPaths: string[] = [];
const telegram: Server = createServer((req, res) => {
  telegramPaths.push(req.url ?? "");
  req.resume().on("end", () => res.end(JSON.stringify({ ok: true, result: req.url?.endsWith("/getMe") ? { username: "t" } : [] })));
});
const env: NodeJS.ProcessEnv = { ...process.env, MATE_HOME: home, PI_DESKTOP_MATE_KIT: resolve(__dirname, "../../mate-kit"), PI_DESKTOP_DAEMON_SPAWN: "direct" };
const TOKEN = "123456789:SECRET_token_only_in_memory_xyz";

/** Mate 홈의 모든 파일 내용에 이 글이 있는가 */
function homeContains(text: string, dir = home): boolean {
  return readdirSync(dir).some((name) => {
    const file = join(dir, name);
    try {
      const stat = statSync(file);
      if (stat.isDirectory()) return homeContains(text, file);
      return stat.isFile() && readFileSync(file, "utf8").includes(text);
    } catch {
      return false; // 그새 바뀐 임시 파일
    }
  });
}

function runnerCommand(command: string): Promise<string> {
  return new Promise((done) => execFile(process.execPath, [script, command], { env }, (_e, stdout) => done(stdout)));
}

describe("실행기 JSON-RPC (connect)", () => {
  let child: ChildProcessWithoutNullStreams;
  let peer: JsonRpcPeer;
  let changes = 0;
  const call = <T>(name: string, ...args: unknown[]) => peer.request<T>("mate.call", { name, args });

  beforeAll(async () => {
    await new Promise<void>((r) => telegram.listen(0, "127.0.0.1", r));
    env.PI_DESKTOP_MATE_TELEGRAM_API = `http://127.0.0.1:${(telegram.address() as AddressInfo).port}`;
    child = spawn(process.execPath, [script, "connect"], { env, stdio: ["pipe", "pipe", "pipe"] });
    peer = new JsonRpcPeer({ send: (m) => child.stdin.write(encodeJsonl(m)), defaultTimeoutMs: 20_000 });
    const reader = createJsonlReader((r) => peer.receive(r));
    child.stdout.on("data", (c: Buffer) => reader.push(c));
    peer.on("mate.changed", () => changes++);
  });

  afterAll(async () => {
    child?.kill();
    await runnerCommand("stop");
    telegram.close();
  });

  it("실행기를 띄우고 붙어 overview를 받는다", async () => {
    const overview = await call<Overview>("overview");
    expect(overview.home).toBe(home);
    expect(overview.runner).toMatchObject({ alive: true });
    expect(overview.duties).toEqual([]);
  }, 30_000);

  it("임무를 만들면 Mate 홈에 남고 바뀌었다는 알림이 온다", async () => {
    const before = changes;
    const duty = await call<{ id: string }>("saveDuty", { name: "CI 확인", enabled: true, cwd: home, prompt: "봐", profile: "observe", trigger: { kind: "manual" } });
    expect((await call<Overview>("overview")).duties.map((d) => d.id)).toEqual([duty.id]);
    for (let i = 0; i < 50 && changes === before; i++) await new Promise((r) => setTimeout(r, 100));
    expect(changes).toBeGreaterThan(before);
    expect(await call("deleteDuty", duty.id)).toBeNull();
    expect((await call<Overview>("overview")).trash.map((t) => t.kind)).toEqual(["duty"]);
  });

  it("모르는 이름이나 Object 원형의 이름은 거절한다", async () => {
    await expect(call("nope")).rejects.toThrow(/모르는 Mate 함수/);
    await expect(call("constructor")).rejects.toThrow(/모르는 Mate 함수/);
  });

  it("휴대폰 토큰을 RPC로 받으면 메모리에만 두고 연결을 켜고, null이면 끈다 (원격 호스트)", async () => {
    expect((await call<Overview>("overview")).runner.phone).toBe(false);
    // 앱이 토큰을 저장하면 설정의 휴대폰 연결이 켜진다 (설정에는 암호화된 토큰만)
    await call("saveConfig", { telegram: { enabled: true } });
    expect(await call("setTelegramToken", TOKEN)).toBeNull();
    expect((await call<Overview>("overview")).runner.phone).toBe(true);
    for (let i = 0; i < 50 && !telegramPaths.some((p) => p === `/bot${TOKEN}/getUpdates`); i++) await new Promise((r) => setTimeout(r, 100));
    expect(telegramPaths).toContain(`/bot${TOKEN}/getUpdates`);
    expect(homeContains(TOKEN)).toBe(false);
    await expect(call("setTelegramToken", 42)).rejects.toThrow(/글자/);
    expect(await call("setTelegramToken", null)).toBeNull();
    expect((await call<Overview>("overview")).runner.phone).toBe(false);
    await call("setTelegramToken", TOKEN);
  });

  it("stopRunner로 실행기가 스스로 멈춘다", async () => {
    const { pid } = (await call<Overview>("overview")).runner;
    expect(await call("stopRunner")).toBeNull();
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        process.kill(pid!, 0);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  it("다시 뜬 실행기는 앱이 토큰을 다시 넘길 때까지 휴대폰 연결이 쉰다", async () => {
    child.kill();
    child = spawn(process.execPath, [script, "connect"], { env, stdio: ["pipe", "pipe", "pipe"] });
    peer = new JsonRpcPeer({ send: (m) => child.stdin.write(encodeJsonl(m)), defaultTimeoutMs: 20_000 });
    const reader = createJsonlReader((r) => peer.receive(r));
    child.stdout.on("data", (c: Buffer) => reader.push(c));
    expect((await call<Overview>("overview")).runner).toMatchObject({ alive: true, phone: false });
  }, 30_000);
});
