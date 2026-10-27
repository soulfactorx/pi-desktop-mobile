import { app, dialog, shell, type BrowserWindow } from "electron";
import electronUpdater from "electron-updater";
import type { UpdateState } from "../shared/api";
import {
  availablePrompt,
  CHECK_INTERVAL_MS,
  FIRST_CHECK_MS,
  isLocalBuild,
  releaseUrl,
  restartPrompt,
  resultPrompt,
  updateMode,
  type UpdatePrompt,
} from "./update-policy";

const { autoUpdater } = electronUpdater;

const OWNER = "skax-soulfactor";
const REPO = "pi-desktop";

/**
 * 앱 자동 업데이트 (M5). GitHub Releases(electron-builder.yml의 publish)에 올라간 latest*.yml을 확인한다.
 *
 * 설치한 앱에서만 돈다(개발 실행은 disabled). 시작 15초 뒤와 6시간마다, 그리고 사용자가 요청할 때 확인한다.
 * 사용자가 고르기 전에는 아무것도 내려받거나 설치하지 않는다.
 * - 새 버전을 찾으면 배지("새 버전 X")만 보인다. 배지나 "업데이트 확인"을 누르면 업데이트할지 묻는다.
 * - 자동 설치가 되는 곳(Windows·AppImage): 업데이트를 고르면 내려받고, 다 받으면 지금 다시 시작해 설치할지 묻는다.
 *   나중에를 고르면 앱을 끌 때 설치한다(업데이트를 고른 뒤에만).
 * - 그렇지 않은 곳(서명 없는 macOS·deb): 릴리스 페이지를 연다.
 * - 직접 확인했는데 업데이트가 없으면 최신이라고 알린다.
 * 시험용으로 PI_DESKTOP_UPDATE_URL을 주면 그 주소(generic)에서 확인한다.
 */
export class Updater {
  private state: UpdateState;
  private readonly mode = updateMode(process.platform, process.env);

  constructor(
    private readonly broadcast: (state: UpdateState) => void,
    /** 묻는 창을 띄울 앱 창 (없으면 창 없이 띄운다) */
    private readonly window: () => BrowserWindow | undefined = () => undefined,
  ) {
    const current = app.getVersion();
    this.state = !app.isPackaged
      ? { status: "disabled", current, mode: this.mode, error: "개발 실행에서는 업데이트를 확인하지 않습니다" }
      : isLocalBuild(current, process.env)
        ? { status: "disabled", current, mode: this.mode, error: "로컬 빌드에서는 업데이트를 확인하지 않습니다" }
        : { status: "idle", current, mode: this.mode };
  }

  start(): void {
    if (this.state.status === "disabled") return;
    const testUrl = process.env.PI_DESKTOP_UPDATE_URL;
    if (testUrl) autoUpdater.setFeedURL({ provider: "generic", url: testUrl });
    // 사용자가 업데이트를 고르기 전에는 내려받지도, 끌 때 설치하지도 않는다.
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.on("checking-for-update", () => this.set({ status: "checking" }));
    autoUpdater.on("update-not-available", () => this.set({ status: "none", checkedAt: Date.now() }));
    autoUpdater.on("update-available", (info) =>
      this.set({ status: "available", version: info.version, url: releaseUrl(OWNER, REPO, info.version) }),
    );
    autoUpdater.on("download-progress", (p) => this.set({ status: "downloading", percent: Math.round(p.percent) }));
    autoUpdater.on("update-downloaded", (info) => {
      this.set({ status: "downloaded", version: info.version });
      void this.askRestart();
    });
    autoUpdater.on("error", (error) => this.set({ status: "error", error: error instanceof Error ? error.message : String(error) }));
    setTimeout(() => void this.check(), FIRST_CHECK_MS).unref?.();
    setInterval(() => void this.check(), CHECK_INTERVAL_MS).unref?.();
  }

  get current(): UpdateState {
    return this.state;
  }

  /**
   * 업데이트를 확인한다. interactive(사용자가 메뉴·명령으로 요청)면 결과를 창으로 알리고,
   * 새 버전이 있으면 업데이트할지 묻는다. 주기적 확인은 배지만 바꾼다.
   */
  async check(interactive = false): Promise<UpdateState> {
    const status = this.state.status;
    if (status === "disabled" || status === "downloading") {
      if (interactive) await this.show(resultPrompt(status, this.state.current, this.state.error));
      return this.state;
    }
    if (status === "downloaded") {
      if (interactive) await this.askRestart();
      return this.state;
    }
    try {
      await autoUpdater.checkForUpdates();
    } catch (e) {
      this.set({ status: "error", error: e instanceof Error ? e.message : String(e) });
    }
    if (interactive) {
      const after: UpdateState["status"] = this.state.status;
      if (after === "available") await this.confirmUpdate();
      else if (after === "none" || after === "error") await this.show(resultPrompt(after, this.state.current, this.state.error));
    }
    return this.state;
  }

  /** 찾은 새 버전을 받을지 묻고, 고르면 내려받는다(알리기만 하는 곳은 릴리스 페이지를 연다) */
  async confirmUpdate(): Promise<void> {
    if (this.state.status === "downloaded") return this.askRestart();
    if (this.state.status !== "available" || !this.state.version) return;
    const choice = await this.show(availablePrompt(this.mode, this.state.current, this.state.version));
    if (choice !== 0) return;
    if (this.mode !== "auto") return this.openRelease();
    // 업데이트를 골랐으니, 다시 시작을 미루면 앱을 끌 때 설치한다.
    autoUpdater.autoInstallOnAppQuit = true;
    this.set({ status: "downloading", percent: 0 });
    try {
      await autoUpdater.downloadUpdate();
    } catch (e) {
      this.set({ status: "error", error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** 내려받은 업데이트를 지금 설치할지 묻는다 */
  private async askRestart(): Promise<void> {
    if (this.state.status !== "downloaded" || !this.state.version) return;
    if ((await this.show(restartPrompt(this.state.version))) === 0) this.install();
  }

  /** 내려받은 업데이트를 설치하며 다시 시작한다 */
  install(): void {
    if (this.state.status === "downloaded") autoUpdater.quitAndInstall();
  }

  /** 알리기만 하는 곳에서 릴리스 페이지를 연다 */
  async openRelease(): Promise<void> {
    const url = this.state.url ?? `https://github.com/${OWNER}/${REPO}/releases/latest`;
    await shell.openExternal(url);
  }

  /** 창을 띄우고 누른 버튼 번호를 돌려준다 (닫으면 나중에·확인과 같은 마지막 버튼) */
  private async show(prompt: UpdatePrompt): Promise<number> {
    const options = {
      type: prompt.type,
      title: "Pi Desktop 업데이트",
      message: prompt.message,
      detail: prompt.detail,
      buttons: prompt.buttons,
      defaultId: 0,
      cancelId: prompt.buttons.length - 1,
      noLink: true,
    };
    const win = this.window();
    const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    return response;
  }

  private set(next: Partial<UpdateState> & { status: UpdateState["status"] }): void {
    const { error: _error, ...kept } = this.state;
    this.state = { ...kept, ...next, current: app.getVersion(), mode: this.mode };
    if (next.status !== "downloading" && next.status !== "downloaded" && next.status !== "available") {
      delete this.state.percent;
    }
    this.broadcast(this.state);
  }
}
