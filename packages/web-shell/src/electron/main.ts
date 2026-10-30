import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DialogRequest, MenuGroup } from "../protocol";
import { IpcHub } from "../server/ipc-hub";

/**
 * Electron main 프로세스 API의 웹 대체 모듈 (설계 DESIGN.md §5.11).
 *
 * 웹 서버를 묶을 때 앱(apps/agent·apps/mate)의 main 코드가 가져오는 "electron"을 이 파일로 바꾼다.
 * 그래서 앱 코드는 고치지 않고 Node 서버에서 그대로 돈다.
 * - ipcMain → IpcHub (WebSocket으로 붙은 브라우저 탭들)
 * - BrowserWindow.webContents.send → 모든 탭에 알림, reload → 탭이 화면을 새로 읽음
 * - dialog → 탭이 띄우는 대화상자 (서버의 폴더·파일을 훑거나 휴대폰 파일을 올린다)
 * - Menu.setApplicationMenu → 탭의 "⋮ 메뉴"
 * - shell.openExternal → 탭이 새 창으로 엶, Notification → 탭의 알림 띠
 * - safeStorage → 데이터 폴더의 키 파일(0600)로 암호화 (OS 키체인 대신)
 * 웹 서버 진입점은 앱 main을 불러오기 전에 configureShell을 부른다.
 */

export interface ShellConfig {
  /** 앱 이름 (app.getName) */
  name: string;
  version: string;
  /** app.getPath("userData") 자리. 웹 서버의 데이터 폴더 */
  dataDir: string;
  /** app.getAppPath() */
  appPath: string;
  /** app.isPackaged (true면 앱이 process.resourcesPath에서 번들 파일을 찾는다) */
  packaged: boolean;
}

export const hub = new IpcHub();

let config: ShellConfig = {
  name: "pi-web",
  version: "0.0.0",
  dataDir: join(homedir(), ".pi-web", "data"),
  appPath: process.cwd(),
  packaged: true,
};

export function configureShell(next: ShellConfig): void {
  config = next;
}

// ── app ──────────────────────────────────────────────────────────────

type Listener = (...args: any[]) => unknown;
const appListeners = new Map<string, Set<Listener>>();
let markReady: () => void = () => {};
let ready = false;
const readyPromise = new Promise<void>((resolve) => {
  markReady = () => {
    ready = true;
    resolve();
  };
});
const paths = new Map<string, string>();

/** 웹 서버가 준비되면 부른다 (app.whenReady를 푼다) */
export function appReady(): void {
  markReady();
}

/** 앱 이벤트를 일으킨다 (서버를 끌 때 will-quit 등) */
export function emitApp(event: string, ...args: unknown[]): void {
  for (const listener of appListeners.get(event) ?? []) listener(...args);
}

/** app.quit()이 불리면 이것을 부른다 (웹 서버가 정리하고 끝낸다) */
let quitHandler: () => void = () => process.exit(0);
export function onQuit(handler: () => void): void {
  quitHandler = handler;
}

function downloadsDir(): string {
  // Termux는 termux-setup-storage를 하면 ~/storage/downloads가 휴대폰의 다운로드 폴더다
  const termux = join(homedir(), "storage", "downloads");
  return existsSync(termux) ? termux : join(homedir(), "Downloads");
}

export const app = {
  get isPackaged(): boolean {
    return config.packaged;
  },
  whenReady: () => readyPromise,
  isReady: () => ready,
  on(event: string, listener: Listener) {
    let set = appListeners.get(event);
    if (!set) appListeners.set(event, (set = new Set()));
    set.add(listener);
    return app;
  },
  once(event: string, listener: Listener) {
    const wrapped: Listener = (...args) => {
      appListeners.get(event)?.delete(wrapped);
      return listener(...args);
    };
    return app.on(event, wrapped);
  },
  getVersion: () => config.version,
  getName: () => config.name,
  getAppPath: () => config.appPath,
  getPath(name: string): string {
    const set = paths.get(name);
    if (set) return set;
    switch (name) {
      case "userData":
        return config.dataDir;
      case "appData":
        return dirname(config.dataDir);
      case "home":
        return homedir();
      case "temp":
        return tmpdir();
      case "downloads":
        return downloadsDir();
      case "logs":
        return join(config.dataDir, "logs");
      default:
        return join(config.dataDir, name);
    }
  },
  setPath(name: string, path: string): void {
    paths.set(name, path);
  },
  quit: () => quitHandler(),
  exit: () => quitHandler(),
  // 한 데이터 폴더에 서버 하나만 뜨는 것은 실행 명령(pid 파일)이 맡는다
  requestSingleInstanceLock: () => true,
  releaseSingleInstanceLock: () => {},
  setAppUserModelId: () => {},
  getLoginItemSettings: () => ({ openAtLogin: false, wasOpenedAtLogin: false }),
  setLoginItemSettings: () => {},
  focus: () => {},
  commandLine: { appendSwitch: () => {}, hasSwitch: () => false },
};

// ── ipcMain ──────────────────────────────────────────────────────────

export const ipcMain = {
  handle: (channel: string, handler: Listener) => hub.handle(channel, handler),
  removeHandler: (channel: string) => hub.removeHandler(channel),
  on(channel: string, listener: Listener) {
    hub.on(channel, listener);
    return ipcMain;
  },
  removeListener(channel: string, listener: Listener) {
    hub.removeListener(channel, listener);
    return ipcMain;
  },
};

// ── BrowserWindow ────────────────────────────────────────────────────

const windows: BrowserWindow[] = [];

/** 창 하나 = 이 앱을 연 브라우저 탭 모두. 보내기는 모든 탭으로 간다 */
export class BrowserWindow {
  private destroyed = false;
  readonly webContents = {
    send: (channel: string, ...args: unknown[]) => hub.broadcast(channel, ...args),
    reload: () => hub.controlAll({ kind: "reload" }),
    isDestroyed: () => this.destroyed,
    setWindowOpenHandler: () => {},
    on: () => this.webContents,
    once: () => this.webContents,
    getURL: () => "",
    openDevTools: () => {},
    session: { clearCache: async () => {} },
  };

  constructor(_options?: unknown) {
    windows.push(this);
  }

  static getAllWindows(): BrowserWindow[] {
    return windows.filter((w) => !w.destroyed);
  }

  static getFocusedWindow(): BrowserWindow | undefined {
    return BrowserWindow.getAllWindows()[0];
  }

  loadURL = async (_url: string) => {};
  loadFile = async (_path: string) => {};
  on = (_event: string, _listener: Listener) => this;
  once = (_event: string, _listener: Listener) => this;
  isDestroyed = () => this.destroyed;
  // 브라우저 탭이 보이는지는 알 수 없다. 알림은 늘 보낸다 (탭이 화면 안의 띠로 보인다)
  isFocused = () => false;
  isVisible = () => true;
  isMinimized = () => false;
  restore = () => {};
  focus = () => {};
  show = () => {};
  setTitle = (_title: string) => {};
  setProgressBar = (_progress: number) => {};
  close = () => {};
  destroy = () => {
    this.destroyed = true;
  };
}

// ── dialog ───────────────────────────────────────────────────────────

interface OpenDialogOptions {
  title?: string;
  defaultPath?: string;
  properties?: string[];
}

/** dialog.showOpenDialog(window?, options) 처럼 첫 인자가 창일 수 있다 */
function optionsOf<T>(args: unknown[]): T {
  const last = args.at(-1);
  return (last && typeof last === "object" && !(last instanceof BrowserWindow) ? last : {}) as T;
}

export const dialog = {
  async showOpenDialog(...args: unknown[]): Promise<{ canceled: boolean; filePaths: string[] }> {
    const options = optionsOf<OpenDialogOptions>(args);
    const properties = options.properties ?? ["openFile"];
    const request: DialogRequest = {
      kind: "open",
      ...(options.title ? { title: options.title } : {}),
      ...(options.defaultPath ? { defaultPath: options.defaultPath } : {}),
      directory: properties.includes("openDirectory"),
      multiple: properties.includes("multiSelections"),
    };
    const answer = await hub.ask(request);
    const filePaths = Array.isArray(answer) ? answer.filter((p): p is string => typeof p === "string") : [];
    return { canceled: filePaths.length === 0, filePaths };
  },
  async showSaveDialog(...args: unknown[]): Promise<{ canceled: boolean; filePath?: string }> {
    const options = optionsOf<{ title?: string; defaultPath?: string }>(args);
    const answer = await hub.ask({
      kind: "save",
      ...(options.title ? { title: options.title } : {}),
      ...(options.defaultPath ? { defaultPath: options.defaultPath } : {}),
    });
    return typeof answer === "string" && answer ? { canceled: false, filePath: answer } : { canceled: true };
  },
  async showMessageBox(...args: unknown[]): Promise<{ response: number; checkboxChecked: boolean }> {
    const options = optionsOf<{ type?: string; title?: string; message?: string; detail?: string; buttons?: string[]; cancelId?: number }>(args);
    const buttons = options.buttons && options.buttons.length > 0 ? options.buttons : ["확인"];
    const answer = await hub.ask({
      kind: "message",
      ...(options.type ? { type: options.type } : {}),
      ...(options.title ? { title: options.title } : {}),
      message: options.message ?? "",
      ...(options.detail ? { detail: options.detail } : {}),
      buttons,
    });
    const cancel = options.cancelId ?? buttons.length - 1;
    return { response: typeof answer === "number" ? answer : cancel, checkboxChecked: false };
  },
  showErrorBox(title: string, content: string): void {
    hub.controlAll({ kind: "notify", title, body: content, level: "error" });
  },
};

// ── shell ────────────────────────────────────────────────────────────

export const shell = {
  async openExternal(url: string): Promise<void> {
    if (/^https?:\/\//i.test(url)) hub.controlOne({ kind: "open", url });
  },
  /** Electron은 성공하면 ""을, 못 하면 오류 문구를 돌려준다 */
  async openPath(path: string): Promise<string> {
    return `웹 버전에서는 서버의 파일·폴더를 프로그램으로 열 수 없습니다: ${path}`;
  },
  showItemInFolder(path: string): void {
    hub.controlOne({ kind: "notify", title: "파일 위치", body: path });
  },
  beep: () => {},
};

// ── Menu ─────────────────────────────────────────────────────────────

interface TemplateItem {
  label?: string;
  role?: string;
  type?: string;
  accelerator?: string;
  checked?: boolean;
  enabled?: boolean;
  visible?: boolean;
  submenu?: TemplateItem[] | { template?: TemplateItem[] };
  click?: (...args: unknown[]) => unknown;
}

const menuClicks = new Map<string, () => unknown>();

/** 역할(role)만 있는 항목은 Electron·OS가 하던 일(복사, 확대, 종료 등)이라 웹 메뉴에서 뺀다 */
export function menuGroups(template: TemplateItem[]): { groups: MenuGroup[]; clicks: Map<string, () => unknown> } {
  const clicks = new Map<string, () => unknown>();
  const groups: MenuGroup[] = [];
  let counter = 0;
  const walk = (items: TemplateItem[], group: MenuGroup, prefix: string) => {
    for (const item of items) {
      if (item.visible === false || item.type === "separator") continue;
      const sub = Array.isArray(item.submenu) ? item.submenu : item.submenu?.template;
      if (sub) {
        walk(sub, group, item.label ? `${prefix}${item.label} › ` : prefix);
        continue;
      }
      if (!item.click || !item.label) continue;
      const id = `m${++counter}`;
      const click = item.click;
      clicks.set(id, () => click({}, undefined, {}));
      group.items.push({
        id,
        label: `${prefix}${item.label}`.replace(/&/g, ""),
        ...(item.accelerator ? { accelerator: item.accelerator } : {}),
        ...(item.type === "checkbox" || item.type === "radio" ? { checked: item.checked === true } : {}),
        ...(item.enabled === false ? { enabled: false } : {}),
      });
    }
  };
  for (const top of template) {
    const sub = Array.isArray(top.submenu) ? top.submenu : top.submenu?.template;
    const group: MenuGroup = { label: (top.label ?? "").replace(/&/g, ""), items: [] };
    if (sub) walk(sub, group, "");
    else if (top.click && top.label) walk([top], group, "");
    if (group.items.length > 0) groups.push(group);
  }
  return { groups, clicks };
}

export class Menu {
  constructor(readonly template: TemplateItem[] = []) {}

  static buildFromTemplate(template: TemplateItem[]): Menu {
    return new Menu(template);
  }

  static setApplicationMenu(menu: Menu | null): void {
    const { groups, clicks } = menuGroups(menu?.template ?? []);
    menuClicks.clear();
    for (const [id, click] of clicks) menuClicks.set(id, click);
    hub.setMenu(groups);
  }

  static getApplicationMenu(): Menu | null {
    return null;
  }

  popup(): void {}
}

/** 탭에서 메뉴 항목을 눌렀다 (web-server.ts가 부른다) */
export function clickMenu(id: string): void {
  const click = menuClicks.get(id);
  if (!click) throw new Error("메뉴가 바뀌었습니다. 다시 열어 고르세요");
  click();
}

// ── Notification ─────────────────────────────────────────────────────

export class Notification {
  static isSupported(): boolean {
    return true;
  }

  constructor(private readonly options: { title?: string; body?: string } = {}) {}

  show(): void {
    hub.controlAll({ kind: "notify", title: this.options.title ?? "", ...(this.options.body ? { body: this.options.body } : {}) });
  }

  on(): this {
    return this;
  }
}

// ── net, nativeTheme, safeStorage ────────────────────────────────────

export const net = {
  fetch: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
};

export const nativeTheme = {
  shouldUseDarkColors: true,
  themeSource: "system",
  on: () => nativeTheme,
};

/**
 * OS 키체인 대신 데이터 폴더의 키 파일(0600, 처음 쓸 때 만든다)로 AES-256-GCM 암호화한다.
 * 이 서버의 데이터 폴더를 읽을 수 있는 사람은 풀 수 있다 (Termux에서는 앱 자신만 읽는다).
 */
function secretKey(): Buffer {
  const path = join(config.dataDir, "secret.key");
  if (existsSync(path)) {
    const key = Buffer.from(readFileSync(path, "utf8").trim(), "base64");
    if (key.length === 32) return key;
  }
  mkdirSync(config.dataDir, { recursive: true });
  const key = randomBytes(32);
  writeFileSync(path, `${key.toString("base64")}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return key;
}

export const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString(text: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
    const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    return Buffer.concat([Buffer.from("pw1"), iv, cipher.getAuthTag(), body]);
  },
  decryptString(data: Buffer): string {
    if (data.subarray(0, 3).toString() !== "pw1") throw new Error("이 서버에서 암호화한 값이 아닙니다");
    const iv = data.subarray(3, 15);
    const tag = data.subarray(15, 31);
    const decipher = createDecipheriv("aes-256-gcm", secretKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data.subarray(31)), decipher.final()]).toString("utf8");
  },
};

const electron = { app, ipcMain, BrowserWindow, dialog, shell, Menu, Notification, net, nativeTheme, safeStorage };
export default electron;
