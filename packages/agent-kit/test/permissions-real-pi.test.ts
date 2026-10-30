import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMockLlm, type MockLlm } from "../../host-agent/test/fixtures/mock-llm";
import { APPROVAL_MARKER, approvalOptions, parseApprovalTitle } from "../src/approval";
import { classify } from "../extensions/permissions/rules";
import { startPi, type RpcPi, type RpcRecord } from "./helpers/rpc-pi";
import { startScriptLlm, type ScriptLlm } from "./helpers/script-llm";

/**
 * 실제 Pi + mock LLM으로 승인 게이트를 끝까지 돌린다.
 * mock LLM은 "bash:<명령>"이라는 프롬프트를 받으면 bash 툴을 그 명령으로 호출한다 (host-agent fixture).
 */
describe("permissions (실제 Pi)", () => {
  let llm: MockLlm;
  let pi: RpcPi;
  let dataDir: string;

  beforeAll(async () => {
    llm = await startMockLlm();
    ({ pi, dataDir } = await startPi(llm.baseUrl));
  });

  afterAll(async () => {
    pi?.close();
    await llm?.close();
  });

  const isApproval = (r: RpcRecord) =>
    r.type === "extension_ui_request" && r.method === "select" && String(r.title).startsWith(APPROVAL_MARKER);
  const toolEnd = (r: RpcRecord) => r.type === "tool_execution_end";
  const settled = (r: RpcRecord) => r.type === "agent_settled";

  /** 프롬프트를 보내고 승인 요청이 오면 choose로 답한 뒤, 끝날 때까지 기다려 도구 결과를 돌려준다 */
  async function run(prompt: string, choose?: (options: string[]) => string | undefined) {
    const from = pi.mark;
    await pi.request({ type: "prompt", message: prompt });
    let asked: RpcRecord | undefined;
    if (choose) {
      asked = await pi.waitFor(isApproval, from);
      const value = choose(asked.options as string[]);
      pi.write(value === undefined ? { type: "extension_ui_response", id: asked.id, cancelled: true } : { type: "extension_ui_response", id: asked.id, value });
    }
    const end = await pi.waitFor(toolEnd, from);
    await pi.waitFor(settled, from);
    return { asked, end, askedAgain: pi.records.slice(from).filter(isApproval).length };
  }

  const resultText = (end: RpcRecord) => JSON.stringify(end.result ?? end);

  it("bash는 승인 요청을 띄우고, 제목에 명령이 실린다", async () => {
    const { asked, end } = await run("bash:echo approve-me", (options) => options[3]);
    expect(parseApprovalTitle(String(asked!.title))).toMatchObject({ toolName: "bash", target: "echo approve-me" });
    expect(asked!.options).toEqual(approvalOptions(classify("bash", { command: "echo approve-me" }).request!));
    // 거부를 골랐으므로 실행되지 않고 이유가 모델에 전달된다
    expect(end.isError).toBe(true);
    expect(resultText(end)).toContain("사용자가 거부했다");
  });

  it("취소(답 없음)도 거부로 본다", async () => {
    const { end } = await run("bash:echo cancelled", () => undefined);
    expect(end.isError).toBe(true);
  });

  it("이번만 허용하면 실행된다", async () => {
    const { end } = await run("bash:echo once-ok", (options) => options[0]);
    expect(end.isError).toBe(false);
    expect(resultText(end)).toContain("once-ok");
  });

  it("항상 허용하면 규칙이 저장되고 다음부터 묻지 않는다", async () => {
    await run("bash:echo always-1", (options) => options[2]);
    const saved = JSON.parse(readFileSync(join(dataDir, "permissions.json"), "utf8"));
    expect(saved.rules).toEqual([{ toolName: "bash", pattern: "echo always-1*", action: "allow" }]);

    const second = await run("bash:echo always-1 again");
    expect(second.askedAgain).toBe(0);
    expect(second.end.isError).toBe(false);
  });

  it("위험 명령은 묻지 않고 막는다", async () => {
    const { end, askedAgain } = await run("bash:sudo id");
    expect(askedAgain).toBe(0);
    expect(end.isError).toBe(true);
    expect(resultText(end)).toContain("권한 상승");
  });

  it("판단을 감사 로그에 남긴다", () => {
    const path = join(dataDir, "audit.jsonl");
    expect(existsSync(path)).toBe(true);
    const decisions = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line).decision);
    expect(decisions).toEqual(["deny", "deny", "once", "always", "allow-rule", "blocked"]);
  });
});

/** 같은 실행 안에서 거부한 호출을 모델이 다시 부르는 경우 (스크립트 LLM으로 같은 호출을 두 번 만든다) */
describe("permissions — 거부한 호출을 되풀이할 때 (실제 Pi)", () => {
  let llm: ScriptLlm;
  let pi: RpcPi;

  beforeAll(async () => {
    llm = await startScriptLlm("mock-model");
    ({ pi } = await startPi(llm.baseUrl));
  });

  afterAll(async () => {
    pi?.close();
    await llm?.close();
  });

  it("다시 묻지 않고 거부하고, 다음 요청에서는 다시 묻는다", async () => {
    const bash = { tool: "bash", args: { command: "echo again" } };
    llm.setScript([bash, bash, { text: "포기" }]);
    let from = pi.mark;
    await pi.request({ type: "prompt", message: "실행해" });
    const asked = await pi.waitFor((r) => r.type === "extension_ui_request" && r.method === "select", from);
    pi.write({ type: "extension_ui_response", id: asked.id, value: (asked.options as string[])[3] });
    await pi.waitFor((r) => r.type === "agent_settled", from);
    const run = pi.records.slice(from);
    expect(run.filter((r) => r.type === "extension_ui_request" && r.method === "select")).toHaveLength(1);
    const ends = run.filter((r) => r.type === "tool_execution_end");
    expect(ends.map((r) => r.isError)).toEqual([true, true]);
    expect(JSON.stringify(ends[1]!.result)).toContain("다시 묻지 않고 거부");

    llm.setScript([bash, { text: "끝" }]);
    from = pi.mark;
    await pi.request({ type: "prompt", message: "이번엔 실행해" });
    const again = await pi.waitFor((r) => r.type === "extension_ui_request" && r.method === "select", from);
    pi.write({ type: "extension_ui_response", id: again.id, value: (again.options as string[])[0] });
    await pi.waitFor((r) => r.type === "agent_settled", from);
  });
});
