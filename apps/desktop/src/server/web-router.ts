import { EventEmitter } from "node:events";
import type { Peer, Router } from "../main/ipc-handlers";
import { packArgs, parseClientMessage, unpackArgs, type ServerMessage } from "../shared/web-protocol";

/** WebSocket 연결에서 쓰는 부분 (ws 패키지의 WebSocket이 이 모양이다) */
export interface PeerSocket {
  readonly readyState: number;
  send(data: string): void;
  on(event: "message", listener: (data: unknown) => void): unknown;
  once(event: "close", listener: () => void): unknown;
}

const OPEN = 1;
/** web-shell의 ShellChannels.visibility와 같다 (화면 쪽은 web-shell의 notify.ts를 쓴다) */
const VISIBILITY_CHANNEL = "web-shell:visibility";

/** 브라우저 탭 하나. Electron의 WebContents 자리를 맡는다 (터미널 출력은 그 탭에만 보낸다) */
export class WsPeer implements Peer {
  private destroyed = false;
  /** 브라우저가 알린 화면 보임 (보는 탭이 없으면 알림을 웹 푸시로 보낸다) */
  visible = false;
  private readonly events = new EventEmitter();

  constructor(private readonly socket: PeerSocket) {
    socket.once("close", () => {
      this.destroyed = true;
      this.visible = false;
      this.events.emit("destroyed");
    });
  }

  send(channel: string, ...args: unknown[]): void {
    this.write({ t: "event", ch: channel, ...packArgs(args) });
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  once(event: "destroyed", listener: () => void): this {
    this.events.once(event, listener);
    return this;
  }

  write(message: ServerMessage): void {
    if (this.destroyed || this.socket.readyState !== OPEN) return;
    this.socket.send(JSON.stringify(message));
  }
}

type Listener = (peer: Peer, ...args: any[]) => unknown;

/**
 * ipcMain 대신 WebSocket 메시지를 처리기(main/ipc-handlers.ts)로 나눠 준다.
 * 열린 탭이 여럿이면 알림은 모두에게 보낸다 (데스크톱 앱에서 창이 여럿인 것과 같다).
 */
export class WebRouter implements Router {
  private readonly handlers = new Map<string, Listener>();
  private readonly listeners = new Map<string, Listener>();
  private readonly peers = new Set<WsPeer>();

  handle(channel: string, listener: Listener): void {
    this.handlers.set(channel, listener);
  }

  on(channel: string, listener: Listener): void {
    this.listeners.set(channel, listener);
  }

  /** 새 연결을 받는다 */
  attach(socket: PeerSocket): WsPeer {
    const peer = new WsPeer(socket);
    this.peers.add(peer);
    socket.on("message", (data) => void this.dispatch(peer, String(data)));
    socket.once("close", () => this.peers.delete(peer));
    return peer;
  }

  broadcast(channel: string, ...args: unknown[]): void {
    for (const peer of this.peers) peer.send(channel, ...args);
  }

  get size(): number {
    return this.peers.size;
  }

  /** 이 앱을 보고 있는 탭이 있는가 */
  anyVisible(): boolean {
    return [...this.peers].some((p) => p.visible);
  }

  async dispatch(peer: WsPeer, text: string): Promise<void> {
    const message = parseClientMessage(text);
    if (!message) return;
    const args = unpackArgs(message.args, message.u);
    if (message.t === "send") {
      if (message.ch === VISIBILITY_CHANNEL) {
        peer.visible = args[0] === true;
        return;
      }
      try {
        this.listeners.get(message.ch)?.(peer, ...args);
      } catch {
        // 응답 없는 메시지(터미널 입력 등)의 오류는 돌려줄 곳이 없다
      }
      return;
    }
    const handler = this.handlers.get(message.ch);
    try {
      if (!handler) throw new Error(`알 수 없는 채널입니다: ${message.ch}`);
      const value = await handler(peer, ...args);
      peer.write({ t: "result", id: message.id, ok: true, ...(value === undefined ? {} : { value }) });
    } catch (error) {
      // Electron과 같은 문구로 돌려준다. 화면이 이 접두사를 떼어 보여 주는 곳이 있다 (folder-browser.ts)
      peer.write({ t: "result", id: message.id, ok: false, error: `Error invoking remote method '${message.ch}': ${String(error)}` });
    }
  }
}
