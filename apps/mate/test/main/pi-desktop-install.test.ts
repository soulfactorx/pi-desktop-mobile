import { describe, expect, it } from "vitest";
import { piDesktopFromUninstall, pickPiDesktopAsset, type ReleaseAsset } from "../../src/main/pi-desktop-install";

const asset = (name: string): ReleaseAsset => ({ name, size: 1, browser_download_url: `https://x/${name}` });
const assets = [
  "Pi-Desktop-Setup-0.1.15.exe",
  "Pi-Desktop-Setup-0.1.15.exe.blockmap",
  "Pi-Desktop-0.1.15-arm64.dmg",
  "Pi-Desktop-0.1.15-x64.dmg",
  "Pi-Desktop-0.1.15-x86_64.AppImage",
  "Pi-Desktop-0.1.15-amd64.deb",
  "Pi-Desktop-Mate-Setup-0.1.0.exe",
  "Pi-Desktop-Mate-0.1.0-arm64.dmg",
  "latest.yml",
].map(asset);

describe("pickPiDesktopAsset", () => {
  it("OS·아키텍처에 맞는 Pi Desktop 설치 파일을 고르고, Mate 파일은 고르지 않는다", () => {
    expect(pickPiDesktopAsset(assets, "win32", "x64")?.name).toBe("Pi-Desktop-Setup-0.1.15.exe");
    expect(pickPiDesktopAsset(assets, "darwin", "arm64")?.name).toBe("Pi-Desktop-0.1.15-arm64.dmg");
    expect(pickPiDesktopAsset(assets, "darwin", "x64")?.name).toBe("Pi-Desktop-0.1.15-x64.dmg");
    expect(pickPiDesktopAsset(assets, "linux", "x64")?.name).toBe("Pi-Desktop-0.1.15-x86_64.AppImage");
    expect(pickPiDesktopAsset(assets.filter((a) => !a.name.startsWith("Pi-Desktop-0")), "darwin", "arm64")).toBeUndefined();
    expect(pickPiDesktopAsset([asset("Pi-Desktop-Mate-Setup-0.1.0.exe")], "win32", "x64")).toBeUndefined();
    expect(pickPiDesktopAsset([asset("Pi-Desktop-Agent-Setup-0.1.0.exe"), asset("Pi-Desktop-Agent-0.1.0-arm64.dmg")], "darwin", "arm64")).toBeUndefined();
  });
});

describe("piDesktopFromUninstall", () => {
  const reg = [
    String.raw`HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\198b06d1`,
    "    DisplayName    REG_SZ    Pi Desktop Mate 0.2.0",
    String.raw`    DisplayIcon    REG_SZ    C:\Users\me\AppData\Local\Programs\Pi Desktop Mate\Pi Desktop Mate.exe,0`,
    "",
    String.raw`HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\9a907120`,
    "    DisplayName    REG_SZ    Pi Desktop 0.1.15",
    String.raw`    DisplayIcon    REG_SZ    D:\Apps\Pi Desktop\Pi Desktop.exe,0`,
    "",
    String.raw`HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\fd2abd43`,
    "    DisplayName    REG_SZ    Pi Desktop Agent 0.1.0",
  ].join("\r\n");

  it("설치 정보에서 Pi Desktop(Mate·Agent 제외)의 실행 파일을 찾는다 (설치 폴더를 바꾼 경우)", () => {
    expect(piDesktopFromUninstall(reg)).toBe(String.raw`D:\Apps\Pi Desktop\Pi Desktop.exe`);
    expect(piDesktopFromUninstall(reg.replace("Pi Desktop 0.1.15", "Something 1.0"))).toBeUndefined();
    expect(piDesktopFromUninstall("")).toBeUndefined();
  });
});
