/**
 * 웹 껍데기(web-shell)의 WebSocket 메시지 (설계 DESIGN.md §5.11).
 *
 * Electron의 ipcRenderer.invoke·send와 webContents.send를 그대로 옮긴다. 채널 이름과 인자는 앱의 IPC와 같다.
 * 휴대폰 브라우저는 백그라운드로 가면 연결을 말없이 끊으므로, 연결이 끊겨도 주고받던 것을 잃지 않게 한다.
 * - 양쪽이 보내는 메시지에 순번을 붙인다 (브라우저 → 서버 n, 서버 → 브라우저 s)
 * - 받은 쪽은 어디까지 받았는지 ack로 알린다. 보낸 쪽은 ack를 받을 때까지 메시지를 가지고 있는다
 * - 다시 붙을 때 브라우저는 같은 client id와 마지막으로 받은 s를 주고, 서버는 hello로 마지막으로 받은 n을 알린다.
 *   서로 그 뒤의 것만 다시 보낸다. 서버가 그 사이 것을 버렸거나 다시 켜졌으면(resumed: false) 화면을 새로 읽는다
 *
 * JSON은 배열 속 undefined를 null로 바꾸므로, undefined였던 인자의 자리를 u에 적어 되살린다
 * (null과 undefined가 다른 뜻인 인자가 있다).
 */

/** 브라우저 → 서버 (순번 n이 붙는 것) */
export type ClientData =
  /** 요청/응답 (ipcRenderer.invoke) */
  | { t: "invoke"; n: number; id: number; ch: string; args: unknown[]; u?: number[] }
  /** 응답 없는 메시지 (ipcRenderer.send) */
  | { t: "send"; n: number; ch: string; args: unknown[]; u?: number[] }
  /** 서버가 물은 것(대화상자)의 답 */
  | { t: "answer"; n: number; id: number; value?: unknown };

/** 브라우저 → 서버 */
export type ClientMessage = ClientData | { t: "ack"; s: number };

/** 서버가 브라우저에 시키는 일 */
export type Control =
  /** 화면을 새로 읽는다 (webContents.reload) */
  | { kind: "reload" }
  /** 새 창(탭)으로 주소를 연다 (shell.openExternal) */
  | { kind: "open"; url: string }
  /** 알림 (Notification, 오류 상자) */
  | { kind: "notify"; title: string; body?: string; level?: "info" | "error" }
  /** 앱 메뉴가 바뀌었다 (Menu.setApplicationMenu) */
  | { kind: "menu"; groups: MenuGroup[] }
  /** 대화상자를 띄워 답을 받는다. 답은 ClientData answer로 */
  | { kind: "dialog"; id: number; request: DialogRequest }
  /** 다른 탭이 답해 대화상자가 끝났다 */
  | { kind: "dialog-done"; id: number };

/** 서버 → 브라우저 (순번 s가 붙는 것) */
export type ServerData =
  | { t: "result"; s: number; id: number; ok: true; value?: unknown }
  | { t: "result"; s: number; id: number; ok: false; error: string }
  /** 알림 (webContents.send) */
  | { t: "event"; s: number; ch: string; args: unknown[]; u?: number[] }
  | { t: "control"; s: number; control: Control };

/** 서버 → 브라우저 */
export type ServerMessage =
  /** 연결하자마자 보낸다. c: 서버가 처리한 브라우저 메시지의 마지막 순번 */
  | { t: "hello"; resumed: boolean; c: number; app: string; version: string }
  | { t: "ack"; c: number }
  | ServerData;

export interface MenuItem {
  id: string;
  label: string;
  accelerator?: string;
  checked?: boolean;
  enabled?: boolean;
}

export interface MenuGroup {
  label: string;
  items: MenuItem[];
}

export type DialogRequest =
  | { kind: "open"; title?: string; defaultPath?: string; directory: boolean; multiple: boolean }
  | { kind: "save"; title?: string; defaultPath?: string }
  | { kind: "message"; type?: string; title?: string; message: string; detail?: string; buttons: string[] };

/** 웹 껍데기가 쓰는 채널 (앱의 IPC 채널과 겹치지 않게 접두사를 붙인다) */
export const ShellChannels = {
  /** 메뉴 항목을 눌렀다 (id) */
  menuClick: "web-shell:menu-click",
  /** 서버의 폴더 내용 (path?) → DirListing */
  listDir: "web-shell:list-dir",
  /** 휴대폰에서 고른 파일을 서버에 올린다 (name, base64) → 서버 경로 */
  upload: "web-shell:upload",
} as const;

export interface DirEntry {
  name: string;
  path: string;
  dir: boolean;
}

export interface DirListing {
  path: string;
  parent?: string;
  entries: DirEntry[];
}

/** 웹 서버의 경로 */
export const WebPaths = {
  socket: "/ws",
  /** 토큰이 맞는지만 확인한다 (200 또는 401) */
  auth: "/api/auth",
} as const;

/** 인자 배열을 보낼 모양으로 바꾼다 */
export function packArgs(args: unknown[]): { args: unknown[]; u?: number[] } {
  const u: number[] = [];
  args.forEach((value, index) => {
    if (value === undefined) u.push(index);
  });
  return u.length > 0 ? { args, u } : { args };
}

/** 받은 인자 배열을 되살린다 */
export function unpackArgs(args: unknown[], u: number[] | undefined): unknown[] {
  if (!u || u.length === 0) return args;
  const result = [...args];
  for (const index of u) if (Number.isInteger(index) && index >= 0 && index < result.length) result[index] = undefined;
  return result;
}

const isArgs = (v: unknown): v is unknown[] => Array.isArray(v);
const isIndexes = (v: unknown): v is number[] | undefined => v === undefined || (Array.isArray(v) && v.every((i) => typeof i === "number"));
const isSeq = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** 브라우저가 보낸 글을 읽는다. 모양이 틀리면 undefined */
export function parseClientMessage(text: string): ClientMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const m = value as Record<string, unknown>;
  if (m.t === "ack") return isSeq(m.s) ? { t: "ack", s: m.s } : undefined;
  if (!isSeq(m.n) || m.n === 0) return undefined;
  if (m.t === "answer") return isSeq(m.id) ? { t: "answer", n: m.n, id: m.id, ...("value" in m ? { value: m.value } : {}) } : undefined;
  if (typeof m.ch !== "string" || !isArgs(m.args) || !isIndexes(m.u)) return undefined;
  const u = m.u as number[] | undefined;
  if (m.t === "invoke" && isSeq(m.id)) return { t: "invoke", n: m.n, id: m.id, ch: m.ch, args: m.args, ...(u ? { u } : {}) };
  if (m.t === "send") return { t: "send", n: m.n, ch: m.ch, args: m.args, ...(u ? { u } : {}) };
  return undefined;
}
