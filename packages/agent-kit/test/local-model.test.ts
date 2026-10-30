import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  compactionProblem,
  effectiveCompaction,
  isLocalBaseUrl,
  ollamaRoot,
  shrink,
  suggestedCompaction,
  toolResultChars,
} from "../extensions/local-model/budget";
import { startPi, type RpcPi, type RpcRecord } from "./helpers/rpc-pi";
import { startScriptLlm, type ScriptLlm } from "./helpers/script-llm";

describe("budget", () => {
  it("로컬 서버 주소와 Ollama 뿌리 주소", () => {
    expect(isLocalBaseUrl("http://localhost:11434/v1")).toBe(true);
    expect(isLocalBaseUrl("http://127.0.0.1:8080")).toBe(true);
    expect(isLocalBaseUrl("https://api.openai.com/v1")).toBe(false);
    expect(isLocalBaseUrl(undefined)).toBe(false);
    expect(ollamaRoot("http://localhost:11434/v1/")).toBe("http://localhost:11434");
  });

  it("Pi 기본 압축 설정은 8192 창에 맞지 않고, 제안값은 맞는다", () => {
    expect(compactionProblem(8192, { reserveTokens: 16384, keepRecentTokens: 20000 })).toContain("reserveTokens");
    expect(suggestedCompaction(8192)).toEqual({ reserveTokens: 2048, keepRecentTokens: 2867 });
    expect(compactionProblem(8192, suggestedCompaction(8192))).toBeUndefined();
    expect(compactionProblem(200_000, { reserveTokens: 16384, keepRecentTokens: 20000 })).toBeUndefined();
  });

  it("모델별 설정 → 일반 설정 → 기본값 순으로 읽는다", () => {
    const settings = { compaction: { reserveTokens: 4000, modelOverrides: { "ollama/q": { keepRecentTokens: 1000 } } } };
    expect(effectiveCompaction(settings, "ollama/q")).toEqual({ reserveTokens: 4000, keepRecentTokens: 1000 });
    expect(effectiveCompaction(settings, "other/m")).toEqual({ reserveTokens: 4000, keepRecentTokens: 20000 });
    expect(effectiveCompaction(undefined, "x")).toEqual({ reserveTokens: 16384, keepRecentTokens: 20000 });
  });

  it("도구 결과 예산과 자르기", () => {
    expect(toolResultChars(4096)).toBe(3072);
    expect(toolResultChars(1000)).toBe(1200);
    expect(shrink("짧다", 100)).toBeUndefined();
    expect(shrink("x".repeat(5000), 1000)).toEqual({ preview: "x".repeat(800), total: 5000 });
  });
});

/** Ollama를 흉내 내는 스크립트 LLM: 설정 창 8192, 서버가 실제로 연 창 4096, 사고 지원 */
describe("local-model (실제 Pi)", () => {
  let llm: ScriptLlm;
  let pi: RpcPi;
  let dataDir: string;
  let piAgentDir: string;
  const big = Array.from({ length: 1000 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");

  beforeAll(async () => {
    llm = await startScriptLlm("mock-model", { contextLength: 4096, capabilities: ["completion", "tools", "thinking"] });
    ({ pi, dataDir, piAgentDir } = await startPi(llm.baseUrl, { contextWindow: 8192, files: { "big.txt": big } }));
  });

  afterAll(async () => {
    pi?.close();
    await llm?.close();
  });

  const notices = (from: number) =>
    pi.records.slice(from).filter((r) => r.type === "extension_ui_request" && r.method === "notify").map((r) => String(r.message));
  const lastToolText = (from: number) => {
    const end = pi.records.slice(from).filter((r: RpcRecord) => r.type === "tool_execution_end").at(-1);
    return JSON.stringify(end?.result ?? "");
  };

  it("첫 요청에서 창 불일치와 압축 설정을 알리고, 사고를 끄고, 큰 read 결과를 줄인다", async () => {
    llm.setScript([{ tool: "read", args: { path: "big.txt" } }, { text: "읽었다" }]);
    const from = pi.mark;
    await pi.request({ type: "prompt", message: "big.txt 읽어" });
    await pi.waitFor((r) => r.type === "agent_settled", from);

    const warned = notices(from);
    expect(warned.some((m) => m.includes("4096") && m.includes("8192"))).toBe(true);
    expect(warned.some((m) => m.includes("/agent:local-setup"))).toBe(true);
    expect(llm.requests[0]?.reasoning_effort).toBe("none");

    const text = lastToolText(from);
    expect(text).toContain("앞부분만 보냈다");
    expect(text).toContain("offset/limit");
    expect(text.length).toBeLessThan(big.length);
  });

  it("경고는 모델마다 한 번만 낸다", async () => {
    llm.setScript([{ text: "응" }]);
    const from = pi.mark;
    await pi.request({ type: "prompt", message: "안녕" });
    await pi.waitFor((r) => r.type === "agent_settled", from);
    expect(notices(from)).toEqual([]);
  });

  it("셸 결과가 크면 전문을 파일로 남기고 경로를 알려 준다", async () => {
    llm.setScript([{ tool: "bash", args: { command: "cat big.txt" } }, { text: "봤다" }]);
    const from = pi.mark;
    await pi.request({ type: "prompt", message: "cat 해" });
    const asked = await pi.waitFor((r) => r.type === "extension_ui_request" && r.method === "select", from);
    pi.write({ type: "extension_ui_response", id: asked.id, value: (asked.options as string[])[0] });
    await pi.waitFor((r) => r.type === "agent_settled", from);

    const text = lastToolText(from);
    const saved = /전문은 (.+?\.txt) 에 저장했다/.exec(JSON.parse(text).content?.[0]?.text ?? text)?.[1];
    expect(saved).toBeDefined();
    expect(saved!.startsWith(join(dataDir, "outputs"))).toBe(true);
    expect(readFileSync(saved!, "utf8")).toContain("line 999");
  });

  it("/agent:local-setup은 확인을 받고 이 모델의 압축 설정을 settings.json에 저장한다", async () => {
    const from = pi.mark;
    // 확장 명령은 핸들러가 끝나야 prompt 응답이 온다. 확인 창에 답하기 전에 응답을 기다리면 서로 기다리게 된다
    const response = pi.request({ type: "prompt", message: "/agent:local-setup" });
    const asked = await pi.waitFor((r) => r.type === "extension_ui_request" && r.method === "confirm", from);
    expect(String(asked.message)).toContain("reserveTokens 1024");
    pi.write({ type: "extension_ui_response", id: asked.id, confirmed: true });
    expect((await response).success).toBe(true);
    await pi.waitFor((r) => r.type === "extension_ui_request" && r.method === "notify" && String(r.message).includes("저장했습니다"), from);

    const path = join(piAgentDir, "settings.json");
    expect(existsSync(path)).toBe(true);
    const settings = JSON.parse(readFileSync(path, "utf8"));
    expect(settings.compaction.modelOverrides["mock/mock-model"]).toEqual({ reserveTokens: 1024, keepRecentTokens: 1433 });
  });
});
