import { describe, expect, it } from "vitest";
import { availablePrompt, isLocalBuild, releaseUrl, restartPrompt, resultPrompt, updateMode } from "../../src/main/update-policy";

describe("updateMode·releaseUrl", () => {
  it("자동 설치는 Windows와 AppImage만, 그 밖은 알리기만", () => {
    expect(updateMode("win32", {})).toBe("auto");
    expect(updateMode("linux", { APPIMAGE: "/home/me/Pi.AppImage" })).toBe("auto");
    expect(updateMode("linux", {})).toBe("notify");
    expect(updateMode("darwin", {})).toBe("notify");
  });

  it("버전의 릴리스 페이지", () => {
    expect(releaseUrl("o", "r", "0.2.0")).toBe("https://github.com/o/r/releases/tag/v0.2.0");
    expect(releaseUrl("o", "r", "v0.2.0")).toBe("https://github.com/o/r/releases/tag/v0.2.0");
  });

  it("저장소 버전 그대로인 로컬 빌드는 업데이트를 확인하지 않는다 (업데이트 시험 주소가 있으면 예외)", () => {
    expect(isLocalBuild("0.0.1", {})).toBe(true);
    expect(isLocalBuild("0.0.1", { PI_DESKTOP_UPDATE_URL: "http://localhost:8080" })).toBe(false);
    expect(isLocalBuild("0.1.3", {})).toBe(false);
  });
});

describe("업데이트 창", () => {
  it("새 버전은 받기 전에 묻는다 (자동 설치는 업데이트, 알리기만 하는 곳은 릴리스 페이지)", () => {
    expect(availablePrompt("auto", "0.1.0", "0.2.0")).toMatchObject({ type: "question", buttons: ["업데이트", "나중에"] });
    expect(availablePrompt("auto", "0.1.0", "0.2.0").message).toContain("0.2.0");
    expect(availablePrompt("notify", "0.1.0", "0.2.0").buttons).toEqual(["릴리스 페이지 열기", "나중에"]);
  });

  it("다 받으면 지금 다시 시작할지 묻고, 나중이면 끌 때 설치한다고 알린다", () => {
    const prompt = restartPrompt("0.2.0");
    expect(prompt.buttons).toEqual(["지금 다시 시작해 설치", "나중에"]);
    expect(prompt.detail).toContain("앱을 끌 때");
  });

  it("직접 확인했을 때 업데이트가 없거나 실패하면 알린다", () => {
    expect(resultPrompt("none", "0.1.13")).toMatchObject({ type: "info", message: "최신 버전입니다.", buttons: ["확인"] });
    expect(resultPrompt("none", "0.1.13").detail).toContain("0.1.13");
    expect(resultPrompt("error", "0.1.13", "net::ERR_CONNECTION_REFUSED")).toMatchObject({ type: "error" });
    expect(resultPrompt("error", "0.1.13", "net::ERR_CONNECTION_REFUSED").detail).toContain("ERR_CONNECTION_REFUSED");
    expect(resultPrompt("disabled", "0.0.1", "개발 실행에서는 업데이트를 확인하지 않습니다").detail).toContain("개발 실행");
  });
});
