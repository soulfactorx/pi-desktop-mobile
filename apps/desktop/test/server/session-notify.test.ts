import { describe, expect, it } from "vitest";
import { sessionNote } from "../../src/server/session-notify";

describe("Pi Web 휴대폰 알림 (session-notify)", () => {
  it("작업이 끝남과 답을 기다리는 대화상자만 알린다", () => {
    expect(sessionNote({ type: "agent_settled" }, "app")).toEqual({ title: "작업이 끝났습니다: app", body: "세션을 열어 확인하세요." });
    expect(sessionNote({ type: "extension_ui_request", method: "confirm", title: "rm -rf ./x 를 실행할까요?" }, "app")).toEqual({
      title: "답을 기다립니다: app",
      body: "rm -rf ./x 를 실행할까요?",
    });
    expect(sessionNote({ type: "extension_ui_request", method: "setStatus" }, "app")).toBeUndefined();
    expect(sessionNote({ type: "agent_end" }, "app")).toBeUndefined();
  });
});
