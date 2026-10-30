import { describe, expect, it } from "vitest";
import { focusRunningApp, focusScript } from "../src/main/focus-window";

describe("떠 있는 Pi Desktop 창으로 포커스", () => {
  it("프로세스 이름이 정확히 같은 것만 찾는다 (Agent·Mate 제외), 따옴표는 이스케이프", () => {
    const script = focusScript("Pi Desktop");
    expect(script).toContain("Get-Process -Name 'Pi Desktop'");
    expect(script).toContain("MainWindowHandle -ne 0");
    expect(focusScript("it's")).toContain("'it''s'");
  });

  it("macOS는 따로 하지 않는다 (.app을 열면 떠 있는 앱으로 간다)", async () => {
    expect(await focusRunningApp("Pi Desktop", "pi-desktop", "darwin")).toBe(false);
  });
});
