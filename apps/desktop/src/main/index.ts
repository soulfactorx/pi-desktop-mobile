import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionEventNotification } from "@pi-desktop/host-protocol";
import { IpcChannels } from "../shared/api";
import { TerminalService } from "./terminal";
import { HostManager } from "./host-manager";
import { SshHostStore } from "./ssh-hosts";
import { ImportStore } from "./imports";
import { CopyStore } from "./copies";
import { ActionLog } from "./action-log";
import { Updater } from "./updater";
import { appMenuTemplate } from "./app-menu";
import { ReplayCollector } from "./replay-collector";
import { agentVersion } from "./agent-build";
import { hostEventHandlers, registerHandlers, type Router } from "./ipc-handlers";

const here = fileURLToPath(new URL(".", import.meta.url));

/**
 * 번들된 Host Agent 위치. 설치한 앱은 리소스의 host-agent 폴더(electron-builder.yml의 extraResources),
 * 개발 중에는 워크스페이스의 빌드 결과를 쓴다.
 */
function agentScriptPath(): string {
  if (process.env.PI_DESKTOP_AGENT_SCRIPT) return process.env.PI_DESKTOP_AGENT_SCRIPT;
  if (app.isPackaged) return join(process.resourcesPath, "host-agent", "host-agent.mjs");
  return resolve(app.getAppPath(), "../../packages/host-agent/dist/host-agent.mjs");
}

// 개발·E2E 검증용: 지정한 포트로 Chrome DevTools Protocol을 연다. 일반 실행에서는 열지 않는다.
// 설치본은 환경 변수로 열지 않는다(보안 검토). CDP는 앱을 마음대로 조작할 수 있어서, 환경 변수 하나로
// 몰래 열리지 않게 한다. 설치본을 검증할 때는 실행 인자 --remote-debugging-port=<포트>를 직접 준다.
if (process.env.PI_DESKTOP_REMOTE_DEBUG_PORT && !app.isPackaged) {
  app.commandLine.appendSwitch("remote-debugging-port", process.env.PI_DESKTOP_REMOTE_DEBUG_PORT);
}

let mainWindow: BrowserWindow | undefined;
let hosts: HostManager | undefined;
const replays = new ReplayCollector<SessionEventNotification>();

/** 렌더러로 알림을 보낸다. 창이 닫혀 있으면 버린다 (다시 열면 저널에서 재생하므로 잃지 않음). */
function sendToRenderer(channel: string, ...payload: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...payload);
}

function windowIcon(): { icon?: string } {
  if (!app.isPackaged) return { icon: join(app.getAppPath(), "build", "icon.png") };
  return process.platform === "linux" ? { icon: join(process.resourcesPath, "icon.png") } : {};
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    title: "Pi Desktop",
    backgroundColor: "#16171d",
    // Windows·macOS 설치본은 실행 파일 아이콘을 쓴다. Linux는 실행 파일에 아이콘이 없으므로(특히 AppImage는 .desktop도 없다)
    // 설치본도 창 아이콘을 직접 준다. 제목줄·작업 표시줄이 이것을 쓴다 (X11 _NET_WM_ICON, Wayland xdg-toplevel-icon).
    ...windowIcon(),
    webPreferences: {
      preload: join(here, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  // 응답 속 링크가 앱 창을 다른 페이지로 바꾸지 않게 한다. http(s) 링크만 외부 브라우저로 연다.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== mainWindow?.webContents.getURL()) event.preventDefault();
  });

  // 개발 서버 주소는 개발 실행에서만 쓴다. 설치본이 환경 변수의 주소를 열면 그 페이지가 preload의 앱 API(명령 실행 등)를 갖게 된다.
  if (process.env.ELECTRON_RENDERER_URL && !app.isPackaged) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(here, "../renderer/index.html"));
  }
}

const terminals = new TerminalService({ data: IpcChannels.terminalData, exit: IpcChannels.terminalExit });

/** ipcMain에 처리기를 단다. 처리기는 요청을 보낸 창(WebContents)을 첫 인자로 받는다 */
const ipcRouter: Router = {
  handle: (channel, listener) => ipcMain.handle(channel, (event, ...args) => listener(event.sender, ...args)),
  on: (channel, listener) => ipcMain.on(channel, (event, ...args) => listener(event.sender, ...args)),
};

async function pickDirectory(): Promise<string | undefined> {
  // 대화상자에서도 새 폴더를 만들 수 있게 한다 (macOS 새 폴더 버튼, Windows는 없는 경로를 쓰면 만들지 묻는다).
  const options = { properties: ["openDirectory" as const, "createDirectory" as const, "promptToCreate" as const] };
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  return result.canceled ? undefined : result.filePaths[0];
}

app.whenReady().then(() => {
  const script = agentScriptPath();
  const sshHosts = new SshHostStore(join(app.getPath("userData"), "ssh-hosts.json"));
  hosts = new HostManager({
    agentScript: script,
    agentVersion: agentVersion(script),
    sshHosts,
    ...hostEventHandlers(sendToRenderer, replays),
  });
  registerHandlers(ipcRouter, {
    manager: hosts,
    sshHosts,
    imports: new ImportStore(join(app.getPath("userData"), "imports.json")),
    copies: new CopyStore(join(app.getPath("userData"), "copies.json")),
    actionLog: new ActionLog(join(app.getPath("userData"), "activity-log.jsonl")),
    terminals,
    replays,
    pickDirectory,
    revealPath: (path) => {
      shell.showItemInFolder(path);
      return true;
    },
  });
  // 앱 기능 메뉴: 항목은 화면(지금 탭)에 명령 id를 보낸다 (app-menu.ts)
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      appMenuTemplate(process.platform, {
        command: (id) => mainWindow?.webContents.send(IpcChannels.menuCommand, id),
        openUrl: (url) => void shell.openExternal(url),
        about: () =>
          void dialog.showMessageBox({
            type: "info",
            title: "Pi Desktop 정보",
            message: `Pi Desktop ${app.getVersion()}`,
            detail: `Pi coding agent를 포크하지 않고 GUI로 쓰는 데스크톱 앱\nElectron ${process.versions.electron} · Node ${process.versions.node}\nhttps://github.com/skax-soulfactor/pi-desktop`,
          }),
      }),
    ),
  );
  createWindow();

  // 자동 업데이트 (설치한 앱에서만 확인한다)
  const updater = new Updater((state) => sendToRenderer(IpcChannels.updateStateChanged, state));
  ipcMain.handle(IpcChannels.updateState, () => updater.current);
  ipcMain.handle(IpcChannels.checkForUpdates, () => updater.check());
  ipcMain.handle(IpcChannels.installUpdate, () => updater.install());
  ipcMain.handle(IpcChannels.openRelease, () => updater.openRelease());
  updater.start();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// 앱을 닫아도 각 호스트의 데몬과 Pi 세션은 계속 돈다. 연결기만 정리한다 (설계 §3.4).
app.on("will-quit", () => {
  terminals.dispose();
  hosts?.dispose();
});
