import { describe, expect, it } from "vitest";
import {
  baseName,
  htmlExportPath,
  formatCost,
  formatPercent,
  formatMessageTime,
  formatRelative,
  formatUsageLine,
  formatTokens,
  modelKey,
} from "../../src/renderer/format";

describe("formatTokens", () => {
  it("크기에 따라 k, M 단위로 줄인다", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(12_300)).toBe("12.3k");
    expect(formatTokens(200_000)).toBe("200k");
    expect(formatTokens(1_500_000)).toBe("1.5M");
  });

  it("값이 없으면 –", () => {
    expect(formatTokens(null)).toBe("–");
    expect(formatTokens(undefined)).toBe("–");
  });
});

describe("formatCost", () => {
  it("1센트 미만은 소수 넷째 자리까지", () => {
    expect(formatCost(0)).toBe("$0");
    expect(formatCost(0.0034)).toBe("$0.0034");
    expect(formatCost(0.45)).toBe("$0.45");
    expect(formatCost(12.3)).toBe("$12.30");
  });
});

describe("modelKey", () => {
  it("프로바이더와 ID를 묶는다 (ID에 '/'가 있어도 그대로)", () => {
    expect(modelKey({ provider: "openrouter", id: "meta-llama/llama-4" })).toBe("openrouter/meta-llama/llama-4");
  });
});

describe("formatPercent", () => {
  it("10% 미만은 소수 한 자리, 그 이상은 반올림", () => {
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(0.29)).toBe("0.3%");
    expect(formatPercent(4)).toBe("4%");
    expect(formatPercent(30.6)).toBe("31%");
    expect(formatPercent(null)).toBe("–");
  });
});

describe("formatRelative", () => {
  const now = new Date(2026, 9, 20, 12, 0, 0).getTime();
  it("지난 시간에 따라 방금·분·시간·일·날짜로 표시한다", () => {
    expect(formatRelative(now - 30_000, now)).toBe("방금");
    expect(formatRelative(now - 5 * 60_000, now)).toBe("5분 전");
    expect(formatRelative(now - 3 * 3_600_000, now)).toBe("3시간 전");
    expect(formatRelative(now - 2 * 86_400_000, now)).toBe("2일 전");
    expect(formatRelative(new Date(2026, 0, 5).getTime(), now)).toBe("2026-01-05");
  });
});

describe("baseName", () => {
  it("Windows와 POSIX 경로 모두에서 마지막 폴더 이름을 준다", () => {
    expect(baseName("C:\\Users\\me\\project\\")).toBe("project");
    expect(baseName("/home/me/app")).toBe("app");
    expect(baseName("/")).toBe("/");
  });
});

describe("htmlExportPath", () => {
  it("세션 파일 옆에 확장자만 html로", () => {
    expect(htmlExportPath(String.raw`C:\Users\me\.pi\agent\sessions\x\2026_abc.jsonl`)).toBe(
      String.raw`C:\Users\me\.pi\agent\sessions\x\2026_abc.html`,
    );
    expect(htmlExportPath("/home/me/.pi/agent/sessions/x/a.JSONL")).toBe("/home/me/.pi/agent/sessions/x/a.html");
    expect(htmlExportPath("/tmp/a")).toBe("/tmp/a.html");
    expect(htmlExportPath(undefined)).toBeUndefined();
  });
});

describe("formatMessageTime·formatUsageLine", () => {
  it("오늘은 시각만, 올해는 월/일, 그 밖에는 날짜까지", () => {
    const now = new Date(2026, 10, 1, 18, 0).getTime();
    expect(formatMessageTime(new Date(2026, 10, 1, 9, 5).getTime(), now)).toBe("09:05");
    expect(formatMessageTime(new Date(2026, 9, 30, 21, 7).getTime(), now)).toBe("10/30 21:07");
    expect(formatMessageTime(new Date(2025, 0, 2, 3, 4).getTime(), now)).toBe("2025-01-02 03:04");
  });

  it("입력(캐시 쓰기 포함)·캐시 읽기·출력·비용을 짧게, 없는 것은 뺀다", () => {
    expect(formatUsageLine({ input: 1000, cacheWrite: 200, cacheRead: 5000, output: 320, cost: 0.0021 })).toBe("입력 1.2k · 캐시 5k · 출력 320 · $0.0021");
    expect(formatUsageLine({ input: 10, cacheWrite: 0, cacheRead: 0, output: 5 })).toBe("입력 10 · 출력 5");
  });
});
