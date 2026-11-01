import { appendFile, stat, utimes } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Methods,
  type SessionOpenResult,
  type StoredInspectResult,
  type StoredReadResult,
} from "@pi-desktop/host-protocol";
import { isolatedEnv, TestClient, waitUntil } from "./helpers/agent-client";
import { ExternalPi } from "./helpers/external-pi";
import { MOCK_MODEL_ARGS, PI_CLI, setupRealPi, type RealPiFixture } from "./helpers/real-pi";

/**
 * TUI와 병행 사용 계약 테스트 (설계 §5.4).
 *
 * 데몬 밖에서 따로 띄운 Pi 프로세스를 "TUI"로 보고 그 세션 파일에 쓰게 한 뒤,
 * 데몬이 그 파일을 검사·읽기·팔로우하고, 같은 파일에 쓰지 않도록 분기(--fork)해서 여는지 확인한다.
 */

/** 사용자 메시지 본문. content는 문자열이거나 {type:"text"} 블록 배열이다. */
const userTexts = (messages: unknown[]) =>
  messages
    .map((m) => m as { role?: string; content?: unknown })
    .filter((m) => m.role === "user")
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : (m.content as Array<{ type?: string; text?: string }>)
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join(""),
    );

describe("TUI와 병행 사용 (외부 Pi 프로세스)", () => {
  let fixture: RealPiFixture;
  let client: TestClient;
  let external: ExternalPi;
  let externalFile: string;

  beforeAll(async () => {
    fixture = await setupRealPi();
    client = new TestClient(await isolatedEnv({ PI_DESKTOP_PI_CLI: PI_CLI }));
    external = new ExternalPi(fixture.projectDir, fixture.piEnv);
    await external.prompt("외부 첫 질문");
    externalFile = await external.sessionFile();
  });

  afterAll(async () => {
    external?.stop();
    await client?.shutdownDaemon();
    await fixture?.llm.close();
  });

  it("stored.inspect: 다른 프로그램이 쓰는 파일은 최근 수정 시각만 있고 ownedBy가 없다", async () => {
    const info = await client.request<StoredInspectResult>(Methods.storedInspect, { path: externalFile });
    expect(info).toMatchObject({ path: externalFile, exists: true });
    expect(info.ownedBy).toBeUndefined();
    expect(Date.now() - info.modified).toBeLessThan(60_000);
  });

  it("stored.read: 파일을 읽기만 해서 현재 갈래의 대화를 만든다", async () => {
    const before = (await stat(externalFile)).size;
    const read = await client.request<StoredReadResult>(Methods.storedRead, { path: externalFile });
    expect(userTexts(read.messages)).toEqual(["외부 첫 질문"]);
    expect(read.leafId).toBeTruthy();
    expect((await stat(externalFile)).size).toBe(before);
  });

  it("stored.watch: 외부 Pi가 파일에 덧붙이면 알림을 받고, 다시 읽으면 새 대화가 보인다", async () => {
    await client.request(Methods.storedWatch, { path: externalFile });
    const seen = client.storedChanges.length;
    await external.prompt("외부 두 번째 질문");
    // 파일 감시는 주기적으로 stat하므로 알림이 조금 늦게 올 수 있다.
    await waitUntil(() => client.storedChanges.length > seen, 10_000, "stored.changed를 받지 못함");
    expect(client.storedChanges.length).toBeGreaterThan(seen);
    expect(client.storedChanges.at(-1)?.path).toBe(externalFile);

    const read = await client.request<StoredReadResult>(Methods.storedRead, { path: externalFile });
    expect(userTexts(read.messages)).toEqual(["외부 첫 질문", "외부 두 번째 질문"]);
    await client.request(Methods.storedUnwatch, { path: externalFile });
  });

  it("forkFrom: 같은 파일에 쓰지 않고 분기한 새 세션으로 이어 간다", async () => {
    const sizeBefore = (await stat(externalFile)).size;
    const { session } = await client.request<SessionOpenResult>(Methods.sessionOpen, {
      cwd: fixture.projectDir,
      forkFrom: externalFile,
      piArgs: MOCK_MODEL_ARGS,
      env: fixture.piEnv,
    });
    expect(session.sessionFile).toBeDefined();
    expect(session.sessionFile).not.toBe(externalFile);

    const messages = await client.request<{ data: { messages: unknown[] } }>(Methods.sessionSend, {
      sessionId: session.sessionId,
      command: { type: "get_messages" },
    });
    expect(userTexts(messages.data.messages)).toEqual(["외부 첫 질문", "외부 두 번째 질문"]);

    await client.request(Methods.sessionAttach, { sessionId: session.sessionId, lastSeq: 0 });
    await client.request(Methods.sessionSend, {
      sessionId: session.sessionId,
      command: { type: "prompt", message: "분기에서 이어 가기" },
    });
    await client.waitForEvent((e, n) => n.sessionId === session.sessionId && e.type === "agent_settled");
    // 원래 파일(외부 Pi의 파일)은 건드리지 않았다
    expect((await stat(externalFile)).size).toBe(sizeBefore);

    const owned = await client.request<StoredInspectResult>(Methods.storedInspect, { path: session.sessionFile });
    expect(owned.ownedBy).toBe(session.sessionId);

    // 이 데몬이 쓰다 닫은 파일은 곧바로 다시 열어도 "다른 곳에서 쓰는 중"이 아니다
    await client.request(Methods.sessionClose, { sessionId: session.sessionId });
    const closed = await client.request<StoredInspectResult>(Methods.storedInspect, { path: session.sessionFile });
    expect(closed.ownedBy).toBeUndefined();
    expect(closed.closedHere).toBe(true);
    // 닫은 뒤 다른 곳에서 바뀌면 다시 묻는다
    await new Promise((r) => setTimeout(r, 20));
    await appendFile(session.sessionFile!, "");
    await utimes(session.sessionFile!, new Date(), new Date(Date.now() + 5000));
    const touched = await client.request<StoredInspectResult>(Methods.storedInspect, { path: session.sessionFile });
    expect(touched.closedHere).toBeUndefined();
  });

  it("sessionFile과 forkFrom을 함께 주면 거부한다", async () => {
    await expect(
      client.request(Methods.sessionOpen, { cwd: fixture.projectDir, sessionFile: externalFile, forkFrom: externalFile }),
    ).rejects.toMatchObject({ code: -32602 });
  });
});
