import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  Methods,
  type FsSearchResult,
  type HostInfo,
  type PiStatus,
  type SessionAttachResult,
  type SessionOpenResult,
  type SessionSummary,
} from "@pi-desktop/host-protocol";
import { AGENT_SCRIPT, isolatedEnv, joinedText, TestClient } from "./helpers/agent-client";

const FAKE_PI = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));

describe("Host Agent 데몬 (가짜 Pi)", () => {
  const clients: TestClient[] = [];
  const connect = (env: NodeJS.ProcessEnv) => {
    const client = new TestClient(env);
    clients.push(client);
    return client;
  };

  afterEach(async () => {
    // 마지막 클라이언트로 데몬을 끝내고 나머지 연결을 정리한다.
    const last = clients.at(-1);
    if (last) await last.shutdownDaemon();
    await Promise.all(clients.map((c) => c.disconnect()));
    clients.length = 0;
  });

  it("connect가 데몬을 띄우고 host.info에 답한다", async () => {
    const client = connect(await isolatedEnv({ PI_DESKTOP_PI_CLI: FAKE_PI }));
    const info = await client.request<HostInfo>(Methods.hostInfo);
    expect(info.protocolVersion).toBe(1);
    expect(info.platform).toBe(process.platform);
    // 앱이 예전 데몬을 가리는 빌드 식별자: 실행 중인 번들 파일 해시의 앞 12자리
    const build = createHash("sha256").update(readFileSync(AGENT_SCRIPT)).digest("hex").slice(0, 12);
    expect(info.agentBuild).toBe(build);
  });

  it("세션을 열고 프롬프트의 스트리밍 이벤트를 순번대로 받는다", async () => {
    const client = connect(await isolatedEnv({ PI_DESKTOP_PI_CLI: FAKE_PI }));
    const { session } = await client.request<SessionOpenResult>(Methods.sessionOpen, { cwd: process.cwd() });
    expect(session.sessionFile).toBe("/fake/session.jsonl");

    await client.request<SessionAttachResult>(Methods.sessionAttach, { sessionId: session.sessionId, lastSeq: 0 });
    const response = await client.request<Record<string, unknown>>(Methods.sessionSend, {
      sessionId: session.sessionId,
      command: { type: "prompt", message: "hello world" },
    });
    expect(response).toMatchObject({ type: "response", success: true });

    await client.waitForEvent((e) => e.type === "agent_settled");
    expect(joinedText(client.events)).toBe("echo: hello world");
    const seqs = client.events.map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  });

  it("연결이 끊겨도 작업은 계속되고, 다시 붙으면 놓친 이벤트를 재생한다", async () => {
    const env = await isolatedEnv({ PI_DESKTOP_PI_CLI: FAKE_PI, FAKE_PI_DELAY_MS: "80" });
    const first = connect(env);
    const { session } = await first.request<SessionOpenResult>(Methods.sessionOpen, { cwd: process.cwd() });
    await first.request(Methods.sessionAttach, { sessionId: session.sessionId, lastSeq: 0 });
    await first.request(Methods.sessionSend, {
      sessionId: session.sessionId,
      command: { type: "prompt", message: "a b c d e f g h" },
    });

    // 스트리밍 도중에 앱이 꺼진 상황
    await first.waitForEvent((e) => e.type === "message_update");
    const lastSeq = first.events.at(-1)!.seq;
    await first.disconnect();

    // 앱을 다시 열어 같은 데몬에 붙는다
    const second = connect(env);
    const sessions = await second.request<SessionSummary[]>(Methods.sessionList);
    expect(sessions.map((s) => s.sessionId)).toContain(session.sessionId);

    const attach = await second.request<SessionAttachResult>(Methods.sessionAttach, {
      sessionId: session.sessionId,
      lastSeq,
    });
    expect(attach.truncated).toBe(false);
    await second.waitForEvent((e) => e.type === "agent_settled");

    // 끊기기 전 + 재연결 후 이벤트를 합치면 빠짐없이 이어져야 한다
    const all = [...first.events.filter((e) => e.seq <= lastSeq), ...second.events];
    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
    expect(joinedText(all)).toBe("echo: a b c d e f g h");
  });

  it("저널에서 잘린 구간을 요청하면 truncated로 알린다", async () => {
    const env = await isolatedEnv({ PI_DESKTOP_PI_CLI: FAKE_PI, FAKE_PI_DELAY_MS: "1", PI_DESKTOP_JOURNAL_CAPACITY: "3" });
    const client = connect(env);
    const { session } = await client.request<SessionOpenResult>(Methods.sessionOpen, { cwd: process.cwd() });
    await client.request(Methods.sessionAttach, { sessionId: session.sessionId, lastSeq: 0 });
    await client.request(Methods.sessionSend, { sessionId: session.sessionId, command: { type: "prompt", message: "x y z" } });
    await client.waitForEvent((e) => e.type === "agent_settled");

    const attach = await client.request<SessionAttachResult>(Methods.sessionAttach, {
      sessionId: session.sessionId,
      lastSeq: 0,
    });
    expect(attach.truncated).toBe(true);
    expect(attach.replayed?.toSeq).toBe(attach.session.lastSeq);
  });

  it("없는 작업 폴더로 세션을 열면 InvalidParams와 경로를 알려준다", async () => {
    const client = connect(await isolatedEnv({ PI_DESKTOP_PI_CLI: FAKE_PI }));
    const missing = `${process.cwd()}/no-such-dir-for-test`;
    await expect(client.request(Methods.sessionOpen, { cwd: missing })).rejects.toMatchObject({
      code: -32602,
      message: expect.stringContaining("no-such-dir-for-test"),
    });
  });

  it("createCwd를 주면 지워진 작업 폴더를 상위 폴더까지 만들고 연다", async () => {
    const env = await isolatedEnv({ PI_DESKTOP_PI_CLI: FAKE_PI });
    const client = connect(env);
    const missing = join(env.PI_DESKTOP_HOME!, "gone", "project");
    const { session } = await client.request<SessionOpenResult>(Methods.sessionOpen, { cwd: missing, createCwd: true });
    expect(session.cwd).toBe(missing);
    expect(statSync(missing).isDirectory()).toBe(true);
  });

  it("없는 세션에 명령하면 SessionNotFound", async () => {
    const client = connect(await isolatedEnv({ PI_DESKTOP_PI_CLI: FAKE_PI }));
    await expect(
      client.request(Methods.sessionSend, { sessionId: "nope", command: { type: "get_state" } }),
    ).rejects.toMatchObject({ code: -32010 });
  });

  it("fs.search로 작업 폴더의 파일을 찾는다 (작업 폴더 기준 상대 경로, 구분자 /)", async () => {
    const client = connect(await isolatedEnv({ PI_DESKTOP_PI_CLI: FAKE_PI }));
    const cwd = fileURLToPath(new URL("./fixtures", import.meta.url));
    const result = await client.request<FsSearchResult>(Methods.fsSearch, { cwd, query: "fake-pi" });
    expect(result.files[0]).toBe("fake-pi.mjs");
    await expect(client.request(Methods.fsSearch, { query: "x" })).rejects.toMatchObject({ code: -32602 });
  });

  it("pi.status가 찾은 Pi와 실행할 node, 데이터 폴더 정보를 돌려준다", async () => {
    const client = connect(await isolatedEnv({ PI_DESKTOP_PI_CLI: FAKE_PI }));
    const status = await client.request<PiStatus>(Methods.piStatus);
    expect(status.pi).toMatchObject({ cliPath: FAKE_PI, source: "env" });
    expect(status.node.version).toMatch(/^v[0-9]+/);
    expect(status.data.sessions.count).toBeGreaterThanOrEqual(0);
  });
});
