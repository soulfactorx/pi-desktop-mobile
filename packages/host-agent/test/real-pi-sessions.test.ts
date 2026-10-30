import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Methods,
  type SessionOpenResult,
  type SessionSummary,
  type StoredDeleteResult,
  type StoredSession,
  type TrashItem,
  type TrashRestoreResult,
} from "@pi-desktop/host-protocol";
import { isolatedEnv, TestClient } from "./helpers/agent-client";
import { MOCK_MODEL_ARGS, PI_CLI, setupRealPi, type RealPiFixture } from "./helpers/real-pi";

/**
 * 세션 기록·트리·fork 계약 테스트.
 * 기록은 데몬이 설치된 Pi의 SDK(SessionManager.list)를 동적으로 불러와 읽는다.
 */
describe("세션 기록과 fork (실제 Pi)", () => {
  let fixture: RealPiFixture;
  let client: TestClient;
  let session: SessionSummary;
  let sessionDir: string;

  const send = <T = Record<string, unknown>>(command: Record<string, unknown>) =>
    client.request<T>(Methods.sessionSend, { sessionId: session.sessionId, command });

  const prompt = async (message: string) => {
    const settledBefore = client.events.filter((n) => (n.event as { type?: string }).type === "agent_settled").length;
    await send({ type: "prompt", message });
    await client.waitForEvent(
      () => client.events.filter((n) => (n.event as { type?: string }).type === "agent_settled").length > settledBefore,
    );
  };

  const history = (cwd?: string) =>
    client.request<StoredSession[]>(Methods.sessionHistory, cwd ? { cwd, sessionDir } : { sessionDir });

  beforeAll(async () => {
    fixture = await setupRealPi();
    sessionDir = fixture.piEnv.PI_CODING_AGENT_SESSION_DIR!;
    client = new TestClient(await isolatedEnv({ PI_DESKTOP_PI_CLI: PI_CLI }));
    ({ session } = await client.request<SessionOpenResult>(Methods.sessionOpen, {
      cwd: fixture.projectDir,
      piArgs: MOCK_MODEL_ARGS,
      env: fixture.piEnv,
    }));
    await client.request(Methods.sessionAttach, { sessionId: session.sessionId, lastSeq: 0 });
    await prompt("첫 질문");
    await prompt("두 번째 질문");
  });

  afterAll(async () => {
    await client?.shutdownDaemon();
    await fixture?.llm.close();
  });

  it("Pi가 저장한 세션 기록을 SDK로 읽는다", async () => {
    const list = await history(fixture.projectDir);
    const stored = list.find((s) => s.path === session.sessionFile);
    expect(stored).toBeDefined();
    expect(stored).toMatchObject({ firstMessage: "첫 질문" });
    expect(stored!.messageCount).toBeGreaterThanOrEqual(4);
    expect(stored!.modified).toBeGreaterThan(0);
  });

  it("get_tree는 대화를 트리로 돌려준다", async () => {
    const tree = await send<{ success: boolean; data: { tree: unknown[]; leafId: string } }>({ type: "get_tree" });
    expect(tree.success).toBe(true);
    expect(tree.data.tree.length).toBeGreaterThan(0);
    expect(typeof tree.data.leafId).toBe("string");
  });

  it("사용자 메시지에서 fork하면 새 세션 파일로 옮겨 가고, 기록에 원본이 부모로 남는다", async () => {
    const original = session.sessionFile;
    const forks = await send<{ data: { messages: Array<{ entryId: string; text: string }> } }>({
      type: "get_fork_messages",
    });
    const second = forks.data.messages.find((m) => m.text === "두 번째 질문");
    expect(second).toBeDefined();

    const forked = await send<{ success: boolean; data: { text?: string; cancelled: boolean } }>({
      type: "fork",
      entryId: second!.entryId,
    });
    expect(forked).toMatchObject({ success: true, data: { text: "두 번째 질문", cancelled: false } });

    // 데몬이 fork 뒤 세션 파일 경로를 새로 읽어 두었는지
    const after = (await client.request<SessionSummary[]>(Methods.sessionList)).find(
      (s) => s.sessionId === session.sessionId,
    );
    expect(after?.sessionFile).toBeDefined();
    expect(after?.sessionFile).not.toBe(original);

    const all = await history();
    const child = all.find((s) => s.path === after!.sessionFile);
    expect(child?.parentSessionPath).toBe(original);
    expect(all.some((s) => s.path === original)).toBe(true);
  });

  it("아카이브는 기록에 표시만 하고, 지우면 휴지통으로 갔다가 되살아난다", async () => {
    // fork 뒤라 실행 중인 세션은 새 파일을 쓴다. 지울 것은 원래 파일
    const running = (await client.request<SessionSummary[]>(Methods.sessionList)).find((s) => s.sessionId === session.sessionId)!;
    const target = (await history()).find((s) => s.path !== running.sessionFile)!;
    expect(target).toBeDefined();
    await client.request(Methods.archiveSet, { path: target.path, archived: true });
    expect((await history()).find((s) => s.path === target.path)?.archived).toBe(true);

    // 실행 중인 세션의 파일은 지우지 않는다
    await expect(client.request(Methods.storedDelete, { path: running.sessionFile })).rejects.toThrow(/실행 중/);

    const deleted = await client.request<StoredDeleteResult>(Methods.storedDelete, { path: target.path });
    expect(deleted.trashId).toBeDefined();
    expect((await history()).some((s) => s.path === target.path)).toBe(false);
    const trash = await client.request<TrashItem[]>(Methods.trashList);
    expect(trash.find((t) => t.id === deleted.trashId)).toMatchObject({ originalPath: target.path, firstMessage: "첫 질문" });

    const restored = await client.request<TrashRestoreResult>(Methods.trashRestore, { id: deleted.trashId });
    expect(restored.path).toBe(target.path);
    const back = (await history()).find((s) => s.path === target.path);
    // 지울 때 아카이브에서도 빠졌다
    expect(back).toBeDefined();
    expect(back!.archived).toBeUndefined();
    expect(await client.request<TrashItem[]>(Methods.trashList)).toEqual([]);
  });
});
