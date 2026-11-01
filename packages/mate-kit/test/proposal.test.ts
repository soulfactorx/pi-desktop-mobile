import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendProposal, installError, makeProposal, proposalHash, readInbox } from "../src/proposal";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("proposal", () => {
  it("같은 임무의 같은 제목·요약은 같은 해시 (공백 차이 무시)", () => {
    expect(proposalHash("d", "CI 실패", "unit  테스트")).toBe(proposalHash("d", " CI 실패", "unit 테스트\n"));
    expect(proposalHash("d", "CI 실패", "x")).not.toBe(proposalHash("other", "CI 실패", "x"));
  });

  it("인박스에 쌓고, 이미 있는 제안은 다시 쌓지 않는다", async () => {
    dir = await mkdtemp(join(tmpdir(), "mate-inbox-"));
    const path = join(dir, "nested", "inbox.jsonl");
    const ids = { dutyId: "brief", runId: "r1" };
    expect(await appendProposal(path, makeProposal({ title: "A", summary: "s", severity: "warn" }, ids, 1))).toBe(true);
    expect(await appendProposal(path, makeProposal({ title: "A", summary: "s" }, { ...ids, runId: "r2" }, 2))).toBe(false);
    expect(await appendProposal(path, makeProposal({ title: "B", summary: "s", detail: "  " }, ids, 3))).toBe(true);
    const items = await readInbox(path);
    expect(items.map((i) => [i.title, i.severity, i.detail])).toEqual([["A", "warn", undefined], ["B", "info", undefined]]);
  });
});

describe("설치 제안 검사", () => {
  it("스킬 초안은 이름 규칙과 frontmatter가 있어야 하고, MCP·복사는 형식만 본다", () => {
    expect(installError({ kind: "skill", name: "hn-summary", content: "---\nname: hn-summary\ndescription: HN 글 요약\n---\n1. 본다" })).toBeUndefined();
    expect(installError({ kind: "skill", name: "HN", content: "---\ndescription: x\n---\n" })).toMatch(/이름/);
    expect(installError({ kind: "skill", name: "a", content: "그냥 글" })).toMatch(/frontmatter/);
    expect(installError({ kind: "mcp", preset: "exa" })).toBeUndefined();
    expect(installError({ kind: "mcp", preset: "../x" })).toMatch(/목록/);
    expect(installError({ kind: "copy", from: "agent", name: "weekly-report" })).toBeUndefined();
    expect(installError({ kind: "copy", from: "other" as "agent", name: "a" })).toMatch(/from/);
    expect(installError({ kind: "prompt", name: "daily", content: "---\ndescription: 하루 정리\n---\n정리해" })).toBeUndefined();
    expect(installError({ kind: "prompt", name: "Daily", content: "x" })).toMatch(/이름/);
    expect(installError({ kind: "package", source: "npm:pi-web-access" })).toBeUndefined();
    expect(installError({ kind: "package", source: "./local; rm -rf /" })).toMatch(/source/);
  });
});
