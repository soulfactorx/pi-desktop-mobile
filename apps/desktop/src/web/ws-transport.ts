import { IpcChannels, type ConnectionState } from "../shared/api";
import type { ApiTransport } from "../shared/api-client";
import { packArgs, unpackArgs, type ClientMessage, type ServerMessage } from "../shared/web-protocol";

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;

export type LinkStatus = "connecting" | "open" | "closed";

/**
 * 웹 서버(pi-web)와 WebSocket으로 주고받는 ApiTransport (설계 §5.10).
 *
 * 휴대폰 브라우저는 탭이 백그라운드로 가면 연결을 끊는다. 그래서
 * - 끊기면 지수 백오프로 다시 붙고, 화면이 다시 보이면 바로 붙는다
 * - 끊긴 동안 보낸 메시지는 모아 두었다가 다시 붙으면 보낸다. 기다리던 응답은 실패로 끝낸다(서버가 받았는지 모른다)
 * - 다시 붙으면 화면이 연결했던 호스트마다 connectionChanged를 다시 알린다. 화면은 "connected"를 받으면
 *   보던 세션에 마지막 순번부터 다시 붙으므로(use-session.ts) 끊긴 동안의 이벤트를 잃지 않는다
 */
export class WsTransport implements ApiTransport {
  private socket: WebSocket | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private outbox: string[] = [];
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  /** 화면이 connectHost로 연결한 호스트 */
  private readonly hosts = new Set<string>();
  private retryDelay = RECONNECT_MIN_MS;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private everOpened = false;

  constructor(
    private readonly url: string,
    private readonly onStatus: (status: LinkStatus) => void = () => {},
  ) {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && !this.socket) this.reconnectNow();
    });
    window.addEventListener("online", () => {
      if (!this.socket) this.reconnectNow();
    });
  }

  connect(): void {
    this.onStatus("connecting");
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.onopen = () => {
      this.retryDelay = RECONNECT_MIN_MS;
      this.onStatus("open");
      const queued = this.outbox;
      this.outbox = [];
      for (const text of queued) socket.send(text);
      if (this.everOpened) this.resync();
      this.everOpened = true;
    };
    socket.onmessage = (event) => this.receive(String(event.data));
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.onStatus("closed");
      for (const { reject } of this.pending.values()) reject(new Error("서버와 연결이 끊겼습니다. 다시 붙으면 다시 시도하세요."));
      this.pending.clear();
      const lost: ConnectionState = { status: "disconnected", reason: "웹 서버(pi-web)와 연결이 끊겼습니다. 다시 붙는 중…" };
      for (const hostId of this.hosts) this.emit(IpcChannels.connectionChanged, hostId, lost);
      this.retryTimer = setTimeout(() => this.connect(), this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, RECONNECT_MAX_MS);
    };
  }

  invoke(channel: string, ...args: unknown[]): Promise<any> {
    if (channel === IpcChannels.connectHost && typeof args[0] === "string") this.hosts.add(args[0]);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ t: "invoke", id, ch: channel, ...packArgs(args) });
    });
  }

  send(channel: string, ...args: unknown[]): void {
    this.write({ t: "send", ch: channel, ...packArgs(args) });
  }

  on(channel: string, listener: (...args: unknown[]) => void): () => void {
    let set = this.listeners.get(channel);
    if (!set) this.listeners.set(channel, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  private write(message: ClientMessage): void {
    const text = JSON.stringify(message);
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(text);
    else this.outbox.push(text);
  }

  private receive(text: string): void {
    let message: ServerMessage;
    try {
      message = JSON.parse(text) as ServerMessage;
    } catch {
      return;
    }
    if (message.t === "event") {
      this.emit(message.ch, ...unpackArgs(message.args, message.u));
      return;
    }
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    if (message.ok) waiter.resolve(message.value);
    else waiter.reject(new Error(message.error));
  }

  private emit(channel: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(channel) ?? []) {
      try {
        listener(...args);
      } catch (error) {
        console.error(error);
      }
    }
  }

  private resync(): void {
    for (const hostId of this.hosts) {
      void this.invoke(IpcChannels.connectHost, hostId).then(
        (state: ConnectionState) => this.emit(IpcChannels.connectionChanged, hostId, state),
        () => {},
      );
    }
  }

  private reconnectNow(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.retryDelay = RECONNECT_MIN_MS;
    this.connect();
  }
}
