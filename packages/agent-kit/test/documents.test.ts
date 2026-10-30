import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chunkChars, defaultOutputPath, inferMode, splitIntoChunks } from "../extensions/documents/chunks";
import { docxText, wordXmlToText } from "../extensions/documents/docx";
import { classify } from "../extensions/permissions/rules";
import { makeDocx } from "./helpers/docx";
import { startPi, type RpcPi, type RpcRecord } from "./helpers/rpc-pi";
import { startScriptLlm, type ScriptLlm } from "./helpers/script-llm";

describe("문서 조각과 분류", () => {
  it("조각 크기는 창의 30%(토큰당 2글자)이고 상·하한이 있다", () => {
    expect(chunkChars(8192)).toBe(4914);
    expect(chunkChars(1000)).toBe(1500);
    expect(chunkChars(1_000_000)).toBe(40_000);
  });

  it("문단 경계에서 나누고, 긴 문단은 그 안에서 자른다", () => {
    expect(splitIntoChunks("가\n\n나\n\n다", 4)).toEqual(["가\n\n나", "다"]);
    expect(splitIntoChunks("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("지시로 처리 방식을 짐작하고, 결과 경로를 만든다", () => {
    expect(inferMode("영어로 번역해")).toBe("transform");
    expect(inferMode("핵심만 요약")).toBe("reduce");
    expect(defaultOutputPath("docs/보고서.docx")).toBe("docs/보고서.result.md");
    expect(defaultOutputPath("C:\\a.b\\noext")).toBe("C:\\a.b\\noext.result.md");
  });

  it("요약은 묻지 않고, 번역은 결과 파일 경로로 묻는다", () => {
    expect(classify("process_document", { path: "a.txt", instruction: "요약" })).toEqual({ risk: "read" });
    expect(classify("process_document", { path: "d/a.txt", instruction: "번역" }).request).toMatchObject({
      risk: "write",
      target: "d/a.result.md",
      pattern: "d/**",
    });
  });

  it("docx 본문(문단·탭·줄바꿈·엔티티)을 뽑는다", () => {
    expect(docxText(makeDocx(["첫 문단 & <꺾쇠>", "둘째 문단"]))).toBe("첫 문단 & <꺾쇠>\n둘째 문단");
    expect(wordXmlToText('<w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t></w:r></w:p><w:p w:rsid="x"><w:r><w:t>d</w:t></w:r></w:p>')).toBe(
      "a\tb\nc\nd",
    );
  });
});

describe("process_document (실제 Pi)", () => {
  let llm: ScriptLlm;
  let pi: RpcPi;
  let projectDir: string;
  // 창 8192 → 조각 4914자. 3000자 문단 셋은 조각 셋이 된다
  const paragraphs = ["가", "나", "다"].map((c) => c.repeat(3000));

  beforeAll(async () => {
    llm = await startScriptLlm("mock-model");
    ({ pi, projectDir } = await startPi(llm.baseUrl, { contextWindow: 8192, files: { "long.txt": paragraphs.join("\n\n") } }));
    writeFileSync(join(projectDir, "memo.docx"), makeDocx(["회의 메모", "다음 주 배포 확정"]));
  });

  afterAll(async () => {
    pi?.close();
    await llm?.close();
  });

  const lastToolEnd = (from: number) => pi.records.slice(from).filter((r: RpcRecord) => r.type === "tool_execution_end").at(-1);
  const userTexts = (requests: Array<Record<string, unknown>>) => requests.map((r) => JSON.stringify((r.messages as unknown[]).at(-1)));

  it("reduce: 조각마다 뽑고 한 번 더 모아 답한다 (승인 없이)", async () => {
    const before = llm.requests.length;
    llm.setScript([
      { tool: "process_document", args: { path: "long.txt", instruction: "핵심만 요약", mode: "reduce" } },
      { text: "부분1" },
      { text: "부분2" },
      { text: "부분3" },
      { text: "최종 요약" },
      { text: "끝" },
    ]);
    const from = pi.mark;
    await pi.request({ type: "prompt", message: "요약해" });
    await pi.waitFor((r) => r.type === "agent_settled", from);

    expect(pi.records.slice(from).some((r) => r.type === "extension_ui_request" && r.method === "select")).toBe(false);
    expect(JSON.stringify(lastToolEnd(from)?.result)).toContain("최종 요약");
    const sent = userTexts(llm.requests.slice(before + 1, before + 5));
    expect(sent[1]).toContain("[부분 2/3]");
    expect(sent[3]).toContain("[부분 3에서 뽑은 것]");
  });

  it("transform: 승인 뒤 조각 결과를 이어 붙여 파일로 쓴다", async () => {
    llm.setScript([
      { tool: "process_document", args: { path: "long.txt", instruction: "영어로 번역", output: "long.en.md" } },
      { text: "A" },
      { text: "B" },
      { text: "C" },
      { text: "끝" },
    ]);
    const from = pi.mark;
    await pi.request({ type: "prompt", message: "번역해" });
    const asked = await pi.waitFor((r) => r.type === "extension_ui_request" && r.method === "select", from);
    expect(String(asked.title)).toContain("long.en.md");
    pi.write({ type: "extension_ui_response", id: asked.id, value: (asked.options as string[])[0] });
    await pi.waitFor((r) => r.type === "agent_settled", from);
    expect(readFileSync(join(projectDir, "long.en.md"), "utf8")).toBe("A\n\nB\n\nC\n");
  });

  it("docx 본문을 모델에 넘긴다", async () => {
    const before = llm.requests.length;
    llm.setScript([{ tool: "process_document", args: { path: "memo.docx", instruction: "무엇이 확정됐나?" } }, { text: "배포가 확정됐다" }, { text: "끝" }]);
    const from = pi.mark;
    await pi.request({ type: "prompt", message: "메모 봐 줘" });
    await pi.waitFor((r) => r.type === "agent_settled", from);
    expect(userTexts(llm.requests.slice(before + 1, before + 2))[0]).toContain("다음 주 배포 확정");
    expect(JSON.stringify(lastToolEnd(from)?.result)).toContain("배포가 확정됐다");
  });
});
