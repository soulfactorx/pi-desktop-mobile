import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  createJsonlReader,
  encodeJsonl,
  JsonRpcPeer,
  Methods,
  Notifications,
  type DaemonStatus,
  type HostInfo,
  type SessionEventNotification,
  type SessionExitNotification,
  type SessionExternalWriteNotification,
  type SessionWriterChangedNotification,
  type FilesChangedNotification,
  type PlaygroundOutputNotification,
  type SessionUiResolvedNotification,
  type StoredChangedNotification,
  type PiUpdateOutputNotification,
} from "@pi-desktop/host-protocol";
import type { ConnectionState } from "../shared/api";
import { checkAgent, staleAgentError } from "./agent-build";
import { MAX_AUTO_RETRIES, PREPARE_TIMEOUT_MS, REQUEST_WAIT_MS, retryDelay } from "./reconnect-policy";

/** 연결기(`host-agent connect`)를 띄우는 명령. 호스트 종류(로컬·WSL·SSH)마다 다르다. */
export interface LaunchSpec {
  command: string;
  args: string[];
  /** 앱 프로세스 환경에 덧붙일 변수 */
  env?: Record<string, string>;
  /** 연결기가 실행할 번들의 빌드 식별자 (agent-build.ts). 떠 있는 데몬과 비교한다 */
  agentBuild?: string;
}

export interface HostConnectionOptions {
  /**
   * 연결을 시도할 때마다 호출된다. 여기서 Agent 배포·버전 확인 같은 준비를 하고 실행 명령을 돌려준다.
   * 예외를 던지면 그 메시지를 연결 끊김 사유로 보여주고 나중에 다시 시도한다.
   */
  prepare: () => Promise<LaunchSpec>;
  onState: (state: ConnectionState) => void;
  onSessionEvent: (notification: SessionEventNotification) => void;
  onSessionExit: (notification: SessionExitNotification) => void;
  onUiResolved: (notification: SessionUiResolvedNotification) => void;
  onStoredChanged: (notification: StoredChangedNotification) => void;
  onExternalWrite: (notification: SessionExternalWriteNotification) => void;
  onWriterChanged: (notification: SessionWriterChangedNotification) => void;
  onFilesChanged: (notification: FilesChangedNotification) => void;
  onPlaygroundOutput: (notification: PlaygroundOutputNotification) => void;
  onPiUpdateOutput: (notification: PiUpdateOutputNotification) => void;
}

/** 예전 데몬을 쓰는 동안 세션이 모두 끝났는지 다시 보는 간격 */
const STALE_CHECK_MS = 30_000;

/**
 * 호스트 하나의 Host Agent 연결 (설계 §3.2).
 *
 * 연결기를 자식 프로세스로 띄워 stdio로 JSON-RPC를 주고받는다. 로컬이면 node를 직접,
 * WSL이면 wsl.exe를 거쳐 띄운다. 연결기는 앱과 함께 죽지만 데몬과 Pi 세션은 남는다.
 * 연결기가 끊기면 점점 길게 기다리며 다시 붙고, 연달아 여러 번 실패하면 멈춰 사용자에게 "다시 연결"을 맡긴다
 * (reconnect-policy.ts). 연결되지 않은 동안의 요청은 잠시만 기다리고, 멈춘 뒤에는 이유와 함께 바로 실패한다.
 */
/** 신원을 확인하지 못한 데몬에 끄기를 요청하고 기다리는 시간 */
const UNVERIFIED_SHUTDOWN_MS = 5000;

export class HostConnection {
  private child: ChildProcessWithoutNullStreams | undefined;
  private peer: JsonRpcPeer | undefined;
  private state: ConnectionState = { status: "connecting" };
  /** 연달아 실패한 횟수 (연결되면 0) */
  private failures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private started = false;
  /** 연결을 기다리는 요청들. 연결되면 resolve, 다시 붙기를 멈추면 reject */
  private readyWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  /** 예전 데몬을 끄는 중. 연결기가 끝나도 오류로 알리지 않고 바로 다시 붙는다 */
  private replacing = false;
  /** 교체를 시도한 번들의 빌드 식별자 (되풀이 방지) */
  private replaceTriedFor: string | undefined;
  private staleTimer: ReturnType<typeof setInterval> | undefined;
  /**
   * 신원을 확인하지 못한 데몬(Windows의 인증 없는 예전 데몬)을 끄려고 이미 한 번 시도했는지.
   * 끈 뒤에도 또 확인되지 않으면 다른 프로그램이 파이프 이름을 차지한 것일 수 있어 연결하지 않는다.
   */
  private unverifiedShutdownTried = false;
  /** 연결하지 않기로 한 이유 (신원 확인 실패). 다시 붙을 때까지 연결 상태에 보인다 */
  private blockedReason: string | undefined;

  constructor(private readonly options: HostConnectionOptions) {}

  /** 처음 한 번만 연결을 시작한다. 이미 시작했으면 아무것도 하지 않는다. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.connect();
  }

  get current(): ConnectionState {
    return this.state;
  }

  /**
   * 연결될 때까지 기다린 뒤 요청한다. 연결을 기다리는 것은 REQUEST_WAIT_MS까지이고,
   * 다시 붙기를 멈춘 상태면 기다리지 않고 바로 실패한다(화면의 주기적 요청이 끝없이 쌓이지 않게).
   * @param timeoutMs 응답 제한 시간. 생략하면 기본값(2분), 0이면 제한 없음
   */
  async request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    this.start();
    if (this.state.status !== "connected" || !this.peer) await this.waitForConnection();
    try {
      return await this.peer!.request<T>(method, params, timeoutMs);
    } catch (error) {
      // 예전 데몬(업데이트 대기)이 새 기능 요청을 거절했으면 원인과 고치는 방법을 알려 준다.
      const hinted = this.state.status === "connected" && this.state.agentUpdate ? staleAgentError(error) : undefined;
      throw hinted ?? error;
    }
  }

  private waitForConnection(): Promise<void> {
    const state = this.state;
    if (state.status === "disconnected" && state.gaveUp) {
      return Promise.reject(new Error(`Host Agent에 연결되어 있지 않습니다: ${state.reason}`));
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((w) => w !== waiter);
        const now = this.state;
        reject(new Error(`Host Agent 연결을 기다리다 시간이 지났습니다${now.status === "disconnected" ? `: ${now.reason}` : ""}`));
      }, REQUEST_WAIT_MS);
      this.readyWaiters.push(waiter);
    });
  }

  /** 사용자가 "다시 연결"을 눌렀다: 실패 횟수를 비우고 곧바로 다시 붙는다 */
  reconnect(): void {
    if (this.disposed || this.state.status === "connected" || this.state.status === "connecting") return;
    this.failures = 0;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.started = true;
    void this.connect();
  }

  /** 앱 종료 시 호출. 연결기만 끝내고 데몬·세션은 그대로 둔다 (설계 §3.4). */
  dispose(): void {
    this.disposed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.stopStaleCheck();
    this.child?.kill();
  }

  /**
   * 예전 데몬을 지금 끄고 새 번들로 다시 띄운다 ("업데이트 대기"에서 사용자가 고른 경우).
   * 실행 중인 Pi 세션도 함께 끝난다. 앱은 다시 붙은 뒤 "다시 열기"로 세션 파일에서 이어 간다.
   */
  async replaceAgent(): Promise<void> {
    const peer = this.peer;
    if (this.state.status !== "connected" || !peer) throw new Error("연결되어 있지 않습니다");
    this.replacing = true;
    await peer.request(Methods.daemonShutdown).catch(() => {});
  }

  private async connect(): Promise<void> {
    if (this.disposed) return;
    this.setState({ status: "connecting" });

    let spec: LaunchSpec;
    try {
      spec = await withTimeout(
        this.options.prepare(),
        PREPARE_TIMEOUT_MS,
        `연결 준비가 ${PREPARE_TIMEOUT_MS / 1000}초 안에 끝나지 않았습니다. 서버가 응답하는지 확인하세요.`,
      );
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
      return;
    }
    if (this.disposed) return;

    const child = spawn(spec.command, spec.args, {
      env: { ...process.env, ...spec.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;

    const peer = new JsonRpcPeer({
      send: (message) => child.stdin.write(encodeJsonl(message)),
      defaultTimeoutMs: 120_000,
    });
    this.peer = peer;
    // 연결기가 데몬의 신원을 확인하지 못했다고 알리면(handshake.ts), 이 연결로는 끄기 요청 말고는 보내지 않는다.
    // 가짜 데몬은 응답하지 않을 수 있으므로 host.info 응답을 기다리지 않고 곧바로 처리한다.
    let unverified = false;
    peer.on(Notifications.connectorUnverified, () => {
      unverified = true;
      void this.handleUnverified(peer, child);
    });
    peer.on(Notifications.sessionEvent, (p) => this.options.onSessionEvent(p as SessionEventNotification));
    peer.on(Notifications.sessionExit, (p) => this.options.onSessionExit(p as SessionExitNotification));
    peer.on(Notifications.sessionUiResolved, (p) => this.options.onUiResolved(p as SessionUiResolvedNotification));
    peer.on(Notifications.storedChanged, (p) => this.options.onStoredChanged(p as StoredChangedNotification));
    peer.on(Notifications.sessionExternalWrite, (p) => this.options.onExternalWrite(p as SessionExternalWriteNotification));
    peer.on(Notifications.sessionWriterChanged, (p) => this.options.onWriterChanged(p as SessionWriterChangedNotification));
    peer.on(Notifications.filesChanged, (p) => this.options.onFilesChanged(p as FilesChangedNotification));
    peer.on(Notifications.playgroundOutput, (p) => this.options.onPlaygroundOutput(p as PlaygroundOutputNotification));
    peer.on(Notifications.piUpdateOutput, (p) => this.options.onPiUpdateOutput(p as PiUpdateOutputNotification));

    // stdout에 프로토콜이 아닌 줄(예: 셸 안내 문구)이 섞여도 무시하고 계속 읽는다.
    const reader = createJsonlReader((record) => peer.receive(record));
    child.stdout.on("data", (chunk: Buffer) => reader.push(chunk));
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString("utf8")).slice(-4000)));
    child.stdin.on("error", () => {});
    child.on("error", (error) => (stderr += `\n${error.message}`));
    child.on("exit", (code) => {
      peer.close("Host Agent 연결이 끊겼습니다");
      if (this.child === child) this.child = undefined;
      this.stopStaleCheck();
      if (this.disposed) return;
      if (this.replacing) {
        // 예전 데몬을 일부러 껐다. 연결기가 새 번들로 데몬을 띄우도록 곧바로 다시 붙는다.
        this.replacing = false;
        this.failures = 0;
        this.setState({ status: "connecting" });
        this.retryTimer = setTimeout(() => void this.connect(), 500);
        return;
      }
      const reason = this.blockedReason ?? (lastLines(stderr) || `연결기 종료 (code ${code})`);
      this.blockedReason = undefined;
      this.fail(reason);
    });

    peer
      .request<HostInfo>(Methods.hostInfo, undefined, 60_000)
      .then(async (host) => {
        if (unverified) return;
        this.unverifiedShutdownTried = false;
        const agentUpdate = await this.checkAgent(peer, spec.agentBuild, host);
        if (agentUpdate === "replacing") return;
        this.failures = 0;
        this.setState({ status: "connected", host, ...(agentUpdate ? { agentUpdate } : {}) });
        if (agentUpdate) this.startStaleCheck(peer, spec.agentBuild);
        const waiters = this.readyWaiters;
        this.readyWaiters = [];
        for (const waiter of waiters) waiter.resolve();
      })
      .catch(() => child.kill());
  }

  /**
   * 신원을 확인하지 못한 데몬: 인증을 모르는 예전 데몬이면 끄고 새 번들로 다시 띄운다(실행 중인 세션도 끝난다).
   * 이미 한 번 껐는데도 또 그렇다면, 다른 사용자의 프로그램이 같은 이름의 파이프를 쓰고 있을 수 있으므로 연결하지 않는다.
   */
  private async handleUnverified(peer: JsonRpcPeer, child: ChildProcessWithoutNullStreams): Promise<void> {
    if (this.unverifiedShutdownTried) {
      this.blockedReason =
        "Host Agent 데몬의 신원을 확인할 수 없어 연결하지 않았습니다. 다른 사용자나 프로그램이 같은 이름의 파이프를 쓰고 있을 수 있습니다. PC를 다시 시작한 뒤 다시 열어 보세요.";
      child.kill();
      return;
    }
    this.unverifiedShutdownTried = true;
    this.replacing = true;
    await peer.request(Methods.daemonShutdown, undefined, UNVERIFIED_SHUTDOWN_MS).catch(() => {});
    // 예전 데몬이면 꺼지면서 연결기도 끝난다. 응답이 없으면 직접 끊고 다시 붙는다.
    if (this.child === child) child.kill();
  }

  /**
   * 떠 있는 데몬이 앱의 번들과 같은지 본다 (설계 §3.4).
   * 예전 데몬이면 실행 중인 세션이 없을 때 끄고("replacing", 연결기 종료 뒤 다시 붙으면서 새 번들로 뜬다),
   * 세션이 있으면 그대로 쓰면서 업데이트 대기를 알린다.
   */
  private async checkAgent(
    peer: JsonRpcPeer,
    expected: string | undefined,
    host: HostInfo,
  ): Promise<"replacing" | { liveSessions: number } | undefined> {
    if (!expected || host.agentBuild === expected) return undefined;
    const status = await peer.request<DaemonStatus>(Methods.daemonStatus);
    const liveSessions = status.sessions.filter((s) => s.state === "running").length;
    const check = checkAgent(expected, host.agentBuild, liveSessions, this.replaceTriedFor === expected);
    if (check === "replace") {
      this.replaceTriedFor = expected;
      this.replacing = true;
      await peer.request(Methods.daemonShutdown).catch(() => {});
      return "replacing";
    }
    return check === "stale" ? { liveSessions } : undefined;
  }

  /** 업데이트 대기 중: 세션이 모두 끝나면 예전 데몬을 바꾼다. */
  private startStaleCheck(peer: JsonRpcPeer, expected: string | undefined): void {
    this.stopStaleCheck();
    this.staleTimer = setInterval(() => {
      void peer
        .request<DaemonStatus>(Methods.daemonStatus)
        .then((status) => {
          if (this.peer !== peer || status.sessions.some((s) => s.state === "running")) return;
          // 이미 한 번 바꿨는데도 같은 데몬이 떠 있으면(교체 실패) 되풀이하지 않는다.
          if (this.replaceTriedFor === expected) return;
          this.replaceTriedFor = expected;
          this.replacing = true;
          return peer.request(Methods.daemonShutdown);
        })
        .catch(() => {});
    }, STALE_CHECK_MS);
  }

  private stopStaleCheck(): void {
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.staleTimer = undefined;
  }

  /**
   * 연결 시도가 실패했다: 정책에 따라 잠시 뒤 다시 붙거나, 연달아 실패했으면 멈춘다.
   * 멈추면 연결을 기다리던 요청도 이유와 함께 끝낸다.
   */
  private fail(reason: string): void {
    if (this.disposed) return;
    this.failures += 1;
    const delay = retryDelay(this.failures);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (delay === undefined) {
      this.setState({ status: "disconnected", reason, failures: this.failures, maxRetries: MAX_AUTO_RETRIES, gaveUp: true });
      const waiters = this.readyWaiters;
      this.readyWaiters = [];
      for (const waiter of waiters) waiter.reject(new Error(`Host Agent에 연결하지 못했습니다: ${reason}`));
      return;
    }
    this.setState({ status: "disconnected", reason, retryAt: Date.now() + delay, failures: this.failures, maxRetries: MAX_AUTO_RETRIES });
    this.retryTimer = setTimeout(() => void this.connect(), delay);
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    this.options.onState(state);
  }
}

/** 약속이 시간 안에 끝나지 않으면 message로 실패한다 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** 오류 표시용으로 stderr 마지막 몇 줄만 남긴다. WSL의 경로 변환 경고처럼 의미 없는 줄은 뺀다. */
function lastLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.includes("Failed to translate"))
    .slice(-5)
    .join("\n");
}
