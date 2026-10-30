import { describe, expect, it } from "vitest";
import { splitOption } from "../src/renderer/approval-option";

describe("승인 선택지 나누기", () => {
  it("범위 설명과 허용 패턴을 나누고, 패턴이 없으면 설명만", () => {
    expect(splitOption("이 세션에서 계속 허용: https://wttr.in/**")).toEqual({ label: "이 세션에서 계속 허용", pattern: "https://wttr.in/**" });
    expect(splitOption("항상 허용: npm test")).toEqual({ label: "항상 허용", pattern: "npm test" });
    expect(splitOption("이번만 허용")).toEqual({ label: "이번만 허용" });
  });
});
