import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Pi Desktop 찾기·설치 파일 고르기 (설계 DESIGN-MATE.md §9 Pi 준비).
 *
 * Mate는 Pi를 설치·로그인하는 화면을 따로 만들지 않는다. Pi 관리는 Pi Desktop이 맡고,
 * Mate는 Pi Desktop을 쉽게 설치·열 수 있게 돕는다.
 */
export const PI_DESKTOP_REPO = "skax-soulfactor/pi-desktop";

export interface ReleaseAsset {
  name: string;
  size: number;
  browser_download_url: string;
}

/**
 * Pi Desktop Latest 릴리스에서 이 OS용 설치 파일을 고른다.
 * 같은 저장소에 Mate·Agent 릴리스(Pi-Desktop-Mate-…, Pi-Desktop-Agent-…)도 있으므로 그 파일은 고르지 않는다.
 */
export function pickPiDesktopAsset(assets: ReleaseAsset[], platform: NodeJS.Platform, arch: string): ReleaseAsset | undefined {
  const desktop = assets.filter((a) => /^Pi-Desktop-/.test(a.name) && !/^Pi-Desktop-(Mate|Agent)-/.test(a.name));
  const find = (re: RegExp) => desktop.find((a) => re.test(a.name));
  switch (platform) {
    case "win32":
      return find(/^Pi-Desktop-Setup-.*\.exe$/);
    case "darwin":
      return find(new RegExp(`-${arch === "arm64" ? "arm64" : "x64"}\\.dmg$`)) ?? find(/\.dmg$/);
    case "linux":
      return find(/\.AppImage$/) ?? find(/\.deb$/);
    default:
      return undefined;
  }
}

/**
 * 설치된 Pi Desktop 실행 파일(macOS는 .app).
 * - Windows: 기본 설치 위치(%LOCALAPPDATA%\Programs\Pi Desktop — electron-builder nsis는 폴더 이름으로 제품 이름을 쓴다)를 보고,
 *   없으면 설치 정보(레지스트리 프로그램 제거 항목)의 아이콘 경로를 읽는다. 사용자가 설치 폴더를 바꾼 경우도 찾기 위해서다
 * - macOS·Linux: 기본 설치 위치
 */
export async function findPiDesktop(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  readUninstall: () => Promise<string> = readUninstallEntries,
): Promise<string | undefined> {
  const candidates: string[] = [];
  if (platform === "win32") {
    if (env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, "Programs", "Pi Desktop", "Pi Desktop.exe"));
    if (env.ProgramFiles) candidates.push(join(env.ProgramFiles, "Pi Desktop", "Pi Desktop.exe"));
  } else if (platform === "darwin") {
    candidates.push("/Applications/Pi Desktop.app", join(homedir(), "Applications", "Pi Desktop.app"));
  } else {
    candidates.push("/opt/Pi Desktop/pi-desktop", "/usr/bin/pi-desktop");
  }
  const found = candidates.find((path) => existsSync(path));
  if (found || platform !== "win32") return found;
  const fromRegistry = piDesktopFromUninstall(await readUninstall().catch(() => ""));
  return fromRegistry && existsSync(fromRegistry) ? fromRegistry : undefined;
}

/**
 * `reg query … /s` 출력에서 Pi Desktop(Mate·Agent 제외)의 실행 파일 경로를 찾는다.
 * 항목마다 DisplayName("Pi Desktop 0.1.15")과 DisplayIcon("…\Pi Desktop.exe,0")이 있다.
 */
export function piDesktopFromUninstall(output: string): string | undefined {
  for (const block of output.split(/\r?\n(?=HKEY_)/)) {
    const name = /^\s*DisplayName\s+REG_SZ\s+(.+)$/m.exec(block)?.[1]?.trim();
    if (!name || !/^Pi Desktop \d/.test(name)) continue;
    const icon = /^\s*DisplayIcon\s+REG_SZ\s+(.+)$/m.exec(block)?.[1]?.trim();
    if (icon) return icon.replace(/,\d+$/, "").replace(/^"|"$/g, "");
  }
  return undefined;
}

function readUninstallEntries(): Promise<string> {
  const keys = [
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  ];
  return Promise.all(
    keys.map(
      (key) =>
        new Promise<string>((resolve) =>
          execFile("reg", ["query", key, "/s"], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 15_000 }, (_e, stdout) =>
            resolve(String(stdout ?? "")),
          ),
        ),
    ),
  ).then((outs) => outs.join("\n"));
}
