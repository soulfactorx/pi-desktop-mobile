import { describe, expect, it } from "vitest";
import { focusRunningApp, focusScript } from "../../src/main/focus-window";

describe("focusRunningApp", () => {
  it("프로세스 이름을 정확히 찾고, 작은따옴표는 PowerShell 문자열로 이스케이프한다", () => {
    const script = focusScript("Pi Desktop");
    expect(script).toContain("Get-Process -Name 'Pi Desktop'");
    expect(script).toContain("ShowWindowAsync($h, 9)");
    expect(focusScript("it's")).toContain("-Name 'it''s'");
  });

  it("macOS는 .app 열기로 포커스가 옮겨지므로 여기서는 하지 않는다", async () => {
    expect(await focusRunningApp("Pi Desktop", "pi-desktop", "darwin")).toBe(false);
  });
});
