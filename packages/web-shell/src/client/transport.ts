import { packArgs, unpackArgs, type ClientData, type Control, type ServerMessage } from "../protocol";

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;
const ACK_EVERY = 64;
const ACK_DELAY_MS = 1000;
/** 화면이 듣기 전에 온 이벤트를 맡겨 두는 시간과 개수 */
const EARLY_KEEP_MS = 30_000;
const EARLY_MAX = 20;

export type LinkStatus = "connecting" | "open" | "closed";

export interface TransportHooks {
  onStatus?: (status: LinkStatus) => void;
  /** 서버가 시키는 일 (메뉴, 대화상자, 알림 등) */
  onControl?: (control: Control) => void;
  /** 서버의 세션이 없어졌다 (서버를 다시 켰거나 너무 오래 끊겼다). 화면을 새로 읽어야 한다 */
  onReset?: () => void;
}

/** WebSocket 하나에서 쓰는 부분 (테스트에서 바꿔 끼운다) */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

const OPEN = 1;

/**
 * 웹 서버와 이어지는 연결 (protocol.ts). ipcRenderer의 invoke·send·on을 제공한다.
 *
 * - 끊기면 지수 백오프로 다시 붙고, 화면이 다시 보이면 바로 붙는다
 * - 보낸 메시지는 서버가 받았다고 할 때까지 가지고 있다가, 다시 붙으면 서버가 못 받은 것만 다시 보낸다.
 *   기다리던 응답도 서버가 다시 보내 주므로 끊겼다고 실패로 끝내지 않는다
 * - 서버가 세션을 잃었으면(onReset) 기다리던 요청을 실패로 끝내고 화면을 새로 읽게 한다
 */
export class ResumableTransport {
  private socket: SocketLike | undefined;
  private nextSeq = 1;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  /** 서버가 받았다고 하지 않은 메시지 */
  private unacked: Array<{ n: number; text: string }> = [];
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  /** 듣는 쪽이 생기기 전에 온 이벤트 (화면이 뜨는 동안 잠시) */
  private early: Array<{ channel: string; args: unknown[]; at: number }> = [];
  /** 받은 서버 메시지의 마지막 순번 */
  private received = 0;
  private toAck = 0;
  private ackTimer: ReturnType<typeof setTimeout> | undefined;
  private hadSession = false;
  /** 지금 소켓이 hello를 받아 보낼 수 있다 (그 전에 보내면 다시 보내는 것보다 앞서 순서가 바뀐다) */
  private live = false;
  private retryDelay = RECONNECT_MIN_MS;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(
    private readonly url: (lastReceived: number) => string,
    private readonly hooks: TransportHooks = {},
    private readonly createSocket: (url: string) => SocketLike = (url) => new WebSocket(url) as unknown as SocketLike,
  ) {}

  /** 화면이 다시 보이거나 네트워크가 돌아오면 기다리지 않고 바로 붙는다 */
  watchPage(): void {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && !this.socket) this.reconnectNow();
    });
    window.addEventListener("online", () => {
      if (!this.socket) this.reconnectNow();
    });
  }

  connect(): void {
    if (this.stopped) return;
    this.hooks.onStatus?.("connecting");
    const socket = this.createSocket(this.url(this.received));
    this.socket = socket;
    this.live = false;
    socket.onmessage = (event) => this.receive(socket, String(event.data));
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.live = false;
      if (this.ackTimer) clearTimeout(this.ackTimer);
      this.ackTimer = undefined;
      this.hooks.onStatus?.("closed");
      if (this.stopped) return;
      this.retryTimer = setTimeout(() => this.connect(), this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, RECONNECT_MAX_MS);
    };
  }

  /** 다시 붙지 않고 끝낸다 */
  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.socket?.close();
  }

  invoke(channel: string, ...args: unknown[]): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ t: "invoke", id, ch: channel, ...packArgs(args) });
    });
  }

  send(channel: string, ...args: unknown[]): void {
    this.write({ t: "send", ch: channel, ...packArgs(args) });
  }

  /** 서버가 물은 것(대화상자)에 답한다 */
  answer(id: number, value: unknown): void {
    this.write({ t: "answer", id, ...(value === undefined ? {} : { value }) });
  }

  on(channel: string, listener: (...args: unknown[]) => void): () => void {
    let set = this.listeners.get(channel);
    if (!set) this.listeners.set(channel, (set = new Set()));
    set.add(listener);
    // 화면이 듣기 전에 온 이벤트를 넘긴다 (예: 휴대폰 알림을 눌러 새로 연 탭에 서버가 보낸 "그 대화 열기")
    const early = this.early.filter((e) => e.channel === channel && Date.now() - e.at < EARLY_KEEP_MS);
    if (early.length > 0) {
      this.early = this.early.filter((e) => e.channel !== channel);
      queueMicrotask(() => {
        for (const e of early) if (set.has(listener)) listener(...e.args);
      });
    }
    return () => set.delete(listener);
  }

  private write(data: DistributiveOmit<ClientData, "n">): void {
    const n = this.nextSeq++;
    const text = JSON.stringify({ ...data, n });
    this.unacked.push({ n, text });
    if (this.live && this.socket?.readyState === OPEN) this.socket.send(text);
  }

  private receive(socket: SocketLike, text: string): void {
    let message: ServerMessage;
    try {
      message = JSON.parse(text) as ServerMessage;
    } catch {
      return;
    }
    if (message.t === "hello") return this.hello(socket, message.resumed, message.c);
    if (message.t === "ack") return this.dropAcked(message.c);
    // 다시 붙을 때 서버가 이미 받은 것을 또 보낼 수 있다
    if (message.s <= this.received) return;
    this.received = message.s;
    this.scheduleAck();
    if (message.t === "event") this.emit(message.ch, ...unpackArgs(message.args, message.u));
    else if (message.t === "control") this.hooks.onControl?.(message.control);
    else {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.ok) waiter.resolve(message.value);
      else waiter.reject(new Error(message.error));
    }
  }

  private hello(socket: SocketLike, resumed: boolean, processed: number): void {
    if (!resumed && this.hadSession) {
      // 서버가 이 화면의 세션을 잃었다. 기다리던 것은 돌아오지 않는다
      for (const { reject } of this.pending.values()) reject(new Error("서버와의 세션이 끊겼습니다. 화면을 새로 읽습니다."));
      this.pending.clear();
      this.unacked = [];
      this.received = 0;
      this.hooks.onReset?.();
      return;
    }
    this.hadSession = true;
    this.retryDelay = RECONNECT_MIN_MS;
    this.dropAcked(processed);
    for (const { text } of this.unacked) socket.send(text);
    this.live = true;
    this.hooks.onStatus?.("open");
  }

  private dropAcked(processed: number): void {
    while (this.unacked.length > 0 && this.unacked[0]!.n <= processed) this.unacked.shift();
  }

  private scheduleAck(): void {
    this.toAck++;
    if (this.toAck >= ACK_EVERY) return this.flushAck();
    this.ackTimer ??= setTimeout(() => this.flushAck(), ACK_DELAY_MS);
  }

  private flushAck(): void {
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = undefined;
    this.toAck = 0;
    if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify({ t: "ack", s: this.received }));
  }

  private emit(channel: string, ...args: unknown[]): void {
    const listeners = this.listeners.get(channel);
    if (!listeners?.size) {
      // 아직 아무도 듣지 않는 채널: 화면이 뜨는 중일 수 있어 잠시 맡겨 둔다
      this.early = [...this.early.filter((e) => Date.now() - e.at < EARLY_KEEP_MS), { channel, args, at: Date.now() }].slice(-EARLY_MAX);
      return;
    }
    for (const listener of listeners) {
      try {
        listener(...args);
      } catch (error) {
        console.error(error);
      }
    }
  }

  private reconnectNow(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.retryDelay = RECONNECT_MIN_MS;
    this.connect();
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
