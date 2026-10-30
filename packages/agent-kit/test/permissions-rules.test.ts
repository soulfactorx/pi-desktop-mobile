import { describe, expect, it } from "vitest";
import {
  approvalOptions,
  decisionOf,
  formatApprovalTitle,
  parseApprovalTitle,
  type ApprovalRequest,
} from "../src/approval";
import { classify, commandPattern, evaluate, folderPattern, hardBlockReason, patternMatches } from "../extensions/permissions/rules";

describe("classify", () => {
  it("읽기 도구는 묻지 않는다", () => {
    for (const tool of ["read", "grep", "find", "ls"]) expect(classify(tool, { path: "a" })).toEqual({ risk: "read" });
  });

  it("셸은 실행, 파일 쓰기·고치기는 쓰기로 묻는다", () => {
    expect(classify("bash", { command: "git status --short" }).request).toMatchObject({
      risk: "exec",
      target: "git status --short",
      pattern: "git status*",
    });
    expect(classify("edit", { path: "src/a/b.ts" }).request).toMatchObject({
      risk: "write",
      summary: "파일 고치기",
      pattern: "src/a/**",
    });
  });

  it("모르는 도구는 실행으로 보고 묻는다", () => {
    expect(classify("mcp_tool", { q: 1 }).request).toMatchObject({ risk: "exec", target: '{"q":1}', pattern: "*" });
  });
});

describe("패턴", () => {
  it("명령은 첫 두 낱말, 파일은 폴더 아래 전부", () => {
    expect(commandPattern("ls")).toBe("ls*");
    expect(commandPattern("  npm  run build ")).toBe("npm run*");
    expect(folderPattern("C:\\work\\a.txt")).toBe("C:/work/**");
    expect(folderPattern("a.txt")).toBe("*");
  });

  it("경로 글롭과 접두사 매칭", () => {
    expect(patternMatches("src/**", "src/a/b.ts")).toBe(true);
    expect(patternMatches("src/*", "src/a/b.ts")).toBe(false);
    expect(patternMatches("C:/work/**", "C:\\work\\x\\y.txt")).toBe(true);
    expect(patternMatches("git status*", "git status --short")).toBe(true);
    expect(patternMatches("git status*", "git push")).toBe(false);
    expect(patternMatches("a.txt", "a.txt")).toBe(true);
  });

  it("거부 규칙이 허용보다 먼저", () => {
    const rules = [
      { toolName: "bash", pattern: "git*", action: "allow" as const },
      { toolName: "bash", pattern: "git push*", action: "deny" as const },
    ];
    expect(evaluate(rules, "bash", "git status")).toBe("allow");
    expect(evaluate(rules, "bash", "git push origin")).toBe("deny");
    expect(evaluate(rules, "bash", "ls")).toBeUndefined();
    expect(evaluate(rules, "write", "git")).toBeUndefined();
  });
});

describe("hardBlockReason", () => {
  it("파괴적인 명령과 권한 상승을 막는다", () => {
    expect(hardBlockReason("rm -rf /")).toBeDefined();
    expect(hardBlockReason("cd /tmp && shutdown -h now")).toBeDefined();
    expect(hardBlockReason('bash -c "mkfs.ext4 /dev/sda1"')).toBeDefined();
    expect(hardBlockReason("sudo apt install x")).toBeDefined();
    expect(hardBlockReason("su''do id")).toBeDefined();
    expect(hardBlockReason(":(){ :|:& };:")).toBeDefined();
  });

  it("인자 안의 낱말 때문에 정상 조회를 막지 않는다", () => {
    expect(hardBlockReason('journalctl -b | grep -iE "shutdown|reboot"')).toBeUndefined();
    expect(hardBlockReason("rm -rf ./build")).toBeUndefined();
    expect(hardBlockReason("git status")).toBeUndefined();
  });
});

describe("승인 요청 형식", () => {
  const request: ApprovalRequest = {
    toolName: "bash",
    risk: "exec",
    summary: "명령 실행",
    target: "npm test\n  -- --watch",
    pattern: "npm test*",
  };

  it("제목을 만들고 다시 읽는다 (여러 줄 대상 포함)", () => {
    expect(parseApprovalTitle(formatApprovalTitle(request))).toEqual({
      toolName: "bash",
      riskLabel: "실행",
      summary: "명령 실행",
      target: "npm test\n  -- --watch",
    });
    expect(parseApprovalTitle("다른 확장의 질문")).toBeUndefined();
  });

  it("선택지를 결정으로 바꾸고, 취소는 거부로 본다", () => {
    const [once, session, always, deny] = approvalOptions(request);
    expect(session).toBe("이 세션에서 계속 허용: npm test*");
    expect([once, session, always, deny].map(decisionOf)).toEqual(["once", "session", "always", "deny"]);
    expect(decisionOf(undefined)).toBe("deny");
    expect(decisionOf("엉뚱한 값")).toBe("deny");
  });
});

describe("규칙 파일과 감사 기록", () => {
  it("규칙을 더하고 지우며, 감사 기록은 최근 것부터 읽는다", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { addRule, loadAudit, loadRules, removeRule } = await import("../extensions/permissions/store");
    const dir = mkdtempSync(join(tmpdir(), "rules-"));
    const rule = { toolName: "bash", pattern: "git status*", action: "allow" as const };
    await addRule(dir, rule);
    await addRule(dir, rule);
    expect(await loadRules(dir)).toEqual([rule]);
    await removeRule(dir, rule);
    expect(await loadRules(dir)).toEqual([]);
    writeFileSync(join(dir, "audit.jsonl"), '{"decision":"once"}\n깨진 줄\n{"decision":"deny"}\n');
    expect((await loadAudit(dir)).map((r) => r.decision)).toEqual(["deny", "once"]);
  });
});
