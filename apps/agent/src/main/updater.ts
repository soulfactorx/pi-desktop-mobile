import { app, dialog, net, shell, type BrowserWindow } from "electron";
import electronUpdater from "electron-updater";
import type { UpdateState } from "../shared/api";
import {
  availablePrompt,
  CHECK_INTERVAL_MS,
  compareVersions,
  FIRST_CHECK_MS,
  isLocalBuild,
  latestAgentRelease,
  releaseDownloadBase,
  restartPrompt,
  resultPrompt,
  TEST_FEED_ENV,
  updateMode,
  type GithubRelease,
  type UpdatePrompt,
} from "./update-policy";

const { autoUpdater } = electronUpdater;

export const OWNER = "skax-soulfactor";
export const REPO = "pi-desktop";

/**
 * 자동 업데이트 (설계 DESIGN-AGENT.md §0 "릴리스"). Pi Desktop Mate의 updater와 같은 흐름이다.
 *
 * 설치한 앱에서만 돈다. 시작 20초 뒤와 6시간마다, 그리고 사용자가 요청할 때 확인한다.
 * 1. GitHub 릴리스 목록에서 가장 높은 agent-v* 릴리스를 찾는다 (Agent 릴리스는 Latest가 아니라서)
 * 2. 지금보다 높으면 그 릴리스 내려받기 주소를 generic 방식으로 넘겨 latest.yml을 확인한다
 * 3. 사용자가 고르기 전에는 내려받거나 설치하지 않는다
 * 데몬의 대화·예약 세션은 앱과 따로 돌므로 설치 중에도 멈추지 않는다.
 * 시험용으로 PI_DESKTOP_AGENT_UPDATE_URL을 주면 릴리스 목록 대신 그 주소(generic)에서 확인한다.
 */
export class Updater {
  private state: UpdateState;
  private readonly mode = updateMode(process.platform, process.env);
  private releaseUrl: string | undefined;
  /** 찾은 새 Agent 릴리스 버전 (설치 정보 파일이 없어 자동 설치를 못 할 때 알리기로 대신한다) */
  private latestVersion: string | undefined;
  /** 이번 새 버전은 릴리스 페이지에서 내려받는다 (latest.yml이 없는 릴리스: v0.1.1 이전) */
  private manualOnly = false;

  constructor(
    private readonly broadcast: (state: UpdateState) => void,
    private readonly window: () => BrowserWindow | undefined,
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
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.on("checking-for-update", () => this.set({ status: "checking" }));
    autoUpdater.on("update-not-available", () => this.set({ status: "none", checkedAt: Date.now() }));
    autoUpdater.on("update-available", (info) => this.set({ status: "available", version: info.version }));
    autoUpdater.on("download-progress", (p) => this.set({ status: "downloading", percent: Math.round(p.percent) }));
    autoUpdater.on("update-downloaded", (info) => {
      this.set({ status: "downloaded", version: info.version });
      void this.askRestart();
    });
    autoUpdater.on("error", (error) => this.set({ status: "error", error: shortError(error) }));
    setTimeout(() => void this.check(), FIRST_CHECK_MS).unref?.();
    setInterval(() => void this.check(), CHECK_INTERVAL_MS).unref?.();
  }

  get current(): UpdateState {
    return this.state;
  }

  /**
   * 업데이트 주소를 정한다. 지금보다 높은 Agent 릴리스가 없으면 "none".
   * 알리기만 하는 곳(macOS·deb)은 electron-updater 없이 찾은 버전을 바로 알린다.
   */
  private async resolveFeed(): Promise<"feed" | "none" | "notified"> {
    const testUrl = process.env[TEST_FEED_ENV];
    if (testUrl) {
      autoUpdater.setFeedURL({ provider: "generic", url: testUrl });
      return "feed";
    }
    const res = await net.fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases?per_page=50`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`릴리스 목록을 읽지 못했습니다 (HTTP ${res.status})`);
    const latest = latestAgentRelease((await res.json()) as GithubRelease[]);
    if (!latest || compareVersions(latest.version, app.getVersion()) <= 0) return "none";
    this.releaseUrl = latest.url;
    this.latestVersion = latest.version;
    this.manualOnly = false;
    if (this.mode === "notify") {
      this.set({ status: "available", version: latest.version });
      return "notified";
    }
    autoUpdater.setFeedURL({ provider: "generic", url: releaseDownloadBase(OWNER, REPO, latest.tag) });
    return "feed";
  }

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
      this.set({ status: "checking" });
      const feed = await this.resolveFeed();
      if (feed === "feed") await autoUpdater.checkForUpdates();
      else if (feed === "none") this.set({ status: "none", checkedAt: Date.now() });
    } catch (e) {
      if (this.latestVersion && !process.env[TEST_FEED_ENV]) {
        // 새 릴리스는 있는데 설치 정보(latest.yml)를 읽지 못했다 (예: 자동 업데이트 전에 만든 릴리스) → 알리기로 대신
        this.manualOnly = true;
        this.set({ status: "available", version: this.latestVersion });
      } else {
        this.set({ status: "error", error: shortError(e) });
      }
    }
    if (interactive) {
      const after: UpdateState["status"] = this.state.status;
      if (after === "available") await this.confirmUpdate();
      else if (after === "none" || after === "error") await this.show(resultPrompt(after, this.state.current, this.state.error));
    }
    return this.state;
  }

  async confirmUpdate(): Promise<void> {
    if (this.state.status === "downloaded") return this.askRestart();
    if (this.state.status !== "available" || !this.state.version) return;
    const mode = this.manualOnly ? "notify" : this.mode;
    const choice = await this.show(availablePrompt(mode, this.state.current, this.state.version));
    if (choice !== 0) return;
    if (mode !== "auto") return this.openRelease();
    autoUpdater.autoInstallOnAppQuit = true;
    this.set({ status: "downloading", percent: 0 });
    try {
      await autoUpdater.downloadUpdate();
    } catch (e) {
      this.set({ status: "error", error: shortError(e) });
    }
  }

  private async askRestart(): Promise<void> {
    if (this.state.status !== "downloaded" || !this.state.version) return;
    if ((await this.show(restartPrompt(this.state.version))) === 0) autoUpdater.quitAndInstall();
  }

  async openRelease(): Promise<void> {
    await shell.openExternal(this.releaseUrl ?? `https://github.com/${OWNER}/${REPO}/releases`);
  }

  private async show(prompt: UpdatePrompt): Promise<number> {
    const options = {
      type: prompt.type,
      title: "Pi Desktop Agent 업데이트",
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
    if (next.status !== "downloading" && next.status !== "downloaded" && next.status !== "available") delete this.state.percent;
    this.broadcast(this.state);
  }
}

/** electron-updater 오류는 응답 헤더까지 길게 붙어 오므로 첫 줄만 짧게 보인다 */
function shortError(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  const first = text.split("\n").find((l) => l.trim()) ?? text;
  return first.length > 200 ? `${first.slice(0, 200)}…` : first;
}
