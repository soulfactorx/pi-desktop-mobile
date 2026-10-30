import { describe, expect, it } from "vitest";
import { addRecent, folderName, isSameFolder } from "../src/renderer/recent-folders";

describe("최근 폴더", () => {
  it("새로 쓴 폴더를 맨 앞에 두고, 같은 폴더(대소문자·구분자·끝 구분자 차이)는 하나로 합친다", () => {
    const list = addRecent(["C:\\work\\a", "C:\\work\\b"], "c:/work/A/");
    expect(list).toEqual(["c:/work/A/", "C:\\work\\b"]);
    expect(isSameFolder("C:\\Users\\me", "c:/users/me/")).toBe(true);
  });

  it("최대 개수를 넘으면 오래된 것부터 뺀다", () => {
    expect(addRecent(["a", "b", "c"], "d", 3)).toEqual(["d", "a", "b"]);
  });

  it("폴더 이름", () => {
    expect(folderName("C:\\Users\\me\\proj")).toBe("proj");
    expect(folderName("/home/me/")).toBe("me");
  });
});

describe("폴더별 묶기", () => {
  it("최근 대화 순서대로 폴더를 묶고, 같은 폴더(대소문자 차이)는 한 묶음", async () => {
    const { groupByFolder } = await import("../src/renderer/chat-groups");
    const groups = groupByFolder([
      { id: 1, cwd: "C:\\work\\a" },
      { id: 2, cwd: "C:\\home" },
      { id: 3, cwd: "c:\\work\\A" },
    ]);
    expect(groups.map((g) => [g.name, g.chats.map((c) => c.id)])).toEqual([
      ["a", [1, 3]],
      ["home", [2]],
    ]);
  });
});
