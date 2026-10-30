import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createJsonlReader, encodeJsonl, JsonRpcPeer } from "@pi-desktop/host-protocol";

/**
 * 앱 ↔ 실행기 연결 (설계 DESIGN-MATE-REMOTE.md §2). `mate-runner connect`를 띄워 표준 입출력으로 JSON-RPC를 주고받는다.
 * connect가 실행기가 없으면 띄우고, 번들이 바뀌었으면 바꾼다. 연결이 끊기면(실행기를 다시 띄움 등) 잠시 뒤 다시 붙는다.
 * 실행기와 임무는 연결과 상관없이 돈다.
 */

export interface LaunchSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export type RunnerConnectionState = { status: "connecting" } | { status: "connected" } | { status: "disconnected"; reason: string };

export interface RunnerConnectionOptions {
  /** 연결할 때마다 부른다 (토큰 등 환경을 그때 읽는다) */
  launch: () => Promise<LaunchSpec>;
  onChanged: () => void;
  onState?: (state: RunnerConnectionState) => void;
  /** 요청 하나를 기다리는 시간 (ms) */
  requestTimeoutMs?: number;
}

const RETRY_MS = [500, 1000, 2000, 5000, 10_000];

export class RunnerConnection {
  private child: ChildProcessWithoutNullStreams | undefined;
  private peer: JsonRpcPeer | undefined;
  private failures = 0;
  private retry: NodeJS.Timeout | undefined;
  private disposed = false;
  private readyWaiters: Array<() => void> = [];
  private stderr = "";
  state: RunnerConnectionState = { status: "connecting" };

  constructor(private readonly options: RunnerConnectionOptions) {}

  start(): void {
    void this.connect();
  }

  /** 연결을 끝낸다 (앱 종료·호스트 바꾸기). 끝난 뒤에는 상태 알림을 보내지 않는다 (창이 이미 없을 수 있다) */
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.retry);
    const child = this.child;
    this.child = undefined;
    this.peer = undefined;
    child?.kill();
  }

  /** 실행기의 app-api 함수를 부른다. 붙는 중이면 붙을 때까지 기다린다 */
  async call<T = unknown>(name: string, ...args: unknown[]): Promise<T> {
    const peer = await this.ready();
    return peer.request<T>("mate.call", { name, args }, this.options.requestTimeoutMs ?? 120_000);
  }

  private ready(timeoutMs = 20_000): Promise<JsonRpcPeer> {
    if (this.peer && this.state.status === "connected") return Promise.resolve(this.peer);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((w) => w !== onReady);
        reject(new Error(this.state.status === "disconnected" ? `실행기에 연결되지 않았습니다: ${this.state.reason}` : "실행기에 연결하는 중입니다. 잠시 뒤 다시 해 보세요"));
      }, timeoutMs);
      const onReady = () => {
        clearTimeout(timer);
        resolve(this.peer!);
      };
      this.readyWaiters.push(onReady);
    });
  }

  private setState(state: RunnerConnectionState): void {
    this.state = state;
    this.options.onState?.(state);
  }

  private async connect(): Promise<void> {
    if (this.disposed) return;
    this.setState({ status: "connecting" });
    let spec: LaunchSpec;
    try {
      spec = await this.options.launch();
    } catch (error) {
      this.lost(error instanceof Error ? error.message : String(error));
      return;
    }
    const child = spawn(spec.command, spec.args, { env: spec.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    this.stderr = "";
    const peer = new JsonRpcPeer({ send: (message) => child.stdin.write(encodeJsonl(message)), defaultTimeoutMs: 60_000 });
    const reader = createJsonlReader((record) => peer.receive(record));
    child.stdout.on("data", (chunk: Buffer) => reader.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => (this.stderr = (this.stderr + chunk.toString("utf8")).slice(-2000)));
    child.stdin.on("error", () => {});
    peer.on("mate.changed", () => this.options.onChanged());
    child.on("error", (error) => this.lost(error.message));
    child.on("exit", () => {
      peer.close("실행기 연결이 끊겼습니다");
      if (this.child === child) this.lost(this.stderr.trim().split("\n").at(-1) || "실행기 연결이 끊겼습니다");
    });
    // 첫 요청이 오가면 붙은 것으로 본다 (connect가 실행기를 띄우는 동안은 기다린다)
    try {
      await peer.request("mate.call", { name: "config", args: [] }, 30_000);
    } catch (error) {
      if (this.child === child) {
        child.kill();
        this.lost(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (this.child !== child) return;
    this.peer = peer;
    this.failures = 0;
    this.setState({ status: "connected" });
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const waiter of waiters) waiter();
    this.options.onChanged();
  }

  private lost(reason: string): void {
    if (this.disposed) return;
    if (this.state.status === "disconnected" && !this.child) return;
    this.child = undefined;
    this.peer = undefined;
    this.setState({ status: "disconnected", reason });
    if (this.disposed) return;
    const delay = RETRY_MS[Math.min(this.failures, RETRY_MS.length - 1)]!;
    this.failures += 1;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.connect(), delay);
  }
}
