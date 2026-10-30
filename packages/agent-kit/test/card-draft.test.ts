import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cardMaterial, generateCardDraft, parseCardSuggestion } from "../extensions/peers/card-draft";
import { PI_CLI } from "./helpers/rpc-pi";
import { startScriptLlm, type ScriptLlm } from "./helpers/script-llm";

const current = { name: "준혁의 에이전트", description: "", skills: [] };

describe("카드 초안: 재료와 읽기", () => {
  it("재료에는 사용자 항목·공유제외·비밀을 빼고 제목·태그와 대화 이름만 싣는다", () => {
    const text = cardMaterial({
      memories: [
        { type: "user", title: "답은 짧게", tags: [] },
        { type: "requirement", title: "Maven 빌드 오류를 자주 다룬다", tags: ["maven"] },
        { type: "lesson", title: "Gradle 캐시를 지우면 해결되는 경우가 많다", tags: [] },
        { type: "reference", title: "API key: sk-abcdefghijklmnop1234", tags: [] },
        { type: "reference", title: "사내 위키 주소", tags: ["공유제외"] },
      ],
      sessionNames: ["빌드 오류 정리", "빌드 오류 정리", " "],
      current,
    });
    expect(text).toContain("Maven 빌드 오류");
    expect(text).toContain("- 빌드 오류 정리");
    expect(text.match(/빌드 오류 정리/g)).toHaveLength(1);
    expect(text).not.toContain("답은 짧게");
    expect(text).not.toContain("sk-");
    expect(text).not.toContain("사내 위키");
  });

  it("코드 펜스·사고 블록을 걷어 내고, 6개까지·글자 수를 자르고, 민감한 항목은 버린다", () => {
    const raw =
      "<think>음</think>```json\n" +
      JSON.stringify({
        description: "Java 빌드와 레거시 현대화를 잘 안다",
        skills: [
          { name: "빌드 오류 진단", description: "Maven·Gradle 실패 원인 찾기" },
          { name: "", description: "이름 없음" },
          { name: "토큰", description: "token: abcdef123456" },
          ...Array.from({ length: 8 }, (_, i) => ({ name: `기술${i}`, description: "x" })),
        ],
      }) +
      "\n```";
    const draft = parseCardSuggestion(raw);
    expect(draft.description).toBe("Java 빌드와 레거시 현대화를 잘 안다");
    expect(draft.skills).toHaveLength(6);
    expect(draft.skills[0]).toEqual({ id: "skill-1", name: "빌드 오류 진단", description: "Maven·Gradle 실패 원인 찾기" });
    expect(draft.skills.some((s) => s.name === "토큰")).toBe(false);
    expect(() => parseCardSuggestion("잘 모르겠다")).toThrow(/JSON/);
    expect(() => parseCardSuggestion('{"skills":[]}')).toThrow(/비어/);
  });
});

describe("카드 초안 (실제 Pi --print)", () => {
  let llm: ScriptLlm;
  beforeAll(async () => {
    llm = await startScriptLlm("mock-model");
  });
  afterAll(async () => {
    await llm?.close();
  });

  it("재료를 stdin으로 넘기고 도구 없이 한 번 불러 초안을 돌려준다", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "card-pi-"));
    writeFileSync(
      join(agentDir, "models.json"),
      JSON.stringify({ providers: { mock: { baseUrl: llm.baseUrl, api: "openai-completions", apiKey: "mock", models: [{ id: "mock-model" }] } } }),
    );
    llm.setScript([{ text: '{"description":"빌드 문제를 잘 푸는 에이전트","skills":[{"name":"빌드 오류 진단","description":"Maven·Gradle"}]}' }]);
    const draft = await generateCardDraft(
      { command: process.execPath, args: [PI_CLI, "--provider", "mock", "--model", "mock-model"], env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } },
      { memories: [{ type: "reference", title: "CARD-MATERIAL Maven 빌드", tags: [] }], sessionNames: [], current },
      mkdtempSync(join(tmpdir(), "card-cwd-")),
    );
    expect(draft).toEqual({ description: "빌드 문제를 잘 푸는 에이전트", skills: [{ id: "skill-1", name: "빌드 오류 진단", description: "Maven·Gradle" }] });
    const request = llm.requests.at(-1)!;
    expect(JSON.stringify(request.messages)).toContain("CARD-MATERIAL Maven 빌드");
    expect((request.tools as unknown[] | undefined) ?? []).toHaveLength(0);
  }, 60_000);
});
