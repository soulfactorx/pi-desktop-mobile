import { app } from "electron";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** 로그인 때 띄운 실행이면 창 없이 실행기만 확인하고 끝낸다 */
export const RUNNER_ONLY_ARG = "--mate-runner-only";

export interface AutostartState {
  supported: boolean;
  enabled: boolean;
  /** 지원하지 않을 때 이유 */
  reason?: string;
}

/**
 * 로그인할 때 실행기 시작 (설계 DESIGN-MATE.md §2.3, M3).
 *
 * 실행기는 앱이 띄우므로, PC를 다시 켠 뒤 앱을 열지 않으면 시간표가 멈춘다.
 * 로그인 항목으로 앱을 `--mate-runner-only`로 띄워 실행기만 확인하고 바로 끝낸다 (창 없음).
 * - Windows·macOS: Electron 로그인 항목 (macOS는 인자를 넘길 수 없어 wasOpenedAtLogin으로 구분)
 * - Linux: ~/.config/autostart/pi-desktop-mate.desktop
 * 개발 실행(설치본이 아님)에서는 electron.exe가 등록되므로 지원하지 않는다.
 */
export function isRunnerOnlyLaunch(): boolean {
  if (process.argv.includes(RUNNER_ONLY_ARG)) return true;
  return process.platform === "darwin" && app.isPackaged && app.getLoginItemSettings().wasOpenedAtLogin === true;
}

function linuxDesktopFile(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "autostart", "pi-desktop-mate.desktop");
}

export function getAutostart(): AutostartState {
  if (!app.isPackaged) return { supported: false, enabled: false, reason: "설치본에서만 쓸 수 있습니다" };
  if (process.platform === "linux") return { supported: true, enabled: existsSync(linuxDesktopFile()) };
  const settings = app.getLoginItemSettings(process.platform === "win32" ? { args: [RUNNER_ONLY_ARG] } : undefined);
  return { supported: true, enabled: settings.openAtLogin };
}

export async function setAutostart(enabled: boolean): Promise<AutostartState> {
  const state = getAutostart();
  if (!state.supported) return state;
  if (process.platform === "linux") {
    const file = linuxDesktopFile();
    if (enabled) {
      // AppImage는 실행 중인 파일이 임시 마운트라, 원래 AppImage 경로(APPIMAGE)를 등록한다
      const exe = process.env.APPIMAGE || process.execPath;
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(
        file,
        ["[Desktop Entry]", "Type=Application", "Name=Pi Desktop Mate (실행기)", `Exec="${exe}" ${RUNNER_ONLY_ARG}`, "NoDisplay=true", "X-GNOME-Autostart-enabled=true", ""].join("\n"),
        "utf8",
      );
    } else {
      await rm(file, { force: true });
    }
  } else {
    app.setLoginItemSettings({ openAtLogin: enabled, ...(process.platform === "win32" ? { args: [RUNNER_ONLY_ARG] } : {}) });
  }
  return getAutostart();
}
