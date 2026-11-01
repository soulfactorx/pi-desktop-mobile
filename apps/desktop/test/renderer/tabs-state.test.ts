import { describe, expect, it } from "vitest";
import { addTab, attentionFor, closeTab, cycleTab, restorableTabIds, duplicateSessionTabs } from "../../src/renderer/tabs-state";

describe("탭 목록", () => {
  it("새 탭은 지금 탭 오른쪽에 열리고 활성화된다", () => {
    expect(addTab({ ids: ["a", "b", "c"], active: "a" }, "n")).toEqual({ ids: ["a", "n", "b", "c"], active: "n" });
  });

  it("활성 탭을 닫으면 오른쪽 탭, 맨 끝이면 왼쪽 탭을 연다", () => {
    expect(closeTab({ ids: ["a", "b", "c"], active: "b" }, "b")).toEqual({ ids: ["a", "c"], active: "c" });
    expect(closeTab({ ids: ["a", "b", "c"], active: "c" }, "c")).toEqual({ ids: ["a", "b"], active: "b" });
  });

  it("활성 탭이 아닌 탭을 닫으면 활성 탭은 그대로", () => {
    expect(closeTab({ ids: ["a", "b"], active: "a" }, "b")).toEqual({ ids: ["a"], active: "a" });
  });

  it("마지막 탭이나 없는 탭은 닫지 않는다", () => {
    const one = { ids: ["a"], active: "a" };
    expect(closeTab(one, "a")).toBe(one);
    const two = { ids: ["a", "b"], active: "a" };
    expect(closeTab(two, "z")).toBe(two);
  });

  it("다음·이전 탭으로 돌고 끝에서는 반대쪽으로 넘어간다", () => {
    expect(cycleTab({ ids: ["a", "b", "c"], active: "c" }, 1).active).toBe("a");
    expect(cycleTab({ ids: ["a", "b", "c"], active: "a" }, -1).active).toBe("c");
  });
});

describe("attentionFor", () => {
  it("실행이 끝나면 done, 입력이 필요해지면 input (입력을 먼저)", () => {
    expect(attentionFor({ running: true, needsInput: false }, { running: false, needsInput: false })).toBe("done");
    expect(attentionFor({ running: true, needsInput: false }, { running: true, needsInput: true })).toBe("input");
    expect(attentionFor({ running: true, needsInput: false }, { running: false, needsInput: true })).toBe("input");
  });

  it("변화가 없거나 처음 받은 상태면 알리지 않는다", () => {
    expect(attentionFor({ running: false, needsInput: false }, { running: false, needsInput: false })).toBeUndefined();
    expect(attentionFor(undefined, { running: false, needsInput: false })).toBeUndefined();
    expect(attentionFor({ running: false, needsInput: true }, { running: false, needsInput: true })).toBeUndefined();
  });
});

describe("restorableTabIds", () => {
  it("다시 열 때 첫 탭과 세션이 기억된 탭만 되살린다 (빈 새 탭은 빼서 실행할 때마다 따라 나오지 않게)", () => {
    const withSession = new Set(["t2"]);
    expect(restorableTabIds(["main", "t1", "t2"], "main", (id) => withSession.has(id))).toEqual(["main", "t2"]);
    expect(restorableTabIds(["main"], "main", () => false)).toEqual(["main"]);
  });
});

describe("duplicateSessionTabs", () => {
  const s = (hostId: string, sessionId?: string) => ({ hostId, sessionId });

  it("같은 세션을 보는 탭은 지금 보는 탭만 남긴다", () => {
    const state = { ids: ["main", "a", "b"], active: "b" };
    expect(duplicateSessionTabs(state, { main: s("local", "x"), a: s("local", "x"), b: s("local", "x") })).toEqual(["main", "a"]);
  });

  it("지금 보는 탭이 아니면 왼쪽 탭을 남긴다", () => {
    const state = { ids: ["main", "a", "b"], active: "main" };
    expect(duplicateSessionTabs(state, { main: s("local", "y"), a: s("local", "x"), b: s("local", "x") })).toEqual(["b"]);
  });

  it("세션이 없거나 호스트가 다르면 겹치지 않는다", () => {
    const state = { ids: ["main", "a", "b", "c"], active: "main" };
    expect(duplicateSessionTabs(state, { main: s("local"), a: s("local"), b: s("ssh1", "x"), c: s("local", "x") })).toEqual([]);
  });

  it("목록에 없는 탭의 상태는 보지 않는다", () => {
    const state = { ids: ["main"], active: "main" };
    expect(duplicateSessionTabs(state, { main: s("local", "x"), gone: s("local", "x") })).toEqual([]);
  });
});
