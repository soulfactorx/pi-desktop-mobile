import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunGuard, SPIN_LIMIT, callKey } from "../extensions/loop-guard/guard";
import { startPi, type RpcPi, type RpcRecord } from "./helpers/rpc-pi";
import { startScriptLlm, type ScriptLlm } from "./helpers/script-llm";

describe("RunGuard", () => {
  it("성공한 같은 조회만 막고, 키 순서는 따지지 않는다", () => {
    const guard = new RunGuard();
    expect(guard.checkCall("read", { path: "a", limit: 10 })).toBeUndefined();
    guard.recordResult("read", { path: "a", limit: 10 }, false);
    expect(guard.checkCall("read", { limit: 10, path: "a" })).toBeDefined();
    expect(guard.checkCall("read", { path: "b" })).toBeUndefined();
    // 실패한 조회는 기억하지 않는다 (그 사이에 파일이 생길 수 있다)
    guard.recordResult("read", { path: "c" }, true);
    expect(guard.checkCall("read", { path: "c" })).toBeUndefined();
    expect(callKey("ls", { b: 1, a: 2 })).toBe('ls {"a":2,"b":1}');
  });

  it("쓰기·실행이 성공하면 앞선 조회를 잊는다", () => {
    const guard = new RunGuard();
    guard.recordResult("ls", { path: "." }, false);
    guard.recordResult("bash", { command: "touch x" }, false);
    expect(guard.checkCall("ls", { path: "." })).toBeUndefined();
  });

  it("같은 문단을 다시 쓰면 세고, 짧은 말은 세지 않는다", () => {
    const guard = new RunGuard();
    const long = "README를 확인했지만 설치 방법에 대한 설명은 찾지 못했습니다. 다른 파일도 살펴보겠습니다.";
    guard.recordText(`확인했습니다.\n\n${long}`);
    guard.recordText(`확인했습니다.\n\n${long.replace(/ /g, "  ")}`);
    expect(guard.spins).toBe(1);
  });

  it("신호가 쌓이면 멈춤 상태가 되고, reset으로 처음부터 센다", () => {
    const guard = new RunGuard();
    guard.recordResult("read", { path: "a" }, false);
    for (let i = 0; i < SPIN_LIMIT; i++) guard.checkCall("read", { path: "a" });
    expect(guard.stopped).toBe(true);
    guard.reset();
    expect(guard.stopped).toBe(false);
    expect(guard.checkCall("read", { path: "a" })).toBeUndefined();
  });
});

describe("loop-guard (실제 Pi)", () => {
  let llm: ScriptLlm;
  let pi: RpcPi;

  beforeAll(async () => {
    llm = await startScriptLlm("mock-model");
    ({ pi } = await startPi(llm.baseUrl, { files: { "hello.txt": "안녕\n" } }));
  });

  afterAll(async () => {
    pi?.close();
    await llm?.close();
  });

  const toolEnds = (from: number) => pi.records.slice(from).filter((r) => r.type === "tool_execution_end");
  const textOf = (r: RpcRecord) => JSON.stringify(r.result ?? r);

  it("같은 읽기를 되풀이하면 두 번째부터 막고, 쌓이면 실행을 멈춘다", async () => {
    const read = { tool: "read", args: { path: "hello.txt" } };
    llm.setScript([read, read, read, read, read, { text: "다 읽었다" }]);
    const from = pi.mark;
    await pi.request({ type: "prompt", message: "hello.txt를 읽어" });
    const notice = await pi.waitFor((r) => r.type === "extension_ui_request" && r.method === "notify", from);
    await pi.waitFor((r) => r.type === "agent_settled", from);

    const ends = toolEnds(from);
    expect(ends[0]?.isError).toBe(false);
    expect(ends.slice(1).every((r) => r.isError === true)).toBe(true);
    expect(textOf(ends[1]!)).toContain("이미 똑같은 조회");
    // 첫 번째 성공 + 막힌 SPIN_LIMIT번까지만 가고, 그 뒤로는 더 부르지 않는다
    expect(ends.length).toBeLessThanOrEqual(1 + SPIN_LIMIT);
    expect(String(notice.message)).toContain("되풀이");
  });

  it("새 요청은 처음부터 센다", async () => {
    llm.setScript([{ tool: "read", args: { path: "hello.txt" } }, { text: "읽었다" }]);
    const from = pi.mark;
    await pi.request({ type: "prompt", message: "다시 읽어" });
    await pi.waitFor((r) => r.type === "agent_settled", from);
    expect(toolEnds(from).map((r) => r.isError)).toEqual([false]);
  });
});
