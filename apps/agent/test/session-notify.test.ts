import { describe, expect, it } from "vitest";
import { APPROVAL_MARKER } from "@pi-desktop/agent-kit/approval";
import { sessionNote } from "../src/main/session-notify";

describe("대화 소식 알림 (session-notify)", () => {
  it("답이 끝남·승인 요청·답 기다림만 알리고, 알림·상태 표시는 알리지 않는다", () => {
    expect(sessionNote({ type: "agent_settled" }, "proj")).toEqual({ title: "답이 끝났습니다: proj", body: "대화를 열어 확인하세요." });
    expect(sessionNote({ type: "extension_ui_request", method: "select", title: `${APPROVAL_MARKER} bash · 실행 · rm -rf build` }, "proj")).toEqual({
      title: "승인 요청: proj",
      body: "bash · 실행 · rm -rf build",
    });
    expect(sessionNote({ type: "extension_ui_request", method: "input", title: "브랜치 이름" }, "proj")).toEqual({ title: "답을 기다립니다: proj", body: "브랜치 이름" });
    expect(sessionNote({ type: "extension_ui_request", method: "notify", message: "저장함" }, "proj")).toBeUndefined();
    expect(sessionNote({ type: "agent_end" }, "proj")).toBeUndefined();
    expect(sessionNote({ type: "message_update" }, "proj")).toBeUndefined();
    expect(sessionNote(undefined, "proj")).toBeUndefined();
  });
});
