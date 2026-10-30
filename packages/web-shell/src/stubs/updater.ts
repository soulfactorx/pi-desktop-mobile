import { app, dialog } from "../electron/main";

/**
 * 앱 자동 업데이트(src/main/updater.ts)의 웹 대체 (설계 DESIGN.md §5.11). 웹 묶음은 `pi-web update`(설치 스크립트)로 바꾼다.
 * Agent·Mate의 Updater와 같은 모양이다 (생성자 인자는 쓰지 않는다).
 */

export const OWNER = "soulfactorx";
export const REPO = "pi-desktop-mobile";

interface WebUpdateState {
  status: "disabled";
  current: string;
  mode: "notify";
  error: string;
}

export class Updater {
  constructor(..._args: unknown[]) {}

  start(): void {}

  get current(): WebUpdateState {
    return { status: "disabled", current: app.getVersion(), mode: "notify", error: "웹 버전은 Termux에서 pi-web update로 업데이트합니다" };
  }

  async check(interactive = false): Promise<WebUpdateState> {
    if (interactive) {
      await dialog.showMessageBox({ type: "info", title: "업데이트", message: "웹 버전은 Termux에서 업데이트합니다", detail: "pi-web update\n그다음 브라우저 화면을 새로 고치세요.", buttons: ["확인"] });
    }
    return this.current;
  }

  async confirmUpdate(): Promise<void> {
    await this.check(true);
  }

  async install(): Promise<void> {}

  async openRelease(): Promise<void> {}
}
