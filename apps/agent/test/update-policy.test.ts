import { describe, expect, it } from "vitest";
import { availablePrompt, compareVersions, isLocalBuild, latestAgentRelease, releaseDownloadBase, updateMode } from "../src/main/update-policy";

describe("자동 업데이트 규칙", () => {
  it("같은 저장소의 릴리스 중 가장 높은 agent-v*만 고른다 (Pi Desktop·Mate·초안·사전 릴리스 제외)", () => {
    const releases = [
      { tag_name: "v0.1.15" },
      { tag_name: "mate-v0.9.0" },
      { tag_name: "agent-v0.1.1", html_url: "u1" },
      { tag_name: "agent-v0.1.10" },
      { tag_name: "agent-v0.2.0", draft: true },
      { tag_name: "agent-v0.3.0", prerelease: true },
      { tag_name: "agent-v0.1.2" },
    ];
    expect(latestAgentRelease(releases)).toEqual({ tag: "agent-v0.1.10", version: "0.1.10" });
    expect(latestAgentRelease([{ tag_name: "v1.0.0" }])).toBeUndefined();
  });

  it("버전 비교와 내려받기 주소", () => {
    expect(compareVersions("0.1.10", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("v0.2.0", "0.2.0")).toBe(0);
    expect(releaseDownloadBase("o", "r", "agent-v0.2.0")).toBe("https://github.com/o/r/releases/download/agent-v0.2.0");
  });

  it("Windows·AppImage는 내려받아 설치, macOS·deb는 알리기만", () => {
    expect(updateMode("win32", {})).toBe("auto");
    expect(updateMode("linux", { APPIMAGE: "/x.AppImage" })).toBe("auto");
    expect(updateMode("linux", {})).toBe("notify");
    expect(updateMode("darwin", {})).toBe("notify");
    expect(availablePrompt("notify", "0.1.1", "0.2.0").buttons[0]).toBe("릴리스 페이지 열기");
  });

  it("로컬 빌드(0.0.1)는 시험 주소가 없으면 확인하지 않는다", () => {
    expect(isLocalBuild("0.0.1", {})).toBe(true);
    expect(isLocalBuild("0.0.1", { PI_DESKTOP_AGENT_UPDATE_URL: "http://x" })).toBe(false);
    expect(isLocalBuild("0.1.2", {})).toBe(false);
  });
});
