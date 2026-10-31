import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from "electron";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, loadRemoteState, mateHome, matePaths, saveConfig, TELEGRAM_TOKEN_ENV, type ConfigPatch, type InboxStatus, type MateConfig } from "@pi-desktop/mate-runner";
import { IpcChannels, type CurrentHost, type HostView, type DutyDraft, type McpCheckResult, type Overview, type PiReadiness, type PiSetupView, type RunnerView, type SkillInput } from "../shared/api";
import { RunnerConnection, type RunnerConnectionState } from "./runner-connection";
import { listWslDistros, LOCAL_HOST_ID, readHostChoice, SSH_PREFIX, SshHostStore, WSL_PREFIX, writeHostChoice, type SshHostConfig } from "@pi-desktop/host-deploy";
import { prepareMateSsh, prepareMateWsl, type RemoteMate } from "./hosts";
import { placeRunnerFiles } from "./stable-runtime";

import { getAutostart, isRunnerOnlyLaunch, RUNNER_ONLY_ARG, setAutostart } from "./autostart";
import { installPiDesktop, openPiDesktop, piDesktopInfo } from "./pi-setup";
import { resolveNodeRuntime, runnerCommand } from "./runner-process";
import type { TelegramStore } from "./telegram-setup";
import {
  createPairingCode,
  removeTelegram,
  saveTelegramToken,
  sendTelegramTest,
  telegramEnv,
  telegramView,
  unpairTelegram,
} from "./telegram-setup";
import { Updater } from "./updater";
import { newNotes, type NoteState } from "./notifier";

const here = fileURLToPath(new URL(".", import.meta.url));
const paths = matePaths(mateHome());

/** 번들된 실행기. 설치본은 앱 리소스(M3), 개발 중에는 워크스페이스의 빌드 결과 */
function runnerScript(): string {
  if (process.env.PI_DESKTOP_MATE_RUNNER) return process.env.PI_DESKTOP_MATE_RUNNER;
  if (app.isPackaged) return join(process.resourcesPath, "mate-runner", "mate-runner.mjs");
  return resolve(app.getAppPath(), "../../packages/mate-runner/dist/mate-runner.mjs");
}

/** mate-kit 폴더. 실행기가 띄우는 Pi가 이 경로의 확장을 -e로 불러온다 */
function kitDir(): string {
  if (process.env.PI_DESKTOP_MATE_KIT) return process.env.PI_DESKTOP_MATE_KIT;
  if (app.isPackaged) return join(process.resourcesPath, "mate-kit");
  return resolve(app.getAppPath(), "../../packages/mate-kit");
}

function runnerEnv(): Record<string, string> {
  return { MATE_HOME: paths.home, PI_DESKTOP_MATE_KIT: kitDir() };
}

/**
 * 로컬 실행기를 띄울 때 쓰는 실행기 번들과 mate-kit. AppImage는 앱이 끝나면 리소스(`/tmp/.mount_…`)가 사라지는데
 * 실행기는 남아 임무를 돌리므로, Mate 홈에 복사한 것을 쓴다 (stable-runtime.ts).
 */
let placedFiles: Promise<{ runnerScript: string; kitDir: string }> | undefined;
function localRunnerFiles(): Promise<{ runnerScript: string; kitDir: string }> {
  if (!app.isPackaged || !process.env.APPIMAGE) return Promise.resolve({ runnerScript: runnerScript(), kitDir: kitDir() });
  placedFiles ??= placeRunnerFiles(paths.home, { runnerScript: runnerScript(), kitDir: kitDir(), version: app.getVersion() }).catch((error: unknown) => {
    placedFiles = undefined;
    throw error;
  });
  return placedFiles;
}

// 개발 실행은 설치본과 userData(창 상태·단일 인스턴스 잠금)를 나눈다.
// 같으면 설치본이 켜져 있을 때 개발 실행이 잠금에 걸려 바로 끝나고, 설치본 창을 앞으로 불러낸다.
if (!app.isPackaged) app.setPath("userData", join(app.getPath("appData"), "Pi Desktop Mate (dev)"));

// 개발·E2E 검증용 Chrome DevTools Protocol. 설치본은 환경 변수로 열지 않는다 (Pi Desktop과 같은 이유).
if (process.env.PI_DESKTOP_REMOTE_DEBUG_PORT && !app.isPackaged) {
  app.commandLine.appendSwitch("remote-debugging-port", process.env.PI_DESKTOP_REMOTE_DEBUG_PORT);
}

let mainWindow: BrowserWindow | undefined;

/**
 * 창에 알린다. 앱을 닫는 중에는 창이 먼저 없어지고 연결 정리·업데이트 알림이 뒤에 올 수 있다.
 * 없어진 창에 보내면 "Object has been destroyed"로 main 프로세스 오류 창이 뜨므로 건너뛴다.
 */
function sendToWindow(channel: string, ...args: unknown[]): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send(channel, ...args);
}
let runnerError: string | undefined;

/**
 * 실행기 연결 (설계 DESIGN-MATE-REMOTE.md §2). 화면이 쓰는 데이터는 모두 실행기의 mate.call로 오간다.
 * 연결은 `mate-runner connect`가 실행기를 띄우고(없으면) 소켓에 이어 준다.
 */
let connection: RunnerConnection | undefined;
const call = <T = unknown>(name: string, ...args: unknown[]): Promise<T> => {
  if (!connection) return Promise.reject(new Error("실행기에 아직 연결하지 않았습니다"));
  return connection.call<T>(name, ...args);
};

/** 실행기에 붙기 전에도 쓰는 로컬 저장소 (연결 명령에 넘길 휴대폰 토큰을 읽는다) */
const localStore: TelegramStore = {
  config: () => loadConfig(paths),
  saveConfig: (patch: ConfigPatch) => saveConfig(paths, patch),
  remoteState: () => loadRemoteState(paths),
};

/**
 * 설정 바꾸기를 실행기에 보낸다. JSON(RPC)은 값이 undefined인 키를 빼 버리므로, 지우려는 값(토큰·연결 코드·조용한 시간)은
 * null로 바꿔 보낸다. 실행기의 설정 정리(loadConfig)가 null을 지운다.
 */
const saveConfigOnRunner = (patch: ConfigPatch) => call<MateConfig>("saveConfig", JSON.parse(JSON.stringify(patch, (_key, value: unknown) => (value === undefined ? null : value))));

/** 실행기 RPC로 설정과 휴대폰 연결 상태를 읽고 쓰는 저장소 */
const runnerStore: TelegramStore = {
  config: () => call("config"),
  saveConfig: saveConfigOnRunner,
  remoteState: () => call("remoteState"),
};

/**
 * 지금 호스트 (설계 DESIGN-MATE-REMOTE.md §3.1). 한 번에 한 호스트(로컬·WSL·SSH)의 실행기에 붙는다.
 * 원격이면 연결할 때 실행기 번들과 mate-kit·pi-isolation을 그 호스트에 올린다 (hosts.ts, host-deploy).
 */
const hostChoiceFile = () => join(app.getPath("userData"), "mate-host.json");
let currentHostId = LOCAL_HOST_ID;
/** 원격이면 그 호스트의 Mate 홈과 사용자 홈 (연결을 준비할 때 정해진다) */
let remoteMate: RemoteMate | undefined;
let sshHostStore: SshHostStore | undefined;
const sshHosts = () => (sshHostStore ??= new SshHostStore(join(app.getPath("userData"), "ssh-hosts.json")));
const isRemote = () => currentHostId !== LOCAL_HOST_ID;

/** 이 PC에서만 되는 일. 원격이면 이유를 알린다 */
function localOnly(what: string): void {
  if (isRemote()) throw new Error(`${what}은(는) 원격 호스트에서는 할 수 없습니다 (이 PC의 Mate에서만 됩니다)`);
}

/**
 * 휴대폰 연결 토큰을 실행기에 넘긴다 (설계 DESIGN-MATE-REMOTE.md §5). 실행기는 메모리에만 둔다.
 * 원격 실행기는 명령 줄·환경 변수로 받지 않으므로(그 호스트의 ps·셸 기록) 붙을 때마다 넘긴다.
 * 로컬도 같은 길로 넘겨, 토큰을 바꿔도 실행기를(도는 임무를) 다시 띄우지 않는다.
 * 토큰이 있는데 이 PC에서 풀 수 없으면(다른 PC가 저장한 토큰) 그 PC가 넘긴 연결을 끄지 않게 아무것도 하지 않는다.
 */
async function pushTelegramToken(): Promise<void> {
  const token = (await telegramEnv(runnerStore))[TELEGRAM_TOKEN_ENV];
  if (token) await call("setTelegramToken", token);
  else if (!(await runnerStore.config()).telegram.tokenEnc) await call("setTelegramToken", null);
}

async function launchFor(hostId: string) {
  if (hostId === LOCAL_HOST_ID) {
    const [runtime, files] = await Promise.all([resolveNodeRuntime(), localRunnerFiles()]);
    remoteMate = undefined;
    // 휴대폰 연결 토큰은 실행기를 띄울 때만 풀어서 넘긴다 (connect가 실행기를 띄우는 경우)
    return {
      command: runtime.command,
      args: [files.runnerScript, "connect"],
      env: { ...process.env, ...runtime.env, ...runnerEnv(), PI_DESKTOP_MATE_KIT: files.kitDir, ...(await telegramEnv(localStore)) },
    };
  }
  const options = { runnerScript: runnerScript(), version: app.getVersion(), kitDir: kitDir() };
  let prepared;
  if (hostId.startsWith(WSL_PREFIX)) prepared = await prepareMateWsl(hostId.slice(WSL_PREFIX.length), options);
  else if (hostId.startsWith(SSH_PREFIX)) {
    const host = sshHosts().get(hostId.slice(SSH_PREFIX.length));
    if (!host) throw new Error(`등록되지 않은 SSH 호스트입니다: ${hostId.slice(SSH_PREFIX.length)}`);
    prepared = await prepareMateSsh(host, options);
  } else throw new Error(`알 수 없는 호스트입니다: ${hostId}`);
  remoteMate = prepared.remote;
  return { command: prepared.spec.command, args: prepared.spec.args, env: { ...process.env, ...prepared.spec.env } };
}

/**
 * 호스트를 바꾼다. 앞 호스트의 실행기는 그대로 두면 임무가 두 곳에서 같이 돌 수 있어, stopPrevious면 멈춘다 (DESIGN-MATE-REMOTE.md §3.1).
 * 화면은 새로 읽는다.
 */
async function switchHost(hostId: string, stopPrevious: boolean): Promise<void> {
  if (hostId === currentHostId) return;
  if (hostId.startsWith(SSH_PREFIX) && !sshHosts().get(hostId.slice(SSH_PREFIX.length))) throw new Error("등록되지 않은 SSH 호스트입니다");
  if (stopPrevious) await stopRunner().catch(() => undefined);
  writeHostChoice(hostChoiceFile(), hostId);
  currentHostId = hostId;
  connection?.dispose();
  lastOverview = undefined;
  // 다른 호스트의 것은 새로 기준을 잡는다
  notes = undefined;
  readinessCache = undefined;
  startConnection();
  mainWindow?.webContents.reload();
}

/**
 * PC 알림 (notifier.ts). 실행기가 바뀌었다고 알리면 잠깐 모았다가 overview를 견줘 새것만 알린다.
 * 창을 보고 있으면 화면에 이미 보이므로 띄우지 않는다. 알림을 누르면 창을 앞으로 가져온다.
 */
let notes: NoteState | undefined;
let noteTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleNotes(): void {
  if (noteTimer) clearTimeout(noteTimer);
  noteTimer = setTimeout(() => void showNotes(), 500);
}

async function showNotes(): Promise<void> {
  let current: Overview;
  try {
    current = await call<Overview>("overview");
  } catch {
    return;
  }
  const { notes: fresh, state } = newNotes(notes, current);
  notes = state;
  if (!current.config.desktopNotify || !Notification.isSupported() || mainWindow?.isFocused()) return;
  for (const note of fresh) {
    const shown = new Notification({ title: note.title, body: note.body });
    shown.on("click", () => {
      if (!mainWindow) createWindow();
      if (mainWindow?.isMinimized()) mainWindow.restore();
      mainWindow?.show();
      mainWindow?.focus();
    });
    shown.show();
  }
}

function startConnection(): void {
  const hostId = currentHostId;
  connection = new RunnerConnection({
    launch: () => launchFor(hostId),
    onChanged: () => {
      sendToWindow(IpcChannels.changed);
      scheduleNotes();
    },
    onState: (state: RunnerConnectionState) => {
      runnerError = state.status === "disconnected" ? `실행기에 연결하지 못했습니다: ${state.reason}` : undefined;
      if (state.status === "connected") {
        void pushTelegramToken().catch(() => undefined);
        scheduleNotes();
      }
      sendToWindow(IpcChannels.changed);
    },
  });
  connection.start();
}

/** 지금 호스트의 실행기를 멈춘다. 로컬은 pid로(실행기가 멈춰 있어도 되게), 원격은 실행기에 멈추라고 한다 */
async function stopRunner(): Promise<void> {
  if (isRemote()) await call("stopRunner");
  else await runnerCommand(runnerScript(), "stop", runnerEnv());
}

/** 실행기를 멈췄다가 다시 띄운다. 연결은 끊긴 뒤 다시 붙으며 새로 띄운다 */
async function restartRunner(): Promise<void> {
  await stopRunner().catch(() => undefined);
}

/** 로그인할 때 실행: 창 없이 실행기만 확인한다 */
async function ensureRunner(): Promise<void> {
  try {
    const files = await localRunnerFiles();
    const result = await runnerCommand(files.runnerScript, "start", { ...runnerEnv(), PI_DESKTOP_MATE_KIT: files.kitDir, ...(await telegramEnv(localStore)) });
    runnerError = result.status === "failed" ? "실행기를 띄우지 못했습니다. 로그를 확인하세요." : undefined;
  } catch (error) {
    runnerError = `실행기를 띄우지 못했습니다: ${(error as Error).message}`;
  }
}

/** Pi 준비 상태 (그 호스트의 Pi). pi --list-models가 몇 초 걸려 5분 동안 기억해 둔다 */
let readinessCache: Promise<PiSetupView> | undefined;
let readinessAt = 0;

function readiness(refresh = false): Promise<PiSetupView> {
  if (refresh || !readinessCache || Date.now() - readinessAt > 5 * 60_000) {
    readinessAt = Date.now();
    readinessCache = call<PiReadiness>("piReadiness").then(
      async (status) => ({ ...status, ...(await piDesktopInfoView()), checkedAt: Date.now() }),
      async (error: Error) => ({
        stage: "no-pi" as const,
        piError: `Pi 상태를 확인하지 못했습니다: ${error.message}`,
        node: { path: "", ok: false },
        authProviders: [],
        models: [],
        ...(await piDesktopInfoView()),
        checkedAt: Date.now(),
      }),
    );
  }
  return readinessCache;
}

async function piDesktopInfoView(): Promise<{ piDesktopPath?: string }> {
  const info = await piDesktopInfo();
  return info.installedPath ? { piDesktopPath: info.installedPath } : {};
}

/** 마지막으로 받은 overview. 실행기와 끊겼을 때 화면이 비지 않게 이것에 "꺼짐"을 붙여 보인다 */
let lastOverview: Overview | undefined;

async function overview(): Promise<Overview> {
  try {
    lastOverview = await call<Overview>("overview");
    return lastOverview;
  } catch (error) {
    if (!lastOverview) throw error;
    const runner: RunnerView = { ...lastOverview.runner, alive: false, error: runnerError ?? (error as Error).message };
    delete runner.pid;
    delete runner.current;
    return { ...lastOverview, runner };
  }
}

function registerIpc(): void {
  // 화면이 쓰는 데이터는 실행기의 app-api로 넘긴다 (DESIGN-MATE-REMOTE.md §2.2)
  const forward = (channel: string, name: string) => ipcMain.handle(channel, (_e, ...args: unknown[]) => call(name, ...args));
  ipcMain.handle(IpcChannels.overview, () => overview());
  ipcMain.handle(IpcChannels.saveDuty, (_e, draft: DutyDraft) => call("saveDuty", draft));
  forward(IpcChannels.deleteDuty, "deleteDuty");
  forward(IpcChannels.deleteRun, "deleteRun");
  forward(IpcChannels.clearChat, "clearChat");
  forward(IpcChannels.restoreTrash, "restoreTrash");
  forward(IpcChannels.emptyTrash, "emptyTrash");
  forward(IpcChannels.applyInstall, "applyInstall");
  forward(IpcChannels.describeInstall, "describeInstall");
  forward(IpcChannels.skillsList, "skillsList");
  ipcMain.handle(IpcChannels.skillSave, (_e, previous: string | undefined, input: SkillInput) => call("skillSave", previous, input));
  forward(IpcChannels.skillDelete, "skillDelete");
  ipcMain.handle(IpcChannels.skillOpenFolder, async () => {
    localOnly("스킬 폴더 열기");
    await mkdir(paths.skills, { recursive: true });
    const error = await shell.openPath(paths.skills);
    if (error) throw new Error(error);
  });
  forward(IpcChannels.listMcp, "mcpList");
  forward(IpcChannels.addMcpPreset, "mcpAddPreset");
  forward(IpcChannels.setMcpEnabled, "mcpSetEnabled");
  forward(IpcChannels.removeMcp, "mcpRemove");
  ipcMain.handle(IpcChannels.openMcpFile, async () => {
    const path = await call<string>("mcpEnsureFile");
    localOnly("mcp.json 열기");
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
  });
  ipcMain.handle(IpcChannels.checkMcp, () => call<McpCheckResult>("mcpCheck"));
  forward(IpcChannels.runNow, "runNow");
  ipcMain.handle(IpcChannels.setInbox, (_e, ids: string[], status: InboxStatus | undefined) => call("setInbox", ids, status));
  ipcMain.handle(IpcChannels.saveConfig, (_e, patch: ConfigPatch) => saveConfigOnRunner(patch));
  ipcMain.handle(IpcChannels.pickDirectory, async () => {
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] }) : await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return result.canceled ? undefined : result.filePaths[0];
  });
  ipcMain.handle(IpcChannels.restartRunner, async () => {
    await restartRunner();
    return (await overview()).runner;
  });
  ipcMain.handle(IpcChannels.revealHome, () => {
    localOnly("데이터 폴더 열기");
    return shell.openPath(paths.home);
  });
  // 호스트 (DESIGN-MATE-REMOTE.md §3.1): 고르기, SSH 호스트 관리, 그 호스트의 폴더 훑기
  ipcMain.handle(IpcChannels.listHosts, async (): Promise<HostView[]> => [
    { id: LOCAL_HOST_ID, kind: "local", label: process.platform === "win32" ? "로컬 (Windows)" : process.platform === "darwin" ? "로컬 (macOS)" : "로컬 (Linux)" },
    ...(await listWslDistros()).map((d): HostView => ({ id: `${WSL_PREFIX}${d}`, kind: "wsl", label: `WSL: ${d}` })),
    ...sshHosts().list().map((h): HostView => ({ id: `${SSH_PREFIX}${h.name}`, kind: "ssh", label: `SSH: ${h.name}` })),
  ]);
  ipcMain.handle(IpcChannels.currentHost, (): CurrentHost => ({ id: currentHostId, remote: isRemote(), ...(remoteMate ? { home: remoteMate.home, userHome: remoteMate.userHome } : {}) }));
  ipcMain.handle(IpcChannels.setHost, (_e, hostId: string, stopPrevious: boolean) => switchHost(String(hostId), stopPrevious !== false));
  ipcMain.handle(IpcChannels.listSshHosts, () => sshHosts().list());
  ipcMain.handle(IpcChannels.saveSshHost, (_e, host: SshHostConfig, previousName?: string) => sshHosts().save(host, previousName));
  ipcMain.handle(IpcChannels.removeSshHost, (_e, name: string) => {
    if (currentHostId === `${SSH_PREFIX}${name}`) throw new Error("지금 쓰는 호스트입니다. 다른 호스트로 바꾼 뒤 지우세요");
    sshHosts().remove(name);
  });
  forward(IpcChannels.listDir, "listDir");
  forward(IpcChannels.makeDir, "makeDir");
  ipcMain.handle(IpcChannels.getAutostart, () => getAutostart());
  ipcMain.handle(IpcChannels.telegramView, () => telegramView(runnerStore));
  ipcMain.handle(IpcChannels.telegramSetToken, async (_e, token: string) => {
    await saveTelegramToken(runnerStore, String(token));
    await pushTelegramToken();
    return telegramView(runnerStore);
  });
  ipcMain.handle(IpcChannels.telegramRemove, async () => {
    await removeTelegram(runnerStore);
    await pushTelegramToken();
    return telegramView(runnerStore);
  });
  ipcMain.handle(IpcChannels.telegramPair, async () => {
    await createPairingCode(runnerStore);
    return telegramView(runnerStore);
  });
  ipcMain.handle(IpcChannels.telegramUnpair, async () => {
    await unpairTelegram(runnerStore);
    return telegramView(runnerStore);
  });
  ipcMain.handle(IpcChannels.telegramTest, () => sendTelegramTest(runnerStore));
  ipcMain.handle(IpcChannels.chatSend, (_e, text: string, answerTo?: string) => call("chatSend", String(text ?? ""), typeof answerTo === "string" ? answerTo : undefined));
  ipcMain.handle(IpcChannels.piReadiness, (_e, refresh: boolean) => readiness(refresh === true));
  ipcMain.handle(IpcChannels.installPiDesktop, () =>
    installPiDesktop(mainWindow, (received, total) => sendToWindow(IpcChannels.installProgress, received, total)),
  );
  ipcMain.handle(IpcChannels.openPiDesktop, () => openPiDesktop());
  ipcMain.handle(IpcChannels.setAutostart, (_e, enabled: boolean) => {
    // 로그인할 때 시작은 이 PC의 실행기만 띄운다 (원격 실행기는 그 호스트에서 돈다, DESIGN-MATE-REMOTE.md §4)
    localOnly("로그인할 때 실행기 시작");
    return setAutostart(enabled === true);
  });
  ipcMain.handle(IpcChannels.delegate, (_e, itemId: string) => call("delegate", String(itemId)));
  ipcMain.handle(IpcChannels.applyChange, (_e, itemId: string) => call("applyChange", String(itemId)));
  ipcMain.handle(IpcChannels.discardChange, (_e, itemId: string) => call("discardChange", String(itemId)));
  ipcMain.handle(IpcChannels.readSession, (_e, runId: string) => call("readSession", String(runId)));
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 480,
    title: "Pi Desktop Mate",
    // Linux 설치본은 실행 파일에 아이콘이 없어 창에 직접 준다 (electron-builder.yml extraResources)
    ...(process.platform === "linux" && app.isPackaged ? { icon: join(process.resourcesPath, "icon.png") } : {}),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
    },
  });
  mainWindow.on("closed", () => (mainWindow = undefined));
  // 링크는 앱 안이 아니라 기본 브라우저로 연다
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  // 개발 서버 주소는 설치본에서 쓰지 않는다 (Pi Desktop과 같은 이유)
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void mainWindow.loadFile(join(here, "../renderer/index.html"));
}

if (isRunnerOnlyLaunch()) {
  // 로그인 때 띄운 실행: 창 없이 실행기만 확인하고 끝낸다 (실행기는 분리된 프로세스라 남는다)
  void app.whenReady().then(async () => {
    await ensureRunner();
    app.quit();
  });
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    if (argv.includes(RUNNER_ONLY_ARG)) return;
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });
  void app.whenReady().then(async () => {
    currentHostId = readHostChoice(hostChoiceFile());
    registerIpc();
    createWindow();
    // 창을 먼저 띄우고 실행기에 붙는다. 실행기는 앱을 닫아도 남는다 (연결기만 끝난다)
    startConnection();
    app.on("will-quit", () => connection?.dispose());
    // 자동 업데이트: 설치 직전에는 실행기를 멈춘다 (실행기가 Electron을 Node로 쓰는 경우 설치 파일을 잡고 있지 않게)
    const updater = new Updater(
      (state) => sendToWindow(IpcChannels.updateStateChanged, state),
      () => mainWindow,
      async () => {
        await runnerCommand(runnerScript(), "stop", runnerEnv());
      },
    );
    ipcMain.handle(IpcChannels.updateState, () => updater.current);
    ipcMain.handle(IpcChannels.checkForUpdates, (_e, interactive: boolean) => updater.check(interactive === true));
    ipcMain.handle(IpcChannels.confirmUpdate, () => updater.confirmUpdate());
    updater.start();
  });
  app.on("window-all-closed", () => app.quit());
}
