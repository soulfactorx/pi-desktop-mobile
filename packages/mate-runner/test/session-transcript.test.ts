import { describe, expect, it } from "vitest";
import { parseTranscript } from "../src/session-transcript";

const lines = [
  { type: "session", version: 3, id: "s1", cwd: "/p" },
  { type: "model_change", provider: "anthropic", modelId: "claude-haiku-5-5" },
  { type: "message", message: { role: "system", content: "", sections: { preamble: "You are…" } } },
  { type: "message", message: { role: "user", content: [{ type: "text", text: "CI 봐 줘" }] } },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "확인할게요." }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "gh run list" } }],
      stopReason: "toolUse",
    },
  },
  { type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "막혔음" }], isError: true } },
  { type: "message", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Connection error" } },
];

describe("parseTranscript", () => {
  it("시스템 메시지는 빼고, 도구 호출에 결과를 붙인다", () => {
    const items = parseTranscript(`${lines.map((l) => JSON.stringify(l)).join("\n")}\n깨진 줄\n`);
    expect(items).toEqual([
      { kind: "note", text: "모델: anthropic/claude-haiku-5-5" },
      { kind: "user", text: "CI 봐 줘" },
      { kind: "assistant", text: "확인할게요." },
      { kind: "tool", name: "bash", args: '{\n  "command": "gh run list"\n}', result: "막혔음", isError: true },
      { kind: "note", text: "오류: Connection error" },
    ]);
  });

  it("긴 결과는 자른다", () => {
    const long = JSON.stringify({ type: "message", message: { role: "user", content: "가".repeat(5000) } });
    expect((parseTranscript(long)[0] as { text: string }).text).toMatch(/1000자 생략\)$/);
  });
});
