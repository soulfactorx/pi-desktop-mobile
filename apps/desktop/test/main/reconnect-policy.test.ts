import { describe, expect, it } from "vitest";
import { MAX_AUTO_RETRIES, retryDelay } from "../../src/main/reconnect-policy";

describe("retryDelay", () => {
  it("실패할수록 길게 기다리되 30초를 넘지 않는다", () => {
    expect(retryDelay(1)).toBe(500);
    expect(retryDelay(2)).toBe(1000);
    expect(retryDelay(5)).toBe(8000);
    expect([1, 2, 3, 4, 5].every((n) => (retryDelay(n) ?? 0) <= 30_000)).toBe(true);
  });

  it("연달아 여러 번 실패하면 자동으로 다시 붙지 않는다 (사용자가 다시 연결)", () => {
    expect(retryDelay(MAX_AUTO_RETRIES - 1)).toBeDefined();
    expect(retryDelay(MAX_AUTO_RETRIES)).toBeUndefined();
  });
});
