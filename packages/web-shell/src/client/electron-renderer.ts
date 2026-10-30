import type { ResumableTransport } from "./transport";

/**
 * Electron preload API의 웹 대체 모듈 (설계 DESIGN.md §5.11).
 *
 * 화면을 묶을 때 앱의 preload(src/preload/index.ts)가 가져오는 "electron"을 이 파일로 바꾼다.
 * 그래서 preload를 고치지 않고 그대로 불러 window.<이름>에 같은 API를 둔다.
 * boot.ts가 preload를 불러오기 전에 useTransport로 서버 연결을 건다.
 */

let transport: ResumableTransport | undefined;

export function useTransport(next: ResumableTransport): void {
  transport = next;
}

function link(): ResumableTransport {
  if (!transport) throw new Error("웹 서버에 아직 연결하지 않았습니다");
  return transport;
}

/** Electron의 IpcRendererEvent 자리 (preload는 첫 인자를 버린다) */
const rendererEvent = { sender: undefined, senderId: 0, ports: [] };

type Listener = (event: typeof rendererEvent, ...args: any[]) => void;
const offs = new Map<Listener, Map<string, () => void>>();

export const ipcRenderer = {
  invoke: (channel: string, ...args: unknown[]): Promise<any> => link().invoke(channel, ...args),
  send: (channel: string, ...args: unknown[]): void => link().send(channel, ...args),
  on(channel: string, listener: Listener) {
    const off = link().on(channel, (...args) => listener(rendererEvent, ...args));
    let byChannel = offs.get(listener);
    if (!byChannel) offs.set(listener, (byChannel = new Map()));
    byChannel.get(channel)?.();
    byChannel.set(channel, off);
    return ipcRenderer;
  },
  once(channel: string, listener: Listener) {
    const off = link().on(channel, (...args) => {
      off();
      listener(rendererEvent, ...args);
    });
    return ipcRenderer;
  },
  removeListener(channel: string, listener: Listener) {
    offs.get(listener)?.get(channel)?.();
    offs.get(listener)?.delete(channel);
    return ipcRenderer;
  },
  removeAllListeners(channel: string) {
    for (const byChannel of offs.values()) {
      byChannel.get(channel)?.();
      byChannel.delete(channel);
    }
    return ipcRenderer;
  },
};

export const contextBridge = {
  exposeInMainWorld(key: string, api: unknown): void {
    (window as unknown as Record<string, unknown>)[key] = api;
  },
};

export const webUtils = {
  getPathForFile: () => "",
};

export default { ipcRenderer, contextBridge, webUtils };
