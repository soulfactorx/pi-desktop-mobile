import { describe, expect, it } from "vitest";
import { compareVersions, isLocalBuild, latestMateRelease, releaseDownloadBase, updateMode } from "../../src/main/update-policy";

describe("Mate 업데이트 규칙", () => {
  it("가장 높은 mate-v* 릴리스를 고르고 Pi Desktop·Agent·초안·사전 릴리스는 뺀다", () => {
    const releases = [
      { tag_name: "v0.1.15" },
      { tag_name: "agent-v0.4.0" },
      { tag_name: "mate-v0.10.0", draft: true },
      { tag_name: "mate-v0.9.0", prerelease: true },
      { tag_name: "mate-v0.2.0", html_url: "https://x/mate-v0.2.0" },
      { tag_name: "mate-v0.3.1" },
      { tag_name: "mate-v0.3.0" },
    ];
    expect(latestMateRelease(releases)).toEqual({ tag: "mate-v0.3.1", version: "0.3.1" });
    expect(latestMateRelease([{ tag_name: "v1.0.0" }])).toBeUndefined();
  });

  it("버전 비교는 숫자로 (0.10 > 0.9)", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("0.2.0", "0.2.0")).toBe(0);
    expect(compareVersions("v0.1.0", "0.2.0")).toBeLessThan(0);
  });

  it("내려받기 주소·자동 설치 여부·로컬 빌드", () => {
    expect(releaseDownloadBase("o", "r", "mate-v0.3.0")).toBe("https://github.com/o/r/releases/download/mate-v0.3.0");
    expect(updateMode("win32", {})).toBe("auto");
    expect(updateMode("linux", { APPIMAGE: "/a.AppImage" })).toBe("auto");
    expect(updateMode("linux", {})).toBe("notify");
    expect(updateMode("darwin", {})).toBe("notify");
    expect(isLocalBuild("0.0.1", {})).toBe(true);
    expect(isLocalBuild("0.0.1", { PI_DESKTOP_MATE_UPDATE_URL: "http://127.0.0.1:1/" })).toBe(false);
    expect(isLocalBuild("0.2.0", {})).toBe(false);
  });
});
