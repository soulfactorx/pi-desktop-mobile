import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extensionEntries, readBlocked, readInbox } from "@pi-desktop/mate-kit";
import { isolationDirOf, runPi, type RunInput } from "../src/executor";
import type { Duty } from "../src/types";
import { startMockLlm, type MockLlm } from "../../host-agent/test/fixtures/mock-llm";

/**
 * 실제 Pi + 테스트용 MCP 서버로 임무의 MCP 도구 권한을 확인한다 (설계 DESIGN-MATE.md §4 "권한 요청" 5).
 * mock LLM은 "tool:<이름> <JSON>" 메시지를 받으면 그 도구를 부른다.
 */
const repo = resolve(__dirname, "../../..");
const kitDir = join(repo, "packages/mate-kit");
const cliPath = join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");

describe("임무의 MCP 도구 (실제 Pi)", () => {
  let llm: MockLlm;
  let piDir: string;
  let home: string;

  beforeAll(async () => {
    llm = await startMockLlm();
    piDir = mkdtempSync(join(tmpdir(), "mate-mcp-pi-"));
    writeFileSync(join(piDir, "models.json"), JSON.stringify({ providers: { mock: { baseUrl: llm.baseUrl, api: "openai-completions", apiKey: "mock", models: [{ id: "mock-model" }] } } }));
    home = mkdtempSync(join(tmpdir(), "mate-mcp-home-"));
    const fake = { command: process.execPath, args: [join(repo, "packages/pi-isolation/test/fixtures/fake-mcp.mjs")] };
    writeFileSync(join(home, "mcp.json"), JSON.stringify({ mcpServers: { fake } }));
  });

  afterAll(async () => {
    await llm?.close();
  });

  const run = async (grants: string[], runId: string, override: Partial<Duty> = {}) => {
    const duty: Duty = {
      id: "mcp-test",
      name: "MCP 시험",
      enabled: true,
      cwd: home,
      prompt: 'tool:mcp__fake__echo {"text":"안녕"}',
      profile: "observe",
      trigger: { kind: "manual" },
      mcpServers: ["fake"],
      ...(grants.length ? { grants } : {}),
      createdAt: 0,
      ...override,
    };
    const blockedPath = join(home, "blocked", `${runId}.jsonl`);
    const input: RunInput = {
      duty,
      runId,
      model: "mock/mock-model",
      extensions: await extensionEntries(kitDir),
      home,
      isolationDir: isolationDirOf(kitDir),
      inboxPath: join(home, "inbox.jsonl"),
      sessionsDir: join(home, "sessions"),
      timeoutSec: 60,
      maxCostUsd: 0,
      blockedPath,
    };
    const outcome = await runPi({ cliPath, env: { PI_CODING_AGENT_DIR: piDir } }, input);
    return { outcome, blocked: await readBlocked(blockedPath) };
  };

  it("허용하지 않은 도구는 막고 설명과 함께 기록하며, 허용하면 통과한다", async () => {
    const first = await run([], "r1");
    expect(first.outcome.status, first.outcome.error).toBe("done");
    expect(first.blocked).toEqual([{ name: "mcp__fake__echo", command: "받은 글을 그대로 돌려준다", at: expect.any(Number) }]);
    expect(first.outcome.summary).not.toContain("echo: 안녕");

    const second = await run(["mcp__fake__echo"], "r2");
    expect(second.outcome.status, second.outcome.error).toBe("done");
    expect(second.blocked).toEqual([]);
    // mock LLM은 도구 결과를 그대로 답한다
    expect(second.outcome.summary).toContain("echo: 안녕");
  });

  it("제안 단계에서 install을 붙인 mate_propose는 인박스에 설치 제안으로 남는다", async () => {
    const install = { kind: "skill", name: "hn-summary", content: "---\nname: hn-summary\ndescription: HN 요약\n---\n1. 본다" };
    const prompt = `tool:mate_propose ${JSON.stringify({ title: "HN 요약 스킬", summary: "요약 규칙이 없어 초안을 만들었다", install })}`;
    const { outcome } = await run([], "r3", { profile: "propose", prompt, mcpServers: [] });
    expect(outcome.status, outcome.error).toBe("done");
    const item = (await readInbox(join(home, "inbox.jsonl"))).find((i) => i.title === "HN 요약 스킬");
    expect(item?.install).toEqual(install);
  });
});
