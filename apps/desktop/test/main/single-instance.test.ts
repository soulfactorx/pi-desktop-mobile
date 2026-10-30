import { describe, expect, it } from "vitest";
import { type RevealableWindow, revealWindow, usesSingleInstanceLock } from "../../src/main/single-instance";

function fakeWindow(state: { destroyed?: boolean; minimized?: boolean; visible?: boolean }) {
  const calls: string[] = [];
  const win: RevealableWindow = {
    isDestroyed: () => state.destroyed ?? false,
    isMinimized: () => state.minimized ?? false,
    isVisible: () => state.visible ?? true,
    restore: () => calls.push("restore"),
    show: () => calls.push("show"),
    focus: () => calls.push("focus"),
  };
  return { win, calls };
}

describe("usesSingleInstanceLock", () => {
  it("설치본만 잠그고, 개발 실행은 잠그지 않는다", () => {
    expect(usesSingleInstanceLock(true)).toBe(true);
    expect(usesSingleInstanceLock(false)).toBe(false);
  });
});

describe("revealWindow", () => {
  it("떠 있는 창은 포커스만 옮긴다", () => {
    const { win, calls } = fakeWindow({});
    expect(revealWindow(win)).toBe(true);
    expect(calls).toEqual(["focus"]);
  });

  it("최소화된 창은 복원한 뒤 포커스를 옮긴다", () => {
    const { win, calls } = fakeWindow({ minimized: true });
    expect(revealWindow(win)).toBe(true);
    expect(calls).toEqual(["restore", "focus"]);
  });

  it("숨긴 창은 보이게 한 뒤 포커스를 옮긴다", () => {
    const { win, calls } = fakeWindow({ visible: false });
    expect(revealWindow(win)).toBe(true);
    expect(calls).toEqual(["show", "focus"]);
  });

  it("창이 없거나 닫혔으면 false (새로 만들게 한다)", () => {
    expect(revealWindow(undefined)).toBe(false);
    const { win, calls } = fakeWindow({ destroyed: true });
    expect(revealWindow(win)).toBe(false);
    expect(calls).toEqual([]);
  });
});
