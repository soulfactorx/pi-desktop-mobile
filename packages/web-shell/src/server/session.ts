import { parseClientMessage, type ClientData, type ServerData, type ServerMessage } from "../protocol";

/** WebSocket 연결에서 쓰는 부분 (ws 패키지의 WebSocket이 이 모양이다) */
export interface SessionSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: unknown) => void): unknown;
  once(event: "close", listener: () => void): unknown;
}

const OPEN = 1;
/** 이만큼 받으면 ack를 바로 보낸다. 아니면 ACK_DELAY_MS 뒤에 */
const ACK_EVERY = 64;
const ACK_DELAY_MS = 1000;

export interface SessionLimits {
  /** 보냈지만 브라우저가 받았다고 하지 않은 메시지를 이만큼(바이트)까지 가지고 있는다. 넘으면 세션을 버린다 */
  maxBufferBytes: number;
}

/**
 * 브라우저 탭 하나와의 이어지는 연결 (protocol.ts). WebSocket이 끊겼다 다시 붙어도 같은 세션이 이어진다.
 * Electron의 WebContents 자리를 맡는다.
 */
export class ClientSession {
  /** 서버가 보낸 마지막 순번 */
  private sent = 0;
  /** 브라우저가 받았다고 하지 않은 메시지 */
  private unacked: Array<{ s: number; text: string }> = [];
  private unackedBytes = 0;
  /** 처리한 브라우저 메시지의 마지막 순번 */
  private processed = 0;
  /** 받았지만 아직 ack하지 않은 수 */
  private toAck = 0;
  private ackTimer: ReturnType<typeof setTimeout> | undefined;
  private socket: SessionSocket | undefined;
  /** 끊긴 시각 (붙어 있으면 undefined) */
  disconnectedAt: number | undefined = Date.now();
  /** 버퍼가 넘쳐 이어 갈 수 없게 되었다 */
  dead = false;
  /** 마지막으로 브라우저에서 메시지를 받은 시각 (열기·대화상자를 보낼 탭을 고를 때) */
  lastActive = 0;

  constructor(
    readonly id: string,
    private readonly onData: (session: ClientSession, data: ClientData) => void,
    private readonly limits: SessionLimits,
  ) {}

  get connected(): boolean {
    return this.socket !== undefined;
  }

  /** 브라우저가 lastReceived까지 받았다고 할 때, 그 뒤를 다시 보내 이어 갈 수 있는가 */
  canResume(lastReceived: number): boolean {
    if (this.dead || lastReceived > this.sent) return false;
    const first = this.unacked[0]?.s ?? this.sent + 1;
    return lastReceived + 1 >= first;
  }

  /** 새 WebSocket을 붙인다. resumed면 lastReceived 뒤의 것을 다시 보낸다 */
  attach(socket: SessionSocket, hello: Omit<Extract<ServerMessage, { t: "hello" }>, "c">, lastReceived: number): void {
    this.socket?.close(4000, "다른 연결로 바뀌었습니다");
    this.socket = socket;
    this.disconnectedAt = undefined;
    this.lastActive = Date.now();
    this.ack(lastReceived);
    socket.on("message", (data) => this.receive(String(data)));
    socket.once("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.disconnectedAt = Date.now();
      if (this.ackTimer) clearTimeout(this.ackTimer);
      this.ackTimer = undefined;
    });
    this.raw({ ...hello, c: this.processed });
    for (const { text } of this.unacked) this.rawText(text);
  }

  /** 순번을 붙여 보낸다. 끊겨 있으면 다시 붙을 때 보낸다 */
  send(data: DistributiveOmit<ServerData, "s">): void {
    if (this.dead) return;
    const s = ++this.sent;
    const text = JSON.stringify({ ...data, s });
    this.unacked.push({ s, text });
    this.unackedBytes += text.length;
    if (this.unackedBytes > this.limits.maxBufferBytes) {
      // 브라우저가 너무 오래 받지 않았다. 다시 붙으면 화면을 새로 읽게 한다
      this.kill();
      return;
    }
    this.rawText(text);
  }

  /** 세션을 끝낸다. 붙어 있으면 연결도 닫는다 */
  kill(): void {
    this.dead = true;
    this.unacked = [];
    this.unackedBytes = 0;
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(4001, "세션이 끝났습니다");
  }

  private receive(text: string): void {
    const message = parseClientMessage(text);
    if (!message) return;
    if (message.t === "ack") {
      this.ack(message.s);
      return;
    }
    // 다시 붙을 때 브라우저가 이미 처리한 것을 또 보낼 수 있다
    if (message.n <= this.processed) return;
    this.processed = message.n;
    this.lastActive = Date.now();
    this.scheduleAck();
    this.onData(this, message);
  }

  private ack(lastReceived: number): void {
    let dropped = 0;
    while (this.unacked.length > 0 && this.unacked[0]!.s <= lastReceived) dropped += this.unacked.shift()!.text.length;
    this.unackedBytes -= dropped;
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
    this.raw({ t: "ack", c: this.processed });
  }

  private raw(message: ServerMessage): void {
    this.rawText(JSON.stringify(message));
  }

  private rawText(text: string): void {
    if (this.socket?.readyState === OPEN) this.socket.send(text);
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** client id → 세션. 끊긴 지 오래된 세션은 버린다 */
export class SessionTable {
  private readonly sessions = new Map<string, ClientSession>();

  constructor(
    private readonly onData: (session: ClientSession, data: ClientData) => void,
    private readonly limits: SessionLimits,
    private readonly expireMs: number,
  ) {}

  /** 이 client id로 이어 갈 세션. 이어 갈 수 없으면 새로 만든다 (resumed: false) */
  open(clientId: string, lastReceived: number): { session: ClientSession; resumed: boolean } {
    this.sweep();
    const existing = this.sessions.get(clientId);
    if (existing && existing.canResume(lastReceived)) return { session: existing, resumed: true };
    existing?.kill();
    const session = new ClientSession(clientId, this.onData, this.limits);
    this.sessions.set(clientId, session);
    return { session, resumed: false };
  }

  /** 살아 있는 세션 (끊겨 있어도 이어 갈 수 있는 것) */
  live(): ClientSession[] {
    this.sweep();
    return [...this.sessions.values()];
  }

  /** 끊긴 지 expireMs가 지났거나 죽은 세션을 버린다 */
  sweep(now = Date.now()): void {
    for (const [id, session] of this.sessions) {
      if (session.dead || (session.disconnectedAt !== undefined && now - session.disconnectedAt > this.expireMs)) {
        session.kill();
        this.sessions.delete(id);
      }
    }
  }
}
