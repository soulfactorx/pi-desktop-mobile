import { app, dialog, net, shell, type BrowserWindow } from "electron";
import { createWriteStream } from "node:fs";
import { chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { focusRunningApp } from "./focus-window";
import { findPiDesktop, PI_DESKTOP_REPO, pickPiDesktopAsset, type ReleaseAsset } from "./pi-desktop-install";

export interface PiDesktopInfo {
  /** 설치된 Pi Desktop 위치 (기본 설치 위치에서 찾은 경우) */
  installedPath?: string;
}

export async function piDesktopInfo(): Promise<PiDesktopInfo> {
  const installedPath = await findPiDesktop();
  return installedPath ? { installedPath } : {};
}

/**
 * Pi Desktop을 연다. 이미 떠 있으면 새로 띄우지 않고 그 창으로 포커스를 옮긴다
 * (Pi Desktop은 단일 인스턴스 처리가 없어 다시 열면 두 번째 창이 뜬다). 설치된 것을 찾지 못하면 false
 */
export async function openPiDesktop(): Promise<boolean> {
  if (await focusRunningApp("Pi Desktop", "pi-desktop")) return true;
  const path = await findPiDesktop();
  if (!path) return false;
  const error = await shell.openPath(path);
  if (error) throw new Error(`Pi Desktop을 열지 못했습니다: ${error}`);
  return true;
}

/**
 * Pi Desktop 최신 설치 파일을 내려받아 설치 프로그램을 연다 (사용자가 확인한 뒤).
 * - GitHub의 Latest 릴리스가 Pi Desktop 것이다 (Mate 릴리스는 Latest로 표시하지 않음)
 * - 이 OS용 파일이 없으면 릴리스 페이지를 브라우저로 연다
 * - Windows는 설치 프로그램, macOS는 dmg를 연다. Linux AppImage는 실행 권한을 주고 폴더를 보여 준다
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
  const mb = (asset.size / 1024 / 1024).toFixed(0);
  const answer = await (win ? dialog.showMessageBox(win, confirmOptions()) : dialog.showMessageBox(confirmOptions()));
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

  function confirmOptions() {
    return {
      type: "question" as const,
      buttons: ["내려받아 설치", "취소"],
      defaultId: 0,
      cancelId: 1,
      title: "Pi Desktop 설치",
      message: `${release.name ?? release.tag_name}을(를) 설치할까요?`,
      detail: `${asset!.name} (${mb} MB)를 다운로드 폴더에 내려받고 설치 프로그램을 엽니다.\nPi 설치·로그인·모델 관리는 Pi Desktop에서 합니다.`,
    };
  }
}
