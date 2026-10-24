/**
 * 웹 서버(pi-web) ↔ 브라우저 사이의 WebSocket 메시지 (설계 §5.10).
 *
 * 채널 이름과 인자는 Electron IPC(shared/api.ts의 IpcChannels)와 같다. 메시지는 JSON 한 개씩 보낸다.
 * JSON은 배열 속 undefined를 null로 바꾸므로, undefined였던 인자의 자리를 u에 적어 되살린다
 * (null과 undefined가 다른 뜻인 인자가 있다: settingsWrite의 baseMtime, setTrust의 decision 등).
 */

/** 브라우저 → 서버 */
export type ClientMessage =
  /** 요청/응답 (ipcRenderer.invoke) */
  | { t: "invoke"; id: number; ch: string; args: unknown[]; u?: number[] }
  /** 응답 없는 메시지 (ipcRenderer.send) */
  | { t: "send"; ch: string; args: unknown[]; u?: number[] };

/** 서버 → 브라우저 */
export type ServerMessage =
  | { t: "result"; id: number; ok: true; value?: unknown }
  | { t: "result"; id: number; ok: false; error: string }
  /** 알림 (webContents.send) */
  | { t: "event"; ch: string; args: unknown[]; u?: number[] };

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
  if (typeof m.ch !== "string" || !isArgs(m.args) || !isIndexes(m.u)) return undefined;
  const u = m.u as number[] | undefined;
  if (m.t === "invoke" && typeof m.id === "number") return { t: "invoke", id: m.id, ch: m.ch, args: m.args, ...(u ? { u } : {}) };
  if (m.t === "send") return { t: "send", ch: m.ch, args: m.args, ...(u ? { u } : {}) };
  return undefined;
}
