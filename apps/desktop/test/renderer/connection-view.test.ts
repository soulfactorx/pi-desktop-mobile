import { describe, expect, it } from "vitest";
import { disconnectedBadgeText } from "../../src/renderer/connection-view";

describe("disconnectedBadgeText", () => {
  const base = { status: "disconnected" as const, reason: "ssh: connect to host 10.0.0.5 port 8022: Connection timed out" };

  it("다시 붙을 때까지 남은 초와 시도 횟수를 보인다", () => {
    expect(disconnectedBadgeText({ ...base, retryAt: 10_500, failures: 2, maxRetries: 6 }, 7_000)).toBe("연결 끊김 · 4초 뒤 다시 시도 (2/6)");
    expect(disconnectedBadgeText({ ...base, retryAt: 7_000, failures: 2, maxRetries: 6 }, 7_000)).toBe("다시 연결하는 중 (2/6)");
  });

  it("연달아 실패해 멈췄으면 연결 실패(누르면 다시 연결)", () => {
    expect(disconnectedBadgeText({ ...base, gaveUp: true, failures: 6, maxRetries: 6 }, 0)).toBe("연결 실패 · 다시 연결");
    expect(disconnectedBadgeText(base, 0)).toBe("연결 끊김");
  });
});
