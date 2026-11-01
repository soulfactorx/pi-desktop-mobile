import { describe, expect, it } from "vitest";
import { applyEvent, snapshotState, initialChatState, type ChatState } from "../../src/renderer/chat-state";

/** 이벤트 목록을 seq 1부터 차례로 적용한다. */
function run(events: unknown[], start: ChatState = initialChatState): ChatState {
  return events.reduce<ChatState>((state, event, i) => applyEvent(state, start.lastSeq + i + 1, event), start);
}

const textDelta = (delta: string, contentIndex = 0) => ({
  type: "message_update",
  assistantMessageEvent: { type: "text_delta", contentIndex, delta },
});

describe("applyEvent", () => {
  it("사용자 메시지와 스트리밍 응답을 조립하고 agent_settled에서 실행을 끝낸다", () => {
    const state = run([
      { type: "agent_start" },
      { type: "message_start", message: { role: "user", content: "안녕" } },
      { type: "message_start", message: { role: "assistant", content: [] } },
      textDelta("안"),
      textDelta("녕하세요"),
    ]);
    expect(state.running).toBe(true);
    expect(state.items).toMatchObject([
      { kind: "user", text: "안녕" },
      { kind: "assistant", blocks: [{ type: "text", text: "안녕하세요" }], done: false },
    ]);

    const settled = run([{ type: "agent_settled", aborted: false }], state);
    expect(settled.running).toBe(false);
    expect(settled.items[1]).toMatchObject({ done: true });
  });

  it("message_end의 확정본으로 델타 조립 결과를 교체한다", () => {
    const state = run([
      { type: "message_start", message: { role: "assistant", content: [] } },
      textDelta("틀린 중간 값"),
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "생각" },
            { type: "text", text: "최종" },
          ],
          stopReason: "stop",
        },
      },
    ]);
    expect(state.items[0]).toMatchObject({
      kind: "assistant",
      done: true,
      stopReason: "stop",
      blocks: [
        { type: "thinking", text: "생각" },
        { type: "text", text: "최종" },
      ],
    });
  });

  it("오류로 끝난 응답의 errorMessage를 보존한다", () => {
    const state = run([
      { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "401" } },
    ]);
    expect(state.items[0]).toMatchObject({ stopReason: "error", errorMessage: "401" });
  });

  it("thinking과 text 블록을 contentIndex별로 따로 쌓는다", () => {
    const state = run([
      { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "음" } },
      textDelta("답", 1),
    ]);
    expect(state.items[0]).toMatchObject({
      blocks: [
        { type: "thinking", text: "음" },
        { type: "text", text: "답" },
      ],
    });
  });

  it("툴 실행 시작·진행·종료를 하나의 카드로 묶는다", () => {
    const state = run([
      { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } },
      {
        type: "tool_execution_update",
        toolCallId: "c1",
        toolName: "bash",
        partialResult: { content: [{ type: "text", text: "a" }] },
      },
      {
        type: "tool_execution_end",
        toolCallId: "c1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "a\nb" }] },
        isError: false,
        durationMs: 12,
      },
    ]);
    expect(state.items).toEqual([
      expect.objectContaining({
        kind: "tool",
        toolName: "bash",
        args: { command: "ls" },
        status: "done",
        output: "a\nb",
        durationMs: 12,
      }),
    ]);
  });

  it("툴 오류는 error 상태로 표시한다", () => {
    const state = run([
      { type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: {} },
      { type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: { content: [] }, isError: true },
    ]);
    expect(state.items[0]).toMatchObject({ status: "error" });
  });

  it("이미 반영한 seq의 이벤트는 무시한다 (재생 중복 방지)", () => {
    const once = applyEvent(initialChatState, 1, { type: "message_start", message: { role: "user", content: "a" } });
    const twice = applyEvent(once, 1, { type: "message_start", message: { role: "user", content: "a" } });
    expect(twice).toBe(once);
  });

  it("모르는 이벤트는 상태를 바꾸지 않고 seq만 올린다", () => {
    const state = applyEvent(initialChatState, 5, { type: "brand_new_event_from_future_pi" });
    expect(state.items).toEqual([]);
    expect(state.lastSeq).toBe(5);
  });
});

describe("메시지 시각·토큰 사용량", () => {
  it("사용자 메시지의 시각과 응답의 시각·사용량을 담는다", () => {
    const state = run([
      { type: "message_start", message: { role: "user", content: "안녕", timestamp: 1000 } },
      { type: "message_start", message: { role: "assistant", content: [] } },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "네" }],
          timestamp: 2000,
          usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 2, totalTokens: 117, cost: { total: 0.0012 } },
        },
      },
    ]);
    expect(state.items[0]).toMatchObject({ kind: "user", at: 1000 });
    expect(state.items[1]).toMatchObject({
      kind: "assistant",
      at: 2000,
      usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 2, totalTokens: 117, cost: 0.0012 },
    });
  });

  it("스냅샷에서도 시각·사용량을 담고, 사용량이 없으면 두지 않는다", () => {
    const items = snapshotState(
      [
        { role: "user", content: "q", timestamp: 5 },
        { role: "assistant", content: [{ type: "text", text: "a" }], timestamp: 6, usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 } },
        { role: "assistant", content: [{ type: "text", text: "b" }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } },
      ],
      1,
      false,
    ).items;
    expect(items[0]).toMatchObject({ at: 5 });
    expect(items[1]).toMatchObject({ at: 6, usage: { totalTokens: 3 } });
    expect(items[2]).not.toHaveProperty("usage");
  });
});

describe("applyEvent — 컴팩션·재시도 안내", () => {
  it("컴팩션 시작과 결과(토큰 감소)를 안내한다", () => {
    const state = run([
      { type: "compaction_start", reason: "threshold" },
      { type: "compaction_end", reason: "threshold", result: { tokensBefore: 150000, estimatedTokensAfter: 32000 } },
    ]);
    expect(state.items.map((i) => (i.kind === "notice" ? i.text : ""))).toEqual([
      "컨텍스트를 요약(컴팩션)하는 중… (컨텍스트 임계치 도달)",
      "요약 완료: 150k → 약 32k 토큰",
    ]);
  });

  it("컴팩션 요약문을 펼쳐 볼 내용으로 붙인다", () => {
    const state = run([
      { type: "compaction_end", reason: "manual", result: { tokensBefore: 1000, estimatedTokensAfter: 200, summary: "  ## 목표\n요약  " } },
    ]);
    expect(state.items[0]).toMatchObject({ kind: "notice", detail: "## 목표\n요약" });
  });

  it("컴팩션 실패는 오류로, 중단은 안내로 보여준다", () => {
    const failed = run([{ type: "compaction_end", reason: "manual", aborted: false, errorMessage: "boom" }]);
    expect(failed.items[0]).toMatchObject({ kind: "notice", level: "error", text: "요약 실패: boom" });
    const aborted = run([{ type: "compaction_end", reason: "manual", aborted: true }]);
    expect(aborted.items[0]).toMatchObject({ kind: "notice", level: "info", text: "요약을 중단했습니다." });
  });

  it("자동 재시도 시작과 최종 실패를 안내하고, 성공한 재시도는 조용히 넘어간다", () => {
    const state = run([
      { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "529 overloaded" },
      { type: "auto_retry_end", success: true, attempt: 2 },
      { type: "auto_retry_end", success: false, attempt: 3, finalError: "429" },
    ]);
    expect(state.items).toMatchObject([
      { kind: "notice", level: "info", text: "응답 오류로 2초 뒤 다시 시도합니다 (1/3): 529 overloaded" },
      { kind: "notice", level: "error", text: "재시도 실패: 429" },
    ]);
  });
});

describe("applyEvent — ! 셸 명령", () => {
  const start = (id: string, command: string, excludeFromContext = false) => ({
    type: "pi_desktop_bash_start",
    id,
    command,
    excludeFromContext,
  });
  const chunk = (id: string, delta: string) => ({ type: "bash_execution_update", id, delta });

  it("시작 → 출력 조각 → 끝으로 카드를 만들고 출력을 이어 붙인다", () => {
    const state = run([
      start("d-1", "ls"),
      chunk("d-1", "a.txt\n"),
      chunk("d-1", "b.txt\n"),
      { type: "pi_desktop_bash_end", id: "d-1", exitCode: 0, cancelled: false, truncated: false },
    ]);
    expect(state.items).toMatchObject([
      { kind: "tool", toolName: "!bash", args: { command: "ls" }, status: "done", output: "a.txt\nb.txt\n", exitCode: 0 },
    ]);
  });

  it("컨텍스트 제외(!!)는 이름으로 구분하고, 0이 아닌 종료 코드·중단·오류는 실패로 표시한다", () => {
    const state = run([
      start("d-1", "false", true),
      { type: "pi_desktop_bash_end", id: "d-1", exitCode: 1, cancelled: false, truncated: false },
      start("d-2", "sleep 9"),
      chunk("d-2", "x\n"),
      { type: "pi_desktop_bash_end", id: "d-2", exitCode: null, cancelled: true, truncated: false },
      start("d-3", "ls"),
      { type: "pi_desktop_bash_end", id: "d-3", error: "Pi 프로세스가 종료되었습니다" },
    ]);
    expect(state.items).toMatchObject([
      { toolName: "!!bash", status: "error", exitCode: 1 },
      { toolName: "!bash", status: "error", output: "x\n[중단됨]" },
      { toolName: "!bash", status: "error", output: "[오류] Pi 프로세스가 종료되었습니다" },
    ]);
  });

  it("다른 명령의 출력 조각은 섞이지 않는다", () => {
    const state = run([start("d-1", "a"), start("d-2", "b"), chunk("d-2", "B"), chunk("d-1", "A")]);
    expect(state.items.map((i) => (i.kind === "tool" ? i.output : ""))).toEqual(["A", "B"]);
  });
});

describe("applyEvent — 툴 호출 id 재사용", () => {
  it("같은 id가 다시 오면 가장 최근 카드에 결과를 붙이고, 부가 정보와 종료 코드를 남긴다", () => {
    const start = (toolName: string) => ({ type: "tool_execution_start", toolCallId: "call_1", toolName, args: {} });
    const state = run([
      start("edit"),
      { type: "tool_execution_end", toolCallId: "call_1", result: { content: [], details: { patch: "p" } }, isError: false },
      start("bash"),
      {
        type: "tool_execution_end",
        toolCallId: "call_1",
        result: { content: [{ type: "text", text: "hi" }], structuredContent: { exit_code: 3 } },
        isError: true,
      },
    ]);
    expect(state.items).toMatchObject([
      { toolName: "edit", status: "done", details: { patch: "p" } },
      { toolName: "bash", status: "error", output: "hi", exitCode: 3 },
    ]);
  });
});

describe("applyEvent — 대기 큐와 자동 재시도", () => {
  it("queue_update는 큐 전체를 바꾸고, agent_settled에서 비운다", () => {
    const queued = run([
      { type: "agent_start" },
      { type: "queue_update", steering: ["방향 바꿔"], followUp: ["끝나면 요약", "테스트도"] },
    ]);
    expect(queued.queue).toEqual({ steering: ["방향 바꿔"], followUp: ["끝나면 요약", "테스트도"] });
    const drained = run([{ type: "queue_update", steering: [], followUp: ["테스트도"] }], queued);
    expect(drained.queue).toEqual({ steering: [], followUp: ["테스트도"] });
    expect(run([{ type: "agent_settled" }], drained).queue).toEqual({ steering: [], followUp: [] });
  });

  it("자동 재시도 중 상태를 두고, 끝나거나 실행이 끝나면 지운다", () => {
    const retrying = run([
      { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "529 overloaded" },
    ]);
    expect(retrying.retry).toEqual({ attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "529 overloaded" });
    expect(run([{ type: "auto_retry_end", success: true, attempt: 2 }], retrying).retry).toBeUndefined();
    expect(run([{ type: "agent_settled" }], retrying).retry).toBeUndefined();
  });
});

describe("applyEvent — 재시도한 실패 응답", () => {
  const failed = (text = "") => [
    { type: "message_start", message: { role: "assistant" } },
    { type: "message_end", message: { role: "assistant", content: text ? [{ type: "text", text }] : [], stopReason: "error", errorMessage: "529" } },
  ];
  const retry = (attempt: number) => ({ type: "auto_retry_start", attempt, maxAttempts: 3, delayMs: 2000, errorMessage: "529" });

  it("재시도가 시작되면 바로 앞의 빈 오류 응답을 빼고, 마지막 실패만 남긴다", () => {
    const state = run([
      { type: "message_start", message: { role: "user", content: "질문" } },
      ...failed(),
      retry(1),
      ...failed(),
      { type: "auto_retry_end", success: false, attempt: 1, finalError: "529" },
    ]);
    expect(state.items.map((i) => i.kind)).toEqual(["user", "notice", "assistant", "notice"]);
  });

  it("내용이 있는 오류 응답은 지우지 않는다", () => {
    const state = run([...failed("일부 답"), retry(1)]);
    expect(state.items.map((i) => i.kind)).toEqual(["assistant", "notice"]);
  });
});

describe("applyEvent — 이미지가 있는 사용자 메시지", () => {
  it("글과 이미지를 나눠 담는다", () => {
    const state = run([
      {
        type: "message_start",
        message: {
          role: "user",
          content: [
            { type: "text", text: "이거 봐" },
            { type: "image", data: "AAAA", mimeType: "image/png" },
          ],
        },
      },
    ]);
    expect(state.items[0]).toMatchObject({ kind: "user", text: "이거 봐", images: [{ mimeType: "image/png", data: "AAAA" }] });
  });
});
