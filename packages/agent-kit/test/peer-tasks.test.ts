import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APPROVAL_MARKER, ApprovalChoice, parseApprovalTitle } from "../src/approval";
import { classify, confinementViolation, insideRoot } from "../extensions/permissions/rules";
import { startPeerServer } from "../extensions/peers/server";
import { saveCardDraft, savePeerSettings, savePeers, type Peer } from "../extensions/peers/store";
import {
  applyRemote,
  approvePeerTask,
  cancelRemoteTask,
  delegateToPeer,
  findPeerTask,
  peerTaskPrompt,
  refreshRemoteTask,
  rejectPeerTask,
  taskView,
} from "../extensions/peers/tasks";
import { loadTasks, saveTask, tasksDir, type TaskRecord } from "../extensions/tasks/store";
import { startPi, type RpcPi, type RpcRecord } from "./helpers/rpc-pi";
import { startScriptLlm, type ScriptLlm } from "./helpers/script-llm";

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });

const policy = { question: "auto" as const, dailyLimit: 50 };

/** A(맡기는 쪽)와 B(받는 쪽)를 서로의 피어로 맺어 둔다. B는 수신 서버를 띄운다 */
async function pair(bServer = true) {
  const a = mkdtempSync(join(tmpdir(), "ptask-a-"));
  const b = mkdtempSync(join(tmpdir(), "ptask-b-"));
  const port = await freePort();
  const bAddress = `http://127.0.0.1:${port}`;
  const aPeerOfB: Peer = { id: "peer-b", name: "비", address: bAddress, theirToken: "token-a-calls-b-000000", myToken: "token-b-calls-a-000000", policy, pairedAt: "" };
  const bPeerOfA: Peer = { id: "peer-a", name: "에이", address: "http://127.0.0.1:9", theirToken: "token-b-calls-a-000000", myToken: "token-a-calls-b-000000", policy, pairedAt: "" };
  await savePeers(a, [aPeerOfB]);
  await savePeers(b, [bPeerOfA]);
  await saveCardDraft(b, { name: "비", description: "", skills: [] });
  await savePeerSettings(b, { enabled: true, port, advertise: bAddress });
  const server = bServer ? await startPeerServer({ dataDir: b, answer: async () => "답" }, port, "127.0.0.1") : undefined;
  return { a, b, port, bAddress, aPeerOfB, bPeerOfA, server };
}

const tasksOf = (dir: string) => loadTasks(tasksDir(dir));

describe("받은 작업을 폴더에 가두기", () => {
  it("폴더 안·밖 판정 (Windows는 대소문자 무시)", () => {
    expect(insideRoot("C:\\work\\a\\b.txt", "C:\\Work\\A", "win32")).toBe(true);
    expect(insideRoot("C:\\work\\ab.txt", "C:\\work\\a", "win32")).toBe(false);
    expect(insideRoot("/w/a/../b", "/w/a", "linux")).toBe(false);
  });

  it("경로 도구는 폴더 밖이면 막고, 경로가 없으면 작업 폴더로 본다. 기억은 바꾸지 못한다", () => {
    const root = join(tmpdir(), "confine-root");
    expect(confinementViolation("read", { path: "inside.txt" }, root, root)).toBeUndefined();
    expect(confinementViolation("read", { path: join(tmpdir(), "secret.txt") }, root, root)).toMatch(/밖을 읽거나 쓸 수 없다/);
    expect(confinementViolation("grep", { pattern: "x" }, root, root)).toBeUndefined();
    expect(confinementViolation("grep", { pattern: "x" }, tmpdir(), root)).toMatch(/밖/);
    expect(confinementViolation("process_document", { path: "a.md", output: "../out.md" }, root, root)).toMatch(/밖/);
    expect(confinementViolation("memory_save", { kind: "fact", text: "x" }, root, root)).toMatch(/기억/);
    expect(confinementViolation("bash", { command: "ls" }, root, root)).toBeUndefined();
  });

  it("delegate_to_peer는 제목과 지시를 보이고 피어 단위로 묻는다", () => {
    expect(classify("delegate_to_peer", { peer: "비", title: "정리", instruction: "폴더 정리" }).request).toMatchObject({
      risk: "network",
      summary: "피어에게 작업 맡기기",
      target: "비: 정리\n폴더 정리",
      pattern: "비:*",
    });
  });
});

describe("피어 작업 맡기기 (두 에이전트, 실제 HTTP)", () => {
  const servers: Server[] = [];
  afterAll(() => {
    for (const s of servers) s?.close();
  });

  it("맡기면 상대에 '승인 기다림'으로 쌓이고, 승인·완료되면 맡긴 쪽이 결과를 가져온다", async () => {
    const env = await pair();
    servers.push(env.server!);
    const mine = await delegateToPeer(env.a, env.aPeerOfB, "보고서 정리", "report.md를 세 줄로 요약", ["에이"], "C:/work");
    expect(mine).toMatchObject({ origin: "peer-out", status: "waiting", peer: { id: "peer-b", name: "비" } });

    const [theirs] = await tasksOf(env.b);
    expect(theirs).toMatchObject({ origin: "peer-in", status: "waiting", approval: "pending", title: "보고서 정리", instruction: "report.md를 세 줄로 요약", peer: { name: "에이" } });
    expect(mine.peer?.remoteId).toBe(theirs!.id);
    // 아직 그대로라 기록을 바꾸지 않는다
    expect(await refreshRemoteTask(env.a, mine, [env.aPeerOfB])).toBeUndefined();

    await approvePeerTask(env.b, theirs!.id, "C:/shared");
    await saveTask(tasksDir(env.b), { ...(await findPeerTask(env.b, "peer-a", theirs!.id))!, status: "running" });
    expect((await refreshRemoteTask(env.a, mine, [env.aPeerOfB]))?.status).toBe("running");
    await saveTask(tasksDir(env.b), { ...(await findPeerTask(env.b, "peer-a", theirs!.id))!, status: "done", result: "세 줄 요약" });
    const done = (await tasksOf(env.a))[0]!;
    expect(await refreshRemoteTask(env.a, done, [env.aPeerOfB])).toMatchObject({ status: "done", result: "세 줄 요약" });
  });

  it("기다리는 중에 취소하면 양쪽이 취소, 거절하면 맡긴 쪽에 거절로 남는다", async () => {
    const env = await pair();
    servers.push(env.server!);
    const first = await delegateToPeer(env.a, env.aPeerOfB, "하나", "지시", ["에이"], "C:/w");
    expect(await cancelRemoteTask(env.a, first, [env.aPeerOfB])).toMatchObject({ status: "cancelled" });
    expect((await findPeerTask(env.b, "peer-a", first.peer!.remoteId!))?.status).toBe("cancelled");

    const second = await delegateToPeer(env.a, env.aPeerOfB, "둘", "지시", ["에이"], "C:/w");
    await rejectPeerTask(env.b, second.peer!.remoteId!);
    expect(await refreshRemoteTask(env.a, second, [env.aPeerOfB])).toMatchObject({ status: "cancelled", error: "비이(가) 작업을 거절했다" });
  });

  it("작업 받기를 끈 피어는 거절되고, 다른 피어의 작업은 보이지 않는다", async () => {
    const env = await pair();
    servers.push(env.server!);
    await savePeers(env.b, [{ ...env.bPeerOfA, policy: { ...policy, task: "deny" } }]);
    await expect(delegateToPeer(env.a, env.aPeerOfB, "x", "y", ["에이"], "C:/w")).rejects.toThrow(/작업을 받지 않는다/);
    const other: TaskRecord = { id: "t-other", title: "t", instruction: "i", origin: "peer-in", status: "waiting", cwd: "", startedAt: "", peer: { id: "peer-z", name: "제트" }, approval: "pending" };
    await saveTask(tasksDir(env.b), other);
    expect(await findPeerTask(env.b, "peer-a", "t-other")).toBeUndefined();
  });

  it("상태 옮기기와 워커 지시", () => {
    const base: TaskRecord = { id: "t", title: "t", instruction: "i", origin: "peer-in", status: "waiting", cwd: "C:/w", startedAt: "", peer: { id: "p", name: "에이" } };
    expect(taskView(base).state).toBe("submitted");
    expect(taskView({ ...base, status: "failed", error: "e" })).toEqual({ id: "t", state: "failed", text: "e" });
    expect(applyRemote({ ...base, origin: "peer-out" }, { id: "x", state: "working" }).status).toBe("running");
    expect(peerTaskPrompt(base)).toContain("폴더 C:/w 안에서");
  });
});

describe("피어 작업 맡기기 (실제 Pi)", () => {
  let llm: ScriptLlm;
  const started: RpcPi[] = [];
  const servers: Server[] = [];

  beforeAll(async () => {
    llm = await startScriptLlm("mock-model");
  });

  afterAll(async () => {
    for (const pi of started) pi.close();
    for (const s of servers) s.close();
    await llm?.close();
  });

  it("받는 쪽 스케줄러: 승인된 작업만 폴더에 갇힌 워커로 돌리고, 폴더 밖 읽기는 막는다", async () => {
    const env = await pair(false);
    const { pi, dataDir } = await startPi(llm.baseUrl, {
      env: { PI_DESKTOP_AGENT_SCHEDULER: "1", PI_DESKTOP_AGENT_UNATTENDED: "1", PI_DESKTOP_AGENT_PEER_SYNC_MS: "200", PI_DESKTOP_AGENT_SCHEDULER_TICK_MS: "60000" },
    });
    started.push(pi);
    // 스케줄러 Pi의 데이터 폴더를 B로 꾸민다
    mkdirSync(join(dataDir, "peers"), { recursive: true });
    await savePeers(dataDir, [env.bPeerOfA]);
    await saveCardDraft(dataDir, { name: "비", description: "", skills: [] });
    await savePeerSettings(dataDir, { enabled: true, port: env.port, advertise: env.bAddress });
    await pi.request({ type: "get_state" });

    const work = mkdtempSync(join(tmpdir(), "ptask-work-"));
    writeFileSync(join(work, "inside.txt"), "안의 내용");
    const outside = join(mkdtempSync(join(tmpdir(), "ptask-secret-")), "secret.txt");
    writeFileSync(outside, "비밀");

    llm.route(
      (text) => text.includes("맡긴 작업이다") && text.includes("PEER-TASK-1"),
      [{ tool: "read", args: { path: outside } }, { tool: "read", args: { path: "inside.txt" } }, { text: "결과: 안의 내용을 읽었다" }],
    );
    let mine: TaskRecord | undefined;
    for (let i = 0; i < 50 && !mine; i++) {
      mine = await delegateToPeer(env.a, env.aPeerOfB, "읽기", "PEER-TASK-1 inside.txt를 읽어라", ["에이"], "C:/w").catch(() => undefined);
      if (!mine) await new Promise((r) => setTimeout(r, 200));
    }
    expect(mine).toBeDefined();
    // 승인 전에는 시작하지 않는다
    await new Promise((r) => setTimeout(r, 600));
    expect((await tasksOf(dataDir))[0]).toMatchObject({ status: "waiting" });

    await approvePeerTask(dataDir, mine!.peer!.remoteId!, work);
    let finished: TaskRecord | undefined;
    /** 끝나지 않으면 어디서 멈췄는지 보이도록 마지막으로 본 양쪽 기록 */
    let last: { mine?: TaskRecord; theirs?: TaskRecord } = {};
    // CI(특히 Windows)에서는 워커 Pi가 뜨는 데 오래 걸린다
    for (let i = 0; i < 400 && !finished; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const mine = await refreshRemoteTask(env.a, (await tasksOf(env.a))[0]!, [env.aPeerOfB]);
      last = { ...(mine ? { mine } : {}), theirs: (await tasksOf(dataDir))[0] };
      if (mine?.status === "done") finished = mine;
    }
    expect(finished, `끝나지 않음: ${JSON.stringify(last)}`).toMatchObject({ status: "done", result: "결과: 안의 내용을 읽었다" });
    // 같은 승인 작업에 워커를 한 번만 띄운다 (주기 동기화가 겹쳐도)
    expect((await tasksOf(dataDir)).filter((t) => t.origin === "peer-in")).toHaveLength(1);
    const audit = readFileSync(join(dataDir, "audit.jsonl"), "utf8");
    expect(audit).toContain('"decision":"blocked"');
    expect(audit).toContain("secret.txt");
  }, 120_000);

  it("맡기는 쪽 대화: delegate_to_peer는 승인 후 맡기고, 끝나면 [작업 알림]이 들어온다", async () => {
    const env = await pair();
    servers.push(env.server!);
    const { pi, dataDir } = await startPi(llm.baseUrl, { env: { PI_DESKTOP_AGENT_PEER_TASK_POLL_MS: "200" } });
    started.push(pi);
    mkdirSync(join(dataDir, "peers"), { recursive: true });
    await savePeers(dataDir, [env.aPeerOfB]);

    llm.setScript([{ tool: "delegate_to_peer", args: { peer: "비", title: "정리", instruction: "DELEGATE-2 폴더를 정리해" } }, { text: "맡겼어" }, { text: "결과 받았어" }]);
    const from = pi.mark;
    await pi.request({ type: "prompt", message: "비에게 정리를 맡겨" });
    const isApproval = (r: RpcRecord) => r.type === "extension_ui_request" && r.method === "select" && String(r.title).startsWith(APPROVAL_MARKER);
    const approval = await pi.waitFor(isApproval, from);
    expect(parseApprovalTitle(String(approval.title))).toMatchObject({ toolName: "delegate_to_peer", target: "비: 정리\nDELEGATE-2 폴더를 정리해" });
    pi.write({ type: "extension_ui_response", id: approval.id, value: ApprovalChoice.once });
    await pi.waitFor((r) => r.type === "agent_settled", from);

    const [theirs] = await tasksOf(env.b);
    expect(theirs).toMatchObject({ status: "waiting", instruction: "DELEGATE-2 폴더를 정리해" });
    await saveTask(tasksDir(env.b), { ...theirs!, status: "done", result: "정리 끝" });

    // 대화가 상대 상태를 확인해 끝난 것을 알면 [작업 알림]을 넣고 한 턴을 일으킨다
    let sent = "";
    // 도구 결과에도 "[작업 알림]"이라는 말이 있으므로 작업 이름까지 맞춰 기다린다
    for (let i = 0; i < 400 && !sent.includes("[작업 알림] 정리"); i++) {
      await new Promise((r) => setTimeout(r, 100));
      sent = JSON.stringify(llm.requests.at(-1)?.messages ?? []);
    }
    expect(sent).toContain("[작업 알림] 정리");
    expect(sent).toContain("정리 끝");
  }, 60_000);
});
