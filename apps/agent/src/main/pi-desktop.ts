import { app, dialog, net, shell, type BrowserWindow } from "electron";
import { createWriteStream, existsSync } from "node:fs";
import { chmod, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { focusRunningApp } from "./focus-window";

/**
 * Pi Desktop 찾기·열기·설치 (설계 DESIGN-AGENT.md §0 "Pi 관리").
 *
 * 에이전트 앱은 Pi 설치·로그인·프로바이더·모델 관리 화면을 따로 만들지 않는다. 그 일은 Pi Desktop이 맡고,
 * 에이전트는 Pi Desktop을 쉽게 열거나 설치하게 돕는다. Pi Desktop Mate(apps/mate/src/main/pi-setup.ts)와 같은 방식이다.
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
 * 설치된 Pi Desktop 실행 파일(macOS는 .app). 기본 설치 위치만 본다.
 * Windows 사용자 설치는 %LOCALAPPDATA%\Programs\<productName>(실제로 "Pi Desktop")에 깔린다.
 * electron-builder 설정에 따라 패키지 이름(pi-desktop) 폴더일 수도 있어 둘 다 본다.
 */
export function findPiDesktop(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates: string[] = [];
  if (platform === "win32") {
    if (env.LOCALAPPDATA) {
      candidates.push(join(env.LOCALAPPDATA, "Programs", "Pi Desktop", "Pi Desktop.exe"));
      candidates.push(join(env.LOCALAPPDATA, "Programs", "pi-desktop", "Pi Desktop.exe"));
    }
    if (env.ProgramFiles) candidates.push(join(env.ProgramFiles, "Pi Desktop", "Pi Desktop.exe"));
  } else if (platform === "darwin") {
    candidates.push("/Applications/Pi Desktop.app", join(homedir(), "Applications", "Pi Desktop.app"));
  } else {
    candidates.push("/opt/Pi Desktop/pi-desktop", "/usr/bin/pi-desktop");
  }
  return candidates.find((path) => existsSync(path));
}

/**
 * Pi Desktop을 연다. 이미 떠 있으면 새로 띄우지 않고 그 창으로 포커스를 옮긴다
 * (Pi Desktop은 단일 인스턴스 처리가 없어 다시 열면 두 번째 창이 뜬다). 설치된 것을 찾지 못하면 false
 */
export async function openPiDesktop(): Promise<boolean> {
  if (await focusRunningApp("Pi Desktop", "pi-desktop")) return true;
  const path = findPiDesktop();
  if (!path) return false;
  const error = await shell.openPath(path);
  if (error) throw new Error(`Pi Desktop을 열지 못했습니다: ${error}`);
  return true;
}

/**
 * Pi Desktop 최신 설치 파일을 내려받아 설치 프로그램을 연다 (사용자가 확인한 뒤).
 * GitHub의 Latest 릴리스가 Pi Desktop 것이다 (Agent·Mate 릴리스는 Latest로 표시하지 않음).
 * 이 OS용 파일이 없으면 릴리스 페이지를 브라우저로 연다.
 */
export async function installPiDesktop(
  win: BrowserWindow | undefined,
  onProgress: (received: number, total: number) => void,
): Promise<{ status: "opened" | "cancelled" | "page"; path?: string }> {
  const res = await net.fetch(`https://api.github.com/repos/${PI_DESKTOP_REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`Pi Desktop 릴리스 정보를 읽지 못했습니다 (HTTP ${res.status})`);
  const release = (await res.json()) as { name?: string; tag_name: string; html_url: string; assets: ReleaseAsset[] };
  const asset = pickPiDesktopAsset(release.assets, process.platform, process.arch);
  if (!asset) {
    await shell.openExternal(release.html_url);
    return { status: "page" };
  }
  const options = {
    type: "question" as const,
    buttons: ["내려받아 설치", "취소"],
    defaultId: 0,
    cancelId: 1,
    title: "Pi Desktop 설치",
    message: `${release.name ?? release.tag_name}을(를) 설치할까요?`,
    detail: `${asset.name} (${(asset.size / 1024 / 1024).toFixed(0)} MB)를 다운로드 폴더에 내려받고 설치 프로그램을 엽니다.\nPi 설치·로그인·프로바이더·모델 관리는 Pi Desktop에서 합니다.`,
  };
  const answer = await (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));
  if (answer.response !== 0) return { status: "cancelled" };

  const target = join(app.getPath("downloads"), asset.name);
  const download = await net.fetch(asset.browser_download_url);
  if (!download.ok || !download.body) throw new Error(`설치 파일을 내려받지 못했습니다 (HTTP ${download.status})`);
  const total = Number(download.headers.get("content-length")) || asset.size;
  const out = createWriteStream(target);
  let received = 0;
  try {
    const reader = download.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()));
      onProgress(received, total);
    }
    await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())));
  } catch (error) {
    out.destroy();
    await rm(target, { force: true });
    throw error;
  }

  if (process.platform === "linux") {
    if (target.endsWith(".AppImage")) await chmod(target, 0o755);
    shell.showItemInFolder(target);
  } else {
    const error = await shell.openPath(target);
    if (error) throw new Error(`설치 파일을 열지 못했습니다: ${error}`);
  }
  return { status: "opened", path: target };
}
