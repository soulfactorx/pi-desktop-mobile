import { describe, expect, it } from "vitest";
import { applyEvent, snapshotState } from "../../src/renderer/chat-state";

const user = (text: string) => ({ role: "user", content: text, timestamp: 1 });
const assistant = (content: unknown[], extra: Record<string, unknown> = {}) => ({
  role: "assistant",
  content,
  stopReason: "stop",
  ...extra,
});

describe("snapshotState", () => {
  it("사용자·응답·툴 호출·툴 결과를 화면 항목으로 복원한다", () => {
    const state = snapshotState(
      [
        user("파일 읽어줘"),
        assistant([{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.txt" } }], { stopReason: "toolUse" }),
        { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "내용" }], isError: false },
        assistant([
          { type: "thinking", thinking: "음" },
          { type: "text", text: "다 읽었습니다" },
        ]),
      ],
      42,
      false,
    );
    expect(state.lastSeq).toBe(42);
    expect(state.running).toBe(false);
    expect(state.items).toMatchObject([
      { kind: "user", text: "파일 읽어줘" },
      { kind: "assistant", done: true, stopReason: "toolUse" },
      { kind: "tool", toolCallId: "c1", toolName: "read", args: { path: "a.txt" }, status: "done", output: "내용" },
      {
        kind: "assistant",
        blocks: [
          { type: "thinking", text: "음" },
          { type: "text", text: "다 읽었습니다" },
        ],
      },
    ]);
  });

  it("오류로 끝난 툴 결과는 error 상태", () => {
    const state = snapshotState(
      [
        assistant([{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "x" } }]),
        { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [], isError: true },
      ],
      1,
      false,
    );
    expect(state.items[1]).toMatchObject({ kind: "tool", status: "error" });
  });

  it("! 셸 명령(bashExecution)을 툴 카드로 보여준다", () => {
    const state = snapshotState([{ role: "bashExecution", command: "ls", output: "a\nb", exitCode: 0 }], 1, false);
    expect(state.items[0]).toMatchObject({ kind: "tool", toolName: "!bash", args: { command: "ls" }, output: "a\nb", status: "done" });
  });

  it("실행 중이고 마지막이 사용자 메시지면, 진행 중 응답의 델타를 받을 자리를 만든다", () => {
    const snap = snapshotState([user("안녕")], 10, true);
    expect(snap.items.at(-1)).toMatchObject({ kind: "assistant", done: false, blocks: [] });

    // 스냅샷 뒤에 들어오는 실시간 델타가 그 자리에 쌓인다
    const next = applyEvent(snap, 11, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "반가워요" },
    });
    expect(next.items.at(-1)).toMatchObject({ kind: "assistant", blocks: [{ type: "text", text: "반가워요" }] });
  });

  it("툴이 아직 실행 중이면 자리를 만들지 않고, 실시간 툴 종료 이벤트가 그 카드를 완료로 바꾼다", () => {
    const snap = snapshotState(
      [user("잠깐 기다려"), assistant([{ type: "toolCall", id: "c9", name: "bash", arguments: { command: "sleep 8" } }])],
      20,
      true,
    );
    expect(snap.items.at(-1)).toMatchObject({ kind: "tool", status: "running" });

    const next = applyEvent(snap, 21, {
      type: "tool_execution_end",
      toolCallId: "c9",
      toolName: "bash",
      result: { content: [{ type: "text", text: "끝" }] },
      isError: false,
      durationMs: 8000,
    });
    expect(next.items.at(-1)).toMatchObject({ kind: "tool", status: "done", output: "끝", durationMs: 8000 });
  });

  it("스냅샷 이전 순번의 이벤트는 다시 반영하지 않는다", () => {
    const snap = snapshotState([user("a")], 30, false);
    expect(applyEvent(snap, 30, { type: "agent_start" })).toBe(snap);
  });

  it("컴팩션 요약과 떠난 갈래 요약은 펼쳐 볼 수 있는 안내가 된다", () => {
    const items = snapshotState(
      [
        { role: "compactionSummary", summary: "이전 요약", tokensBefore: 120000, timestamp: 1 },
        { role: "branchSummary", summary: "갈래 요약", fromId: "e1", timestamp: 2 },
      ],
      1,
      false,
    ).items;
    expect(items).toMatchObject([
      { kind: "notice", text: "이전 대화가 요약(컴팩션)되었습니다 (120k 토큰).", detail: "이전 요약" },
      { kind: "notice", text: "떠난 갈래의 요약", detail: "갈래 요약" },
    ]);
  });

  it("모르는 role이나 잘못된 값은 건너뛴다", () => {
    expect(snapshotState([null, 3, { role: "custom", content: "x" }], 1, false).items).toEqual([]);
  });
});

describe("snapshotState — 이미지가 있는 사용자 메시지", () => {
  it("스냅샷에서도 글과 이미지를 나눠 담는다", () => {
    const state = snapshotState(
      [{ role: "user", content: [{ type: "text", text: "봐" }, { type: "image", data: "BBBB", mimeType: "image/jpeg" }] }],
      0,
      false,
    );
    expect(state.items[0]).toMatchObject({ text: "봐", images: [{ mimeType: "image/jpeg", data: "BBBB" }] });
  });
});
