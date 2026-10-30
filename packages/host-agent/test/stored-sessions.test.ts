import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listStoredSessions } from "../src/pi-sdk";

/** listStoredSessions가 쓰는 SessionManager만 가진 가짜 SDK */
function fakeSdk(cwds: string[]) {
  const infos = cwds.map((cwd, i) => ({
    path: `/sessions/${i}.jsonl`,
    id: String(i),
    cwd,
    created: new Date(1000 + i),
    modified: new Date(1000 + i),
    messageCount: 1,
    firstMessage: `질문 ${i}`,
  }));
  return { SessionManager: { list: async () => infos, listAll: async () => infos } } as unknown as Parameters<typeof listStoredSessions>[0];
}

describe("listStoredSessions — 작업 폴더가 지워진 세션", () => {
  it("작업 폴더가 없는 세션에만 cwdMissing을 붙인다", async () => {
    const existing = await mkdtemp(join(tmpdir(), "stored-cwd-"));
    const gone = join(existing, "지워진-폴더");
    const sessions = await listStoredSessions(fakeSdk([existing, gone, gone]), {});
    const byCwd = (cwd: string) => sessions.filter((s) => s.cwd === cwd);
    expect(byCwd(existing).every((s) => s.cwdMissing === undefined)).toBe(true);
    expect(byCwd(gone).map((s) => s.cwdMissing)).toEqual([true, true]);
  });
});
