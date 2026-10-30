import { describe, expect, it } from "vitest";
import { grantLabel, toggleSkill } from "../../src/renderer/mate-view";

describe("임무의 스킬·MCP 고르기", () => {
  it("허용 이름은 MCP 도구면 서버·도구로, 명령이면 그대로 보인다", () => {
    expect(grantLabel("mcp__github__list_prs")).toBe("MCP github · list_prs");
    expect(grantLabel("curl")).toBe("curl");
  });

  it("스킬을 고르면 전부에서 하나씩 빼고 더하며, 목록 순서를 지킨다", () => {
    const all = ["a", "b", "c"];
    expect(toggleSkill(undefined, all, "b")).toEqual(["a", "c"]);
    expect(toggleSkill(["c"], all, "a")).toEqual(["a", "c"]);
    expect(toggleSkill(["a"], all, "a")).toEqual([]);
  });
});
