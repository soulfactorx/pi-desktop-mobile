import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { EventSummary, isolationDirOf, piArgs, piEnv } from "../src/executor";
import type { Duty } from "../src/types";

const duty: Duty = {
  id: "ci",
  name: "CI 확인",
  enabled: true,
  cwd: ".",
  prompt: "CI를 봐",
  profile: "observe",
  trigger: { kind: "manual" },
  createdAt: 0,
};
const input = {
  duty,
  runId: "r1",
  model: "anthropic/claude-haiku-5-5",
  extensions: ["/kit/a.ts"],
  home: "/h",
  isolationDir: "/iso",
  inboxPath: "/h/inbox.jsonl",
  sessionsDir: "/h/sessions",
  timeoutSec: 60,
  maxCostUsd: 0,
};

describe("piArgs", () => {
  it("모델을 정하지 않으면 --model을 넘기지 않아 Pi 기본 모델을 따른다", () => {
    expect(piArgs(input)).toContain("--model");
    expect(piArgs({ ...input, model: "" })).not.toContain("--model");
  });

  it("권한 단계에 맞는 도구만 선언하고 지시는 마지막 인자", () => {
    const observe = piArgs(input);
    expect(observe.slice(0, 4)).toEqual(["--mode", "json", "--session-dir", "/h/sessions"]);
    expect(observe[observe.indexOf("--tools") + 1]).toBe("read,grep,find,ls,bash");
    expect(observe.at(-1)).toBe("CI를 봐");
    const propose = piArgs({ ...input, duty: { ...duty, profile: "propose" } });
    expect(propose[propose.indexOf("--tools") + 1]).toBe("read,grep,find,ls,bash,mate_propose,mate_ask");
    expect(propose[propose.indexOf("--append-system-prompt") + 1]).toContain("mate_propose");
    expect(propose[propose.indexOf("--append-system-prompt") + 1]).toContain("mate_ask");
    // 대화는 같은 세션을 이어 쓰고, 읽기 + mate_do만 쓰며, 대화용 안내를 붙인다
    const chat = piArgs({ ...input, chat: { sessionId: "mate-chat-3", systemPrompt: "대화 안내", actionsPath: "/h/a.jsonl" } });
    expect(chat[chat.indexOf("--session-id") + 1]).toBe("mate-chat-3");
    expect(chat[chat.indexOf("--tools") + 1]).toBe("read,grep,find,ls,bash,mate_do");
    expect(chat[chat.indexOf("--append-system-prompt") + 1]).toBe("대화 안내");
    expect(piEnv({ ...input, chat: { sessionId: "s", systemPrompt: "", actionsPath: "/h/a.jsonl" } }, "observe")).toMatchObject({
      PI_DESKTOP_MATE_PROFILE: "chat",
      PI_DESKTOP_MATE_ACTIONS: "/h/a.jsonl",
    });
    expect(piEnv(input, "observe")).toMatchObject({ PI_DESKTOP_MATE_PROFILE: "observe", PI_DESKTOP_MATE_DUTY: "ci" });
    // 관찰자 실행은 제안에 붙일 주제를 넘긴다
    expect(piEnv({ ...input, topic: "untested-edit" }, "propose")).toMatchObject({ PI_DESKTOP_MATE_TOPIC: "untested-edit" });
    expect(piEnv(input, "observe")).not.toHaveProperty("PI_DESKTOP_MATE_TOPIC");
  });

  it("Mate 홈의 스킬·프롬프트만 올리고 Pi 기본 확장·문맥 파일·MCP는 끈다", () => {
    const args = piArgs(input);
    for (const flag of ["-ns", "-np", "-ne", "-nc"]) expect(args).toContain(flag);
    expect(args[args.indexOf("--skill") + 1]).toBe(join("/h", "skills"));
    expect(args[args.indexOf("--prompt-template") + 1]).toBe(join("/h", "prompts"));
    const extensions = args.flatMap((arg, i) => (arg === "-e" ? [args[i + 1]] : []));
    expect(extensions).toEqual(["/kit/a.ts", resolve("/iso", "extensions/context.ts")]);
    // 세션 폴더는 Mate가 정한 것 하나뿐이다
    expect(args.filter((arg) => arg === "--session-dir")).toHaveLength(1);
    expect(piEnv(input, "observe")).toMatchObject({ PI_ISOLATION_HOME: "/h" });
    expect(isolationDirOf(resolve("/r/mate-kit"))).toBe(resolve("/r/pi-isolation"));
  });
});

describe("임무별 스킬·MCP 서버", () => {
  it("고른 스킬만 올리고, 고른 MCP 서버의 도구를 이름 패턴으로 선언하며 바로 선언 노출로 띄운다", () => {
    const picked = { ...input, duty: { ...duty, skills: ["hn-summary"], mcpServers: ["my-gh"], grants: ["curl", "mcp__my_gh__list_prs"] } };
    const args = piArgs(picked);
    expect(args.flatMap((a, i) => (a === "--skill" ? [args[i + 1]] : []))).toEqual([join("/h", "skills", "hn-summary")]);
    expect(args[args.indexOf("--tools") + 1]).toBe("read,grep,find,ls,bash,mcp__my_gh__*");
    const extensions = args.flatMap((a, i) => (a === "-e" ? [args[i + 1]] : []));
    expect(extensions).toContain(resolve("/iso", "extensions/mcp.ts"));
    expect(piEnv(picked, "observe")).toMatchObject({
      PI_ISOLATION_MCP_SERVERS: "my-gh",
      PI_ISOLATION_MCP_EXPOSURE: "direct",
      PI_DESKTOP_MATE_GRANTS: "curl,mcp__my_gh__list_prs",
    });
  });

  it("서버를 고르지 않으면 MCP를 올리지 않고, 스킬을 고르지 않으면 전부 올린다", () => {
    const args = piArgs(input);
    expect(args.flatMap((a, i) => (a === "-e" ? [args[i + 1]] : []))).not.toContain(resolve("/iso", "extensions/mcp.ts"));
    expect(args[args.indexOf("--skill") + 1]).toBe(join("/h", "skills"));
    expect(piEnv(input, "observe")).not.toHaveProperty("PI_ISOLATION_MCP_SERVERS");
    // 빈 배열이면 스킬 없이
    expect(piArgs({ ...input, duty: { ...duty, skills: [] } })).not.toContain("--skill");
  });
});

describe("EventSummary", () => {
  it("세션 id, 마지막 답변, 비용, 새 제안 수를 모은다", () => {
    const s = new EventSummary();
    const usage = (tokens: number, cost: number) => ({ totalTokens: tokens, cost: { total: cost } });
    const lines = [
      { type: "session", id: "sess-1" },
      { type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [], usage: usage(10, 0.001) } },
      { type: "tool_execution_end", toolName: "mate_propose", isError: false, result: { details: { added: true } } },
      { type: "tool_execution_end", toolName: "mate_propose", isError: false, result: { details: { added: false } } },
      {
        type: "message_end",
        message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "요약입니다" }], usage: usage(5, 0.002) },
      },
      { type: "agent_settled", aborted: false },
    ];
    for (const l of lines) s.push(JSON.stringify(l));
    s.push("not json");
    expect(s).toMatchObject({ sessionId: "sess-1", lastText: "요약입니다", tokens: 15, proposals: 1, settled: true, errorMessage: undefined });
    expect(s.costUsd).toBeCloseTo(0.003);
  });

  it("모델 오류로 끝나면 오류를 남긴다", () => {
    const s = new EventSummary();
    s.push(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "Connection error", content: [] } }));
    expect(s.errorMessage).toBe("Connection error");
  });
});
