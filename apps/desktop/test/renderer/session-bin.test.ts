import { describe, expect, it } from "vitest";
import type { StoredSession, TrashItem } from "@pi-desktop/host-protocol/messages";
import { archivedHistory, sessionTitle, trashMeta, visibleHistory } from "../../src/renderer/session-bin";

const stored = (path: string, modified: number, archived?: boolean): StoredSession => ({
  path,
  id: path,
  cwd: "/w",
  created: 0,
  modified,
  messageCount: 1,
  firstMessage: "",
  ...(archived ? { archived } : {}),
});

describe("아카이브·휴지통 화면", () => {
  it("기록에서는 아카이브한 세션을 빼고, 아카이브 화면은 그것만 최근 순으로", () => {
    const list = [stored("/a", 1, true), stored("/b", 2), stored("/c", 3, true)];
    expect(visibleHistory(list).map((s) => s.path)).toEqual(["/b"]);
    expect(archivedHistory(list).map((s) => s.path)).toEqual(["/c", "/a"]);
  });

  it("제목은 이름, 없으면 첫 메시지, 그것도 없으면 빈 세션", () => {
    expect(sessionTitle({ name: "이름", firstMessage: "첫" })).toBe("이름");
    expect(sessionTitle({ firstMessage: "첫" })).toBe("첫");
    expect(sessionTitle({ firstMessage: "" })).toBe("(빈 세션)");
  });

  it("휴지통 줄 설명에 지운 때·폴더·예전 백업 표시", () => {
    const item: TrashItem = { id: "x.jsonl", originalPath: "/s/x.jsonl", deletedAt: 5, sessionId: "s", cwd: "/w", firstMessage: "", size: 1, legacy: true };
    expect(trashMeta(item, (ms) => `t${ms}`)).toBe("t5 삭제 · /w · 예전 백업");
    expect(trashMeta({ ...item, cwd: "", legacy: undefined } as TrashItem, () => "방금")).toBe("방금 삭제 · (폴더 모름)");
  });
});
