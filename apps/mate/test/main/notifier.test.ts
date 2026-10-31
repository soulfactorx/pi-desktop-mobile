import { describe, expect, it } from "vitest";
import { newNotes } from "../../src/main/notifier";
import type { Overview } from "../../src/shared/api";

/** 알림에 쓰는 부분만 채운 overview */
function overview(parts: { chat?: unknown[]; runs?: unknown[]; inbox?: unknown[] }): Overview {
  return { chat: { lines: parts.chat ?? [], pending: 0 }, runs: parts.runs ?? [], inbox: parts.inbox ?? [] } as unknown as Overview;
}

const run = (id: string, status: string, extra: Record<string, unknown> = {}) => ({ id, dutyId: "d", dutyName: "아침 날씨", status, startedAt: 1, ...extra });

describe("PC 알림 (notifier)", () => {
  it("처음 읽은 것은 기준만 잡고, 그 뒤에 새로 생긴 것만 알린다", () => {
    const first = newNotes(undefined, overview({ chat: [{ id: "c1", role: "mate", kind: "reply", text: "예전 답" }], runs: [run("r1", "done")] }));
    expect(first.notes).toEqual([]);
    const next = newNotes(
      first.state,
      overview({
        chat: [
          { id: "c1", role: "mate", kind: "reply", text: "예전 답" },
          { id: "c2", role: "user", text: "날씨 알려줘" },
          { id: "c3", role: "mate", kind: "question", text: "웹 검색을 켤까요?" },
          { id: "c4", role: "mate", kind: "notice", text: "할 일로 넣었어요" },
        ],
        runs: [run("r1", "done"), run("r2", "done", { summary: "서울 맑음" }), run("r3", "running")],
      }),
    );
    expect(next.notes).toEqual([
      { title: "Mate의 질문", body: "웹 검색을 켤까요?" },
      { title: "임무 완료: 아침 날씨", body: "서울 맑음" },
    ]);
    // 실행 중이던 것이 끝나면 그때 알린다
    const done = newNotes(next.state, overview({ chat: [], runs: [run("r3", "failed", { error: "시간 초과" })] }));
    expect(done.notes).toEqual([{ title: "임무 실패: 아침 날씨", body: "시간 초과" }]);
  });

  it("대화 결과가 있는 실행과 그 실행의 제안은 따로 알리지 않고, 휴대폰 대화의 답은 PC에 알리지 않는다", () => {
    const base = newNotes(undefined, overview({})).state;
    const { notes } = newNotes(
      base,
      overview({
        chat: [
          { id: "c1", role: "mate", kind: "result", text: "브리핑 끝", runId: "r1" },
          { id: "c2", role: "mate", kind: "reply", text: "휴대폰 답", source: "telegram" },
        ],
        runs: [run("r1", "done"), run("r2", "done", { proposals: 1, summary: "s" })],
        inbox: [
          { id: "i1", runId: "r1", title: "a", summary: "x" },
          { id: "i2", runId: "r2", title: "b", summary: "y" },
          { id: "i3", runId: "r9", title: "린트 경고", summary: "경고 3개" },
          { id: "i4", runId: "r9", title: "처리함", summary: "z", status: "accepted" },
        ],
      }),
    );
    expect(notes).toEqual([
      { title: "Mate 실행 결과", body: "브리핑 끝" },
      { title: "임무 완료: 아침 날씨 · 제안 1건", body: "s" },
      { title: "새 제안: 린트 경고", body: "경고 3개" },
    ]);
  });

  it("한 번에 많이 생기면 둘만 띄우고 나머지는 한 줄로 묶는다", () => {
    const base = newNotes(undefined, overview({})).state;
    const { notes } = newNotes(base, overview({ inbox: [1, 2, 3, 4, 5].map((n) => ({ id: `i${n}`, runId: `r${n}`, title: `t${n}`, summary: "s" })) }));
    expect(notes.map((n) => n.title)).toEqual(["새 제안: t1", "새 제안: t2", "Mate 알림 3건 더"]);
  });
});
