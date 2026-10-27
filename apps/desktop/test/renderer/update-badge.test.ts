import { describe, expect, it } from "vitest";
import { updateBadgeText } from "../../src/renderer/UpdateBadge";

describe("updateBadgeText", () => {
  const base = { current: "0.1.0", mode: "auto" as const };
  it("받는 중·준비됨·새 버전일 때만 보인다", () => {
    expect(updateBadgeText(undefined)).toBeUndefined();
    expect(updateBadgeText({ ...base, status: "none" })).toBeUndefined();
    expect(updateBadgeText({ ...base, status: "disabled" })).toBeUndefined();
    expect(updateBadgeText({ ...base, status: "downloading", percent: 42 })).toBe("업데이트 받는 중 42%");
    expect(updateBadgeText({ ...base, status: "downloaded", version: "0.2.0" })).toBe("다시 시작해 0.2.0 설치");
    expect(updateBadgeText({ ...base, mode: "notify", status: "available", version: "0.2.0" })).toBe("새 버전 0.2.0");
    // 자동 설치가 되는 곳은 내려받기 전에 누르면 업데이트할지 묻는다
    expect(updateBadgeText({ ...base, status: "available", version: "0.2.0" })).toBe("새 버전 0.2.0 업데이트…");
  });
});
