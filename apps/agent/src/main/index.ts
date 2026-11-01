import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, shell } from "electron";
import { readFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Methods,
  type PiModelsResult,
  type PiResponse,
  type PiStatus,
  type SessionAttachResult,
  type SessionEventNotification,
  type SessionOpenParams,
  type SessionOpenResult,
  type SessionSummary,
  type StoredSession,
  type FsListDirResult,
  type TrashEmptyResult,
  type TrashItem,
} from "@pi-desktop/host-protocol";
import type { TaskRecord } from "@pi-desktop/agent-kit/task-types";
import { agentBuildId } from "../vendor/main/agent-build";
import { devSessionOverrides } from "../vendor/main/dev-overrides";
import type { CardDraft } from "@pi-desktop/agent-kit/peers";
import type { McpCheckResult } from "@pi-desktop/pi-isolation/mcp-presets";
import { imageMimeType, MAX_IMAGE_BYTES } from "../renderer/attachments";
import { HostConnection, type LaunchSpec } from "../vendor/main/host-connection";
import { listWslDistros, readHostChoice, SshHostStore, writeHostChoice, type SshHostConfig } from "@pi-desktop/host-deploy";
import { LOCAL_HOST_ID, prepareAgentSsh, prepareAgentWsl, SSH_PREFIX, WSL_PREFIX, type HostPaths, type Prepared } from "./hosts";
import { schedulerDirFor, sessionParamsFor, sessionsDirFor } from "./host-session";
import { resolveNodeRuntime } from "../vendor/main/node-runtime";
import { ReplayCollector } from "../vendor/main/replay-collector";
import { IpcChannels, OPEN_CHAT_COMMAND, type AttachResult, type ChatSummary, type CurrentHost, type HostView, type SessionSource, type ImageAttachment } from "../shared/api";
import { findPiDesktop, installPiDesktop, openPiDesktop } from "./pi-desktop";
import type { PiSetupView } from "../shared/pi-setup";
import { TaskWatcher } from "./task-watcher";
import { sessionNote } from "./session-notify";
import { appMenuTemplate } from "./app-menu";
import { OWNER, REPO, Updater } from "./updater";

const here = fileURLToPath(new URL(".", import.meta.url));

/**
 * 에이전트 앱의 홈 (설계 DESIGN-AGENT.md §2.2, DESIGN-APPS.md §3). Host Agent 데몬 홈이기도 하다.
 * Pi Desktop의 `~/.pi-desktop`과 나눠, 따로 배포된 두 앱이 서로의 데몬을 교체하지 않게 한다.
 * 세션·스킬·프롬프트·MCP·AGENTS.md·agent-kit 상태도 여기 둔다. Pi의 로그인·모델·설정(`~/.pi/agent`)만 함께 쓴다.
 */
function agentHome(): string {
  return process.env.PI_DESKTOP_HOME || join(homedir(), ".pi-desktop-agent");
}

/** 번들된 Host Agent 위치. 설치본은 앱 리소스, 개발 중에는 워크스페이스의 빌드 결과 */
function agentScriptPath(): string {
  if (process.env.PI_DESKTOP_AGENT_SCRIPT) return process.env.PI_DESKTOP_AGENT_SCRIPT;
  if (app.isPackaged) return join(process.resourcesPath, "host-agent", "host-agent.mjs");
  return resolve(app.getAppPath(), "../../packages/host-agent/dist/host-agent.mjs");
}

/** pi-isolation 폴더. 앱 홈의 MCP·문맥 파일을 읽는 확장이 여기 있다 (agent-kit과 같은 방식으로 싣는다) */
function isolationDir(): string {
  if (process.env.PI_DESKTOP_PI_ISOLATION) return process.env.PI_DESKTOP_PI_ISOLATION;
  if (app.isPackaged) return join(process.resourcesPath, "pi-isolation");
  return resolve(app.getAppPath(), "../../packages/pi-isolation");
}

/** agent-kit 폴더. 확장은 대상 호스트(지금은 로컬)의 Pi가 이 경로에서 불러온다 */
function kitDir(): string {
  if (process.env.PI_DESKTOP_AGENT_KIT) return process.env.PI_DESKTOP_AGENT_KIT;
  if (app.isPackaged) return join(process.resourcesPath, "agent-kit");
  return resolve(app.getAppPath(), "../../packages/agent-kit");
}

// 개발·E2E 검증용 Chrome DevTools Protocol. 설치본은 환경 변수로 열지 않는다 (Pi Desktop과 같은 이유).
if (process.env.PI_DESKTOP_REMOTE_DEBUG_PORT && !app.isPackaged) {
  app.commandLine.appendSwitch("remote-debugging-port", process.env.PI_DESKTOP_REMOTE_DEBUG_PORT);
}

/** 끝난 작업을 OS 알림으로 알린다. 창을 보고 있으면 목록이 바뀌는 것으로 충분하다 */
function notifyTask(task: TaskRecord): void {
  if (!Notification.isSupported()) return;
  // 피어가 작업을 맡기면 사람이 승인해야 시작되므로 창을 보고 있어도 알린다
  if (task.status === "waiting") {
    if (task.origin !== "peer-in" || task.approval !== "pending") return;
    new Notification({ title: `작업 요청: ${task.peer?.name ?? "피어"}`, body: `"${task.title}" — 네트워크 화면에서 폴더를 골라 승인하거나 거절하세요` }).show();
    return;
  }
  if (mainWindow?.isFocused()) return;
  const status = task.status === "done" ? "완료" : task.status === "failed" ? "실패" : "취소됨";
  const origin = task.origin === "schedule" ? "예약" : task.origin === "peer-out" ? `${task.peer?.name ?? "피어"}에게 맡긴 작업` : task.origin === "peer-in" ? `${task.peer?.name ?? "피어"}가 맡긴 작업` : "작업";
  const body = (task.status === "failed" ? task.error : task.result)?.slice(0, 200) ?? "";
  new Notification({ title: `${origin} ${status}: ${task.title}`, body }).show();
}

/** 알림에 쓸 대화의 폴더 (세션 id → cwd). 모르는 세션이 오면 목록을 다시 읽는다 */
let sessionFolders = new Map<string, string>();

/**
 * 대화 소식(답이 끝남·승인 요청·답을 기다림)을 OS 알림으로 띄운다 (session-notify.ts). 창을 보고 있으면 띄우지 않는다.
 * 예약 작업을 돌리는 스케줄러 세션은 작업 알림(notifyTask)이 맡으므로 알리지 않는다. 누르면 창을 앞으로 가져오고 그 대화로 간다.
 */
function notifySession(n: SessionEventNotification): void {
  if (!Notification.isSupported() || !sessionNote(n.event, "")) return;
  if (mainWindow?.isFocused()) {
    // 보고 있을 때 온 승인 요청·질문은 바로 알리지 않는다. 답하기 전에 창(휴대폰이면 앱)을 떠나면 그때 알린다
    remindIfLeft(n);
    return;
  }
  showSessionNote(n);
}

/** 보고 있을 때 온 대화상자 (세션:요청 id → 확인 타이머). 답하면(onUiResolved) 지운다 */
const unansweredDialogs = new Map<string, ReturnType<typeof setInterval>>();
/** 창을 떠났는지 보는 간격과, 그만 기다리는 시간 */
const LEFT_CHECK_MS = 5_000;
const LEFT_CHECK_LIMIT_MS = 30 * 60_000;

function remindIfLeft(n: SessionEventNotification): void {
  const id = (n.event as { type?: unknown; id?: unknown }).id;
  if ((n.event as { type?: unknown }).type !== "extension_ui_request" || typeof id !== "string") return;
  const key = `${n.sessionId}\n${id}`;
  if (unansweredDialogs.has(key)) return;
  const started = Date.now();
  const timer = setInterval(() => {
    if (Date.now() - started > LEFT_CHECK_LIMIT_MS) return forgetDialog(n.sessionId, id);
    if (mainWindow?.isFocused()) return;
    forgetDialog(n.sessionId, id);
    showSessionNote(n);
  }, LEFT_CHECK_MS);
  timer.unref?.();
  unansweredDialogs.set(key, timer);
}

function forgetDialog(sessionId: string, id?: string): void {
  for (const [key, timer] of unansweredDialogs) {
    if (id === undefined ? key.startsWith(`${sessionId}\n`) : key === `${sessionId}\n${id}`) {
      clearInterval(timer);
      unansweredDialogs.delete(key);
    }
  }
}

function showSessionNote(n: SessionEventNotification): void {
  void (async () => {
    if (!sessionFolders.has(n.sessionId) && connection) {
      const sessions = await connection.request<SessionSummary[]>(Methods.sessionList);
      sessionFolders = new Map(sessions.map((s) => [s.sessionId, s.cwd]));
    }
    const cwd = sessionFolders.get(n.sessionId);
    if (!cwd || !hostPaths || cwd === schedulerDir()) return;
    const note = sessionNote(n.event, basename(cwd) || cwd);
    if (!note) return;
    const shown = new Notification({ title: note.title, body: note.body });
    shown.on("click", () => {
      const openChat = () => sendToRenderer(IpcChannels.menuCommand, `${OPEN_CHAT_COMMAND}${n.sessionId}`);
      if (mainWindow) openChat();
      else {
        createWindow();
        // 새로 연 창은 화면이 뜬 뒤에 보낸다
        (mainWindow as BrowserWindow | undefined)?.webContents.once("did-finish-load", openChat);
      }
      if (mainWindow?.isMinimized()) mainWindow.restore();
      mainWindow?.show();
      mainWindow?.focus();
    });
    shown.show();
  })().catch(() => undefined);
}

/** 이 PC를 호스트로 쓸 때의 경로 */
function localHostLabel(): string {
  return process.platform === "win32" ? "로컬 (Windows)" : process.platform === "darwin" ? "로컬 (macOS)" : "로컬 (Linux)";
}

function localPaths(): HostPaths {
  return { remote: false, home: agentHome(), kitDir: kitDir(), isolationDir: isolationDir(), userHome: homedir() };
}

/**
 * 지금 호스트 (설계 DESIGN-APPS.md §6 D3). 앱은 한 번에 한 호스트에 붙고, 설정에서 바꾸면 다시 연결한다.
 * hostPaths는 연결을 준비할 때(원격이면 kit을 올린 뒤) 정해진다.
 */
const hostChoiceFile = () => join(app.getPath("userData"), "agent-host.json");
let currentHostId = LOCAL_HOST_ID;
let hostPaths: HostPaths | undefined;
let sshHostStore: SshHostStore | undefined;
const sshHosts = () => (sshHostStore ??= new SshHostStore(join(app.getPath("userData"), "ssh-hosts.json")));

function requirePaths(): HostPaths {
  if (!hostPaths) throw new Error("호스트에 아직 연결되지 않았습니다");
  return hostPaths;
}

/** 이 PC에서만 되는 일 (파일을 OS 프로그램으로 열기 등). 원격이면 이유를 알린다 */
function localOnly(what: string): void {
  if (hostPaths?.remote) throw new Error(`${what}은(는) 원격 호스트에서는 할 수 없습니다 (이 PC에서만 열 수 있습니다)`);
}

/** 로컬 개발 실행의 덮어쓰기 (저장소의 Pi, 격리된 Pi 설정, mock 프로바이더). 원격 호스트에는 넘기지 않는다 */
/** pi 하위 명령(install·remove·list·mcp)에 쓸 덮어쓰기. 개발용 세션 인자(--provider 등)는 하위 명령 앞에 붙으면 안 되므로 뺀다 */
function piCommandOverrides(): { piCliPath?: string; env?: Record<string, string> } {
  const { piArgs: _sessionArgs, ...rest } = piOverrides();
  return rest;
}

function piOverrides(): { piCliPath?: string; piArgs?: string[]; env?: Record<string, string> } {
  if (hostPaths?.remote) return {};
  const overrides = devSessionOverrides();
  return { ...(overrides.piCliPath ? { piCliPath: overrides.piCliPath } : {}), ...(overrides.piArgs ? { piArgs: overrides.piArgs } : {}), ...(overrides.env ? { env: overrides.env } : {}) };
}

/** 데몬에 상주시키는 스케줄러 세션의 작업 폴더 (호스트마다 하나). 이 폴더로 연 세션이 있으면 이미 떠 있는 것으로 본다 */
function schedulerDir(): string {
  return schedulerDirFor(requirePaths());
}

/**
 * 세션 열기 파라미터 (host-session.ts). 개발용 덮어쓰기(저장소의 Pi, 격리된 Pi 설정, mock 프로바이더)는 로컬에서만 깐다.
 * 세션·스킬·프롬프트·MCP·AGENTS.md는 그 호스트의 앱 홈에서만 올린다 (DESIGN-APPS.md §3.1).
 */
async function sessionParams(cwd: string, extraEnv: Record<string, string> = {}): Promise<SessionOpenParams> {
  const paths = requirePaths();
  const local = !paths.remote;
  const data: Record<string, string> = local && process.env.PI_DESKTOP_AGENT_DATA ? { PI_DESKTOP_AGENT_DATA: process.env.PI_DESKTOP_AGENT_DATA } : {};
  return sessionParamsFor({ paths, localKitDir: kitDir(), cwd, ...(local ? { overrides: devSessionOverrides() } : {}), extraEnv: { ...data, ...extraEnv } });
}

/**
 * 예약을 돌리는 스케줄러 세션을 그 호스트의 데몬에 하나 띄워 둔다 (설계 DESIGN-AGENT.md §4 "예약·주기 작업", DESIGN-APPS.md §4 ④).
 * 데몬은 돌고 있는 세션이 있으면 꺼지지 않으므로, 앱을 닫아도 예약이 돈다. 이미 떠 있으면 아무것도 하지 않는다.
 */
async function ensureSchedulerSession(connection: HostConnection): Promise<void> {
  const paths = requirePaths();
  const cwd = schedulerDirFor(paths);
  const sessions = await connection.request<SessionSummary[]>(Methods.sessionList);
  if (sessions.some((s) => s.cwd === cwd && s.state === "running")) return;
  if (paths.remote) {
    // 원격 폴더는 데몬으로 만든다. 이미 있으면 오류가 나므로 무시한다
    await connection.request(Methods.fsMakeDir, { parent: paths.home, name: "scheduler" }).catch(() => undefined);
  } else {
    await mkdir(cwd, { recursive: true });
  }
  await connection.request<SessionOpenResult>(Methods.sessionOpen, await sessionParams(cwd, { PI_DESKTOP_AGENT_SCHEDULER: "1" }));
}

let mainWindow: BrowserWindow | undefined;
const replays = new ReplayCollector<SessionEventNotification>();

function sendToRenderer(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

/** Host Agent 번들의 package.json에서 버전을 읽는다 (원격 배포 파일 이름에 쓰임). 설치본은 같은 폴더, 개발은 한 단계 위 (Pi Desktop과 같음) */
function agentVersion(script: string): string {
  for (const candidate of [join(dirname(script), "package.json"), join(dirname(script), "..", "package.json")]) {
    try {
      return String((JSON.parse(readFileSync(candidate, "utf8")) as { version?: unknown }).version ?? "0.0.0");
    } catch {
      // 다음 후보
    }
  }
  return "0.0.0";
}

/** 호스트마다 연결을 준비한다: 로컬은 바로, WSL·SSH는 Host Agent와 kit을 올린 뒤 (hosts.ts) */
async function prepareHost(hostId: string): Promise<LaunchSpec> {
  const script = agentScriptPath();
  if (hostId === LOCAL_HOST_ID) {
    const runtime = await resolveNodeRuntime();
    // 연결할 때마다 번들을 해시한다. 개발 중 다시 빌드하면 예전 데몬을 바꾸도록 (Pi Desktop과 같음).
    const agentBuild = agentBuildId(await readFile(script));
    hostPaths = localPaths();
    return { command: runtime.command, args: [script, "connect"], env: { ...runtime.env, PI_DESKTOP_HOME: agentHome() }, agentBuild };
  }
  const options = { agentScript: script, agentVersion: agentVersion(script), kitDir: kitDir(), isolationDir: isolationDir() };
  let prepared: Prepared;
  if (hostId.startsWith(WSL_PREFIX)) prepared = await prepareAgentWsl(hostId.slice(WSL_PREFIX.length), options);
  else if (hostId.startsWith(SSH_PREFIX)) {
    const host = sshHosts().get(hostId.slice(SSH_PREFIX.length));
    if (!host) throw new Error(`등록되지 않은 SSH 호스트입니다: ${hostId.slice(SSH_PREFIX.length)}`);
    prepared = await prepareAgentSsh(host, options);
  } else throw new Error(`알 수 없는 호스트입니다: ${hostId}`);
  hostPaths = prepared.paths;
  return prepared.spec;
}

function createConnection(hostId: string, onConnected: () => void): HostConnection {
  const ignore = () => {};
  return new HostConnection({
    prepare: () => prepareHost(hostId),
    onState: (state) => {
      sendToRenderer(IpcChannels.connectionChanged, state);
      if (state.status === "connected") onConnected();
    },
    onSessionEvent: (n) => {
      replays.capture(n.sessionId, n);
      sendToRenderer(IpcChannels.sessionEvent, n);
      notifySession(n);
    },
    onSessionExit: (n) => {
      forgetDialog(n.sessionId);
      sendToRenderer(IpcChannels.sessionExit, n);
    },
    onUiResolved: (n) => {
      forgetDialog(n.sessionId, n.id);
      sendToRenderer(IpcChannels.uiResolved, n);
    },
    // 아래는 Pi Desktop 전용 기능(팔로우·여러 앱 입력 권한·Playground 등)이라 P0에서는 쓰지 않는다.
    onStoredChanged: ignore,
    onExternalWrite: ignore,
    onWriterChanged: ignore,
    onFilesChanged: ignore,
    onPlaygroundOutput: ignore,
    onPiUpdateOutput: ignore,
    // 늘 떠 있는 예약 작업 세션은 데몬 교체를 막지 않는다 (붙은 뒤 ensureSchedulerSession이 새 데몬에 다시 띄운다).
    // 이 세션까지 세면 앱을 업데이트해도 예전 데몬이 계속 남아 새 기능 요청(agent.call 등)을 거절한다
    blocksReplace: (session) => !hostPaths || session.cwd !== schedulerDir(),
  });
}

function registerIpc(conn: () => HostConnection): void {
  ipcMain.handle(IpcChannels.connectionState, () => conn().current);
  ipcMain.handle(IpcChannels.piSetup, async (): Promise<PiSetupView> => {
    // Pi 관리는 Pi Desktop이 맡는다. 여기서는 데몬이 아는 상태를 모아 안내만 한다 (설계 DESIGN-AGENT.md §0)
    const status = await conn().request<PiStatus>(Methods.piStatus);
    const models = status.pi ? await conn().request<PiModelsResult>(Methods.piModels, undefined, 60_000).catch((e: unknown) => ({ models: [], error: String(e) })) : { models: [] };
    return {
      ...(status.pi ? { piVersion: status.pi.version } : {}),
      ...(status.piError ? { piError: status.piError } : {}),
      node: { version: status.node.version, required: status.node.required, ok: status.node.ok },
      ...(status.gitBash ? { gitBash: { found: status.gitBash.found } } : {}),
      authProviders: status.data.authProviders,
      models: models.models,
      ...(models.error ? { modelsError: models.error } : {}),
      ...(findPiDesktop() ? { piDesktopPath: findPiDesktop() } : {}),
      platform: status.platform,
    };
  });
  ipcMain.handle(IpcChannels.openPiDesktop, () => openPiDesktop());
  ipcMain.handle(IpcChannels.installPiDesktop, async () => {
    const result = await installPiDesktop(mainWindow, (received, total) => mainWindow?.webContents.send(IpcChannels.installProgress, received, total));
    return { status: result.status };
  });
  // 지식베이스·스킬·승인 규칙·관리자 권한은 그 호스트의 데몬이 agent-kit의 같은 함수로 같은 파일을 읽고 고친다
  // (DESIGN-APPS.md §6 D4, agent-kit src/app-api.ts). 사람이 직접 고쳐도 되는 파일이다
  const forward = (channel: string, name: string) => ipcMain.handle(channel, (_event, ...args: unknown[]) => agentCall(name, ...args));
  forward(IpcChannels.skillsList, "skillsList");
  forward(IpcChannels.skillSave, "skillSave");
  forward(IpcChannels.skillDelete, "skillDelete");
  ipcMain.handle(IpcChannels.skillOpenFolder, async () => {
    localOnly("스킬 폴더 열기");
    const dir = await agentCall<string>("skillsDir");
    await mkdir(dir, { recursive: true });
    const error = await shell.openPath(dir);
    if (error) throw new Error(error);
  });
  forward(IpcChannels.kbList, "kbList");
  forward(IpcChannels.kbSave, "kbSave");
  forward(IpcChannels.kbBulk, "kbBulk");
  forward(IpcChannels.kbMerge, "kbMerge");
  forward(IpcChannels.kbReviewed, "kbReviewed");
  forward(IpcChannels.kbReview, "kbReview");
  forward(IpcChannels.kbStats, "kbStats");
  forward(IpcChannels.kbPreview, "kbPreview");
  ipcMain.handle(IpcChannels.kbExport, async () => {
    // 글은 그 호스트에서 만들고, 파일은 이 PC에 저장한다
    const text = await agentCall<string>("kbExportText");
    const options = { defaultPath: join(homedir(), "지식베이스.md"), filters: [{ name: "Markdown", extensions: ["md"] }] };
    const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return undefined;
    await writeFile(result.filePath, text, "utf8");
    return result.filePath;
  });
  forward(IpcChannels.getElevation, "getElevation");
  forward(IpcChannels.setElevation, "setElevation");
  forward(IpcChannels.getAutoLearn, "getAutoLearn");
  forward(IpcChannels.setAutoLearn, "setAutoLearn");
  forward(IpcChannels.listRules, "listRules");
  forward(IpcChannels.removeRule, "removeRule");
  forward(IpcChannels.listAudit, "listAudit");
  // MCP·네트워크·사용량도 그 호스트의 데몬이 다룬다 (D4). Pi를 띄우는 것(연결 확인·카드 초안)도 그 호스트의 Pi로
  forward(IpcChannels.listMcp, "mcpList");
  forward(IpcChannels.addMcpPreset, "mcpAddPreset");
  forward(IpcChannels.setMcpEnabled, "mcpSetEnabled");
  forward(IpcChannels.removeMcp, "mcpRemove");
  // mcp.json은 앱 안에서 고친다 (웹·원격 호스트에서는 파일을 프로그램으로 열 수 없다)
  forward(IpcChannels.mcpReadText, "mcpReadText");
  forward(IpcChannels.mcpWriteText, "mcpWriteText");
  ipcMain.handle(IpcChannels.checkMcp, () => agentCall<McpCheckResult>("mcpCheck", piCommandOverrides()));
  // Pi 패키지(확장)와 다른 앱에서 가져오기 (DESIGN-APPS.md §3.5). 설치는 그 호스트의 Pi로, 오래 걸릴 수 있다
  forward(IpcChannels.packagesList, "packagesList");
  ipcMain.handle(IpcChannels.packageInstall, (_event, source: string) => agentCallLong("packageInstall", source, piCommandOverrides()));
  ipcMain.handle(IpcChannels.packageRemove, (_event, source: string) => agentCallLong("packageRemove", source, piCommandOverrides()));
  forward(IpcChannels.importList, "importList");
  forward(IpcChannels.importSkill, "importSkill");
  forward(IpcChannels.networkState, "networkState");
  forward(IpcChannels.setNetworkSettings, "setNetworkSettings");
  forward(IpcChannels.saveCard, "saveCard");
  forward(IpcChannels.previewPeer, "previewPeer");
  forward(IpcChannels.pairWith, "pairWith");
  forward(IpcChannels.checkPairings, "checkPairings");
  forward(IpcChannels.approvePairing, "approvePairing");
  forward(IpcChannels.rejectPairing, "rejectPairing");
  forward(IpcChannels.forgetPeer, "forgetPeer");
  forward(IpcChannels.approvePeerTask, "approvePeerTask");
  forward(IpcChannels.rejectPeerTask, "rejectPeerTask");
  forward(IpcChannels.setPeerPolicy, "setPeerPolicy");
  forward(IpcChannels.usageSummary, "usageSummary");
  ipcMain.handle(IpcChannels.listSessions, async (): Promise<ChatSummary[]> => {
    if (!hostPaths) return [];
    const sessions = await conn().request<SessionSummary[]>(Methods.sessionList);
    const chats = sessions.filter((s) => s.state === "running" && s.cwd !== schedulerDir()).sort((a, b) => b.startedAt - a.startedAt);
    // 이름은 Pi 세션 파일에 있다 (set_session_name). 이름을 못 읽어도 목록은 보인다
    return Promise.all(
      chats.map(async (s): Promise<ChatSummary> => {
        try {
          const state = await conn().request<PiResponse>(Methods.sessionSend, { sessionId: s.sessionId, command: { type: "get_state" } }, 3000);
          const name = (state.data as { sessionName?: string } | undefined)?.sessionName;
          return name ? { ...s, name } : s;
        } catch {
          return s;
        }
      }),
    );
  });
  ipcMain.handle(IpcChannels.closeSession, async (_event, sessionId: string) => {
    await conn().request(Methods.sessionClose, { sessionId });
  });
  // 호스트 (설계 DESIGN-APPS.md §6 D3): 고르기, SSH 호스트 관리, 그 호스트의 폴더 훑기
  ipcMain.handle(IpcChannels.listHosts, async (): Promise<HostView[]> => [
    { id: LOCAL_HOST_ID, kind: "local", label: localHostLabel() },
    ...(await listWslDistros()).map((d): HostView => ({ id: `${WSL_PREFIX}${d}`, kind: "wsl", label: `WSL: ${d}` })),
    ...sshHosts().list().map((h): HostView => ({ id: `${SSH_PREFIX}${h.name}`, kind: "ssh", label: `SSH: ${h.name}` })),
  ]);
  ipcMain.handle(IpcChannels.currentHost, (): CurrentHost => ({ id: currentHostId, remote: currentHostId !== LOCAL_HOST_ID }));
  ipcMain.handle(IpcChannels.setHost, (_event, hostId: string) => switchHost(hostId));
  ipcMain.handle(IpcChannels.replaceAgent, () => conn().replaceAgent());
  ipcMain.handle(IpcChannels.listSshHosts, () => sshHosts().list());
  ipcMain.handle(IpcChannels.saveSshHost, (_event, host: SshHostConfig, previousName?: string) => sshHosts().save(host, previousName));
  ipcMain.handle(IpcChannels.removeSshHost, async (_event, name: string) => {
    if (currentHostId === `${SSH_PREFIX}${name}`) throw new Error("지금 쓰는 호스트입니다. 다른 호스트로 바꾼 뒤 지우세요");
    sshHosts().remove(name);
  });
  ipcMain.handle(IpcChannels.listDir, (_event, _hostId: string, path?: string) => conn().request<FsListDirResult>(Methods.fsListDir, path ? { path } : {}));
  ipcMain.handle(IpcChannels.makeDir, async (_event, _hostId: string, parent: string, name: string) =>
    (await conn().request<{ path: string }>(Methods.fsMakeDir, { parent, name })).path,
  );
  ipcMain.handle(IpcChannels.defaultCwd, () => hostPaths?.userHome ?? homedir());
  ipcMain.handle(IpcChannels.pickDirectory, async () => {
    const options = { properties: ["openDirectory" as const, "createDirectory" as const] };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    return result.canceled ? undefined : result.filePaths[0];
  });
  ipcMain.handle(IpcChannels.pickFiles, async () => {
    const options = { properties: ["openFile" as const, "multiSelections" as const] };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle(IpcChannels.readImages, (_event, paths: string[]) =>
    Promise.all(
      paths.map(async (path): Promise<ImageAttachment> => {
        const name = basename(path);
        const mimeType = imageMimeType(path) ?? "application/octet-stream";
        try {
          const size = (await stat(path)).size;
          if (size > MAX_IMAGE_BYTES) return { name, mimeType, error: `${(size / 1024 / 1024).toFixed(1)}MB라 너무 큽니다 (5MB까지)` };
          return { name, mimeType, data: (await readFile(path)).toString("base64") };
        } catch (error) {
          return { name, mimeType, error: error instanceof Error ? error.message : String(error) };
        }
      }),
    ),
  );
  ipcMain.handle(IpcChannels.listTasks, () => agentCall("listTasks", 30));
  forward(IpcChannels.listSchedules, "listSchedules");
  forward(IpcChannels.setScheduleEnabled, "setScheduleEnabled");
  forward(IpcChannels.removeSchedule, "removeSchedule");
  ipcMain.handle(IpcChannels.openSession, async (_event, cwd: string, from?: SessionSource) => {
    // forkFrom: 다른 폴더로 대화를 옮길 때 지금 세션 파일에서 분기한다 (pi --fork, 원래 세션 파일은 그대로)
    // sessionFile: 지난 대화를 그 파일 그대로 이어서 연다
    const params = await sessionParams(cwd);
    const result = await conn().request<SessionOpenResult>(Methods.sessionOpen, { ...params, ...from });
    return result.session;
  });
  /** 지난 대화. 그 호스트의 앱 홈 세션 폴더만 본다 (Pi Desktop·터미널 pi의 세션은 섞지 않는다) */
  const history = async (): Promise<StoredSession[]> => {
    const paths = requirePaths();
    const overrides = paths.remote ? {} : devSessionOverrides();
    const stored = await conn().request<StoredSession[]>(
      Methods.sessionHistory,
      { sessionDir: sessionsDirFor(paths), limit: 300, ...(overrides.piCliPath ? { piCliPath: overrides.piCliPath } : {}) },
      30_000,
    );
    return stored.filter((s) => s.cwd !== schedulerDir());
  };
  ipcMain.handle(IpcChannels.listHistory, history);
  ipcMain.handle(IpcChannels.suggestCard, async (_event, current: CardDraft) => {
    // 재료로 쓸 대화 이름은 그 호스트의 지난 대화에서
    const sessionNames = (await history().catch(() => [])).flatMap((h) => (h.name ? [h.name] : []));
    return agentCall("suggestCard", current, sessionNames, piOverrides());
  });
  // 아카이브·휴지통 (설계 DESIGN-APPS.md §3.2). 데몬 홈(~/.pi-desktop-agent)의 것이라 Pi Desktop과 섞이지 않는다
  ipcMain.handle(IpcChannels.deleteChat, async (_event, path: string) => {
    const sessions = await conn().request<SessionSummary[]>(Methods.sessionList);
    if (sessions.some((s) => s.state === "running" && s.sessionFile === path)) throw new Error("열려 있는 대화입니다. 대화를 닫은 뒤 지우세요");
    await conn().request(Methods.storedDelete, { path });
  });
  ipcMain.handle(IpcChannels.setArchived, async (_event, path: string, archived: boolean) => {
    await conn().request(Methods.archiveSet, { path, archived: archived === true });
  });
  ipcMain.handle(IpcChannels.listTrash, () => conn().request<TrashItem[]>(Methods.trashList));
  ipcMain.handle(IpcChannels.restoreTrash, async (_event, id: string) => {
    await conn().request(Methods.trashRestore, { id });
  });
  ipcMain.handle(IpcChannels.emptyTrash, async (_event, ids?: string[]) =>
    (await conn().request<TrashEmptyResult>(Methods.trashEmpty, ids ? { ids } : {})).removed,
  );
  ipcMain.handle(IpcChannels.searchHistory, async (_event, query: string) => {
    // 본문은 그 호스트의 데몬이 읽는다 (아카이브한 대화는 찾지 않는다)
    const items = (await history()).filter((s) => !s.archived).map((s) => ({ path: s.path, firstMessage: s.firstMessage, ...(s.name ? { name: s.name } : {}) }));
    return agentCall("searchHistory", items, query);
  });
  ipcMain.handle(IpcChannels.attachSession, async (_event, sessionId: string, lastSeq: number) => {
    // attach 도중 알림으로 온 이벤트도 결과에 담는다. 렌더러는 순번으로 중복을 거른다 (replay-collector.ts).
    const events = replays.begin(sessionId);
    try {
      const result = await conn().request<SessionAttachResult>(Methods.sessionAttach, { sessionId, lastSeq });
      const reply: AttachResult = { ...result, events };
      return reply;
    } finally {
      replays.end(sessionId, events);
    }
  });
  ipcMain.handle(IpcChannels.sendCommand, (_event, sessionId: string, command: Record<string, unknown>) =>
    conn().request<PiResponse>(Methods.sessionSend, { sessionId, command }),
  );
  ipcMain.handle(IpcChannels.sendRecord, async (_event, sessionId: string, record: Record<string, unknown>) => {
    await conn().request(Methods.sessionSend, { sessionId, command: record, noResponse: true });
  });
}

/** 창 아이콘. 개발 실행은 build/icon.png, Linux 설치본은 실행 파일에 아이콘이 없어 리소스의 것을 준다 (Pi Desktop과 같음) */
function windowIcon(): { icon?: string } {
  if (!app.isPackaged) return { icon: join(app.getAppPath(), "build", "icon.png") };
  return process.platform === "linux" ? { icon: join(process.resourcesPath, "icon.png") } : {};
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 760,
    minWidth: 640,
    minHeight: 480,
    title: "Pi Desktop Agent",
    backgroundColor: "#16171d",
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

  // 개발 서버 주소는 개발 실행에서만 쓴다 (설치본이 환경 변수의 주소를 열면 그 페이지가 preload API를 갖게 된다).
  if (process.env.ELECTRON_RENDERER_URL && !app.isPackaged) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(here, "../renderer/index.html"));
  }
}

let connection: HostConnection | undefined;
let taskWatcher: TaskWatcher | undefined;

/** 그 호스트의 데몬에서 agent-kit 데이터 함수를 부른다 (DESIGN-APPS.md §6 D4, agent-kit src/app-api.ts) */
function agentCall<T = unknown>(name: string, ...args: unknown[]): Promise<T> {
  if (!connection) return Promise.reject(new Error("호스트에 아직 연결되지 않았습니다"));
  return connection.request<T>(Methods.agentCall, { name, args });
}

/** 오래 걸리는 데몬 호출 (패키지 설치 등). 기본 요청 시간 제한(2분) 대신 15분 */
function agentCallLong<T = unknown>(name: string, ...args: unknown[]): Promise<T> {
  if (!connection) return Promise.reject(new Error("호스트에 아직 연결되지 않았습니다"));
  return connection.request<T>(Methods.agentCall, { name, args }, 15 * 60_000);
}

/** 끝난 작업 알림은 호스트마다 처음 읽은 것을 기준으로 삼는다 (호스트를 바꾸면 새로 시작) */
function watchTasks(): void {
  taskWatcher?.stop();
  taskWatcher = new TaskWatcher(
    () => agentCall<TaskRecord[]>("listTasks", 200),
    notifyTask,
    () => sendToRenderer(IpcChannels.tasksChanged, null),
  );
  taskWatcher.start();
}

/** 고른 호스트에 붙는 연결을 만든다. 붙으면 그 호스트의 스케줄러 세션을 확인한다 */
function connectTo(hostId: string): HostConnection {
  const created = createConnection(hostId, () => {
    // 실패해도 대화는 쓸 수 있어야 한다. 다음에 다시 붙을 때 다시 시도한다
    ensureSchedulerSession(created).catch((error: unknown) => console.error("스케줄러 세션을 띄우지 못했다:", error));
  });
  return created;
}

/**
 * 호스트를 바꾼다: 고른 것을 저장하고, 지금 연결기를 끝내고 새 호스트에 붙는다.
 * 앞 호스트의 데몬과 대화는 그 호스트에서 계속 돈다 (돌아오면 다시 보인다). 화면은 새로 읽는다.
 */
async function switchHost(hostId: string): Promise<void> {
  if (hostId === currentHostId) return;
  if (hostId.startsWith(SSH_PREFIX) && !sshHosts().get(hostId.slice(SSH_PREFIX.length))) throw new Error("등록되지 않은 SSH 호스트입니다");
  writeHostChoice(hostChoiceFile(), hostId);
  currentHostId = hostId;
  connection?.dispose();
  hostPaths = undefined;
  sessionFolders = new Map();
  connection = connectTo(hostId);
  connection.start();
  watchTasks();
  mainWindow?.webContents.reload();
}

app.whenReady().then(() => {
  currentHostId = readHostChoice(hostChoiceFile());
  connection = connectTo(currentHostId);
  registerIpc(() => connection!);

  // 자동 업데이트 (Pi Desktop Mate와 같은 방식: 가장 높은 agent-v* 릴리스를 generic으로)
  const updater = new Updater((state) => sendToRenderer(IpcChannels.updateStateChanged, state), () => mainWindow);
  ipcMain.handle(IpcChannels.updateState, () => updater.current);
  ipcMain.handle(IpcChannels.checkForUpdates, (_event, interactive?: boolean) => updater.check(interactive === true));
  ipcMain.handle(IpcChannels.confirmUpdate, () => updater.confirmUpdate());
  updater.start();

  // 기능 화면은 사이드바가 아니라 메뉴바에서 연다 (app-menu.ts)
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      appMenuTemplate(process.platform, app.isPackaged, {
        command: (id) => sendToRenderer(IpcChannels.menuCommand, id),
        checkForUpdates: () => void updater.check(true),
        openReleases: () => void shell.openExternal(`https://github.com/${OWNER}/${REPO}/releases`),
        about: () =>
          void dialog.showMessageBox({
            type: "info",
            title: "Pi Desktop Agent 정보",
            message: `Pi Desktop Agent ${app.getVersion()}`,
            detail: `Pi를 엔진으로 쓰는 데스크톱 에이전트 (기능은 agent-kit)\nElectron ${process.versions.electron} · Node ${process.versions.node}\nhttps://github.com/${OWNER}/${REPO}`,
          }),
      }),
    ),
  );
  // Windows 작업 표시줄·알림의 앱 식별자. 설치 프로그램이 만든 바로 가기는 electron-builder의 appId를 쓰므로
  // 같은 값이어야 한다. 다르면 실행 중인 창이 다른 앱으로 묶여 기본 Electron 아이콘이 보인다.
  app.setAppUserModelId("dev.pi-desktop.agent");
  watchTasks();
  createWindow();
  connection!.start();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// 앱을 닫아도 데몬과 Pi 세션은 계속 돈다. 연결기만 정리한다 (DESIGN.md §3.4).
app.on("will-quit", () => connection?.dispose());
