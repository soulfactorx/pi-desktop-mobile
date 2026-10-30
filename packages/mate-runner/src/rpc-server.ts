import { chmodSync, mkdirSync, watch, type FSWatcher } from "node:fs";
import { unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { createJsonlReader, encodeJsonl, ErrorCodes, JsonRpcError, JsonRpcPeer } from "@pi-desktop/host-protocol";
import { createToken, serverHandshake, writeToken } from "../../host-agent/src/handshake";
import { runDir, socketPath } from "../../host-agent/src/paths";
import type { MateAppApi } from "./app-api";
import type { MatePaths } from "./paths";

/**
 * 실행기의 JSON-RPC 서버 (설계 DESIGN-MATE-REMOTE.md §2.1). 앱은 `mate-runner connect`로 이 소켓에 붙는다.
 *
 * 소켓 위치와 서로 확인(토큰)은 Host Agent의 코드를 고치지 않고 그대로 쓴다. 그 코드는 PI_DESKTOP_HOME으로 폴더를 정하므로
 * Mate 홈을 넣은 환경을 넘긴다: POSIX는 `<Mate 홈>/run/agentd.sock`(0700 폴더), Windows는 Mate 홈 해시로 지은 파이프.
 */

/** 앱에 보내는 알림: Mate 홈의 파일이 바뀌었다 (화면을 다시 읽는다) */
export const MATE_CHANGED = "mate.changed";
/** 앱이 부르는 메서드: app-api의 함수를 이름으로 */
export const MATE_CALL = "mate.call";

/** Host Agent의 소켓·토큰 코드가 Mate 홈을 쓰게 하는 환경 */
export function socketEnv(paths: MatePaths, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, PI_DESKTOP_HOME: paths.home };
}

/** 화면 갱신에서 빼는 파일: 실행 중 계속 바뀌는 Pi 세션·로그·대화 세션·할 일 */
export function ignoredChange(name: string): boolean {
  return /^(sessions|run|chat[\\/](sessions|actions))[\\/]/.test(name);
}

export class RunnerServer {
  private server: Server | undefined;
  private watcher: FSWatcher | undefined;
  private readonly clients = new Set<{ socket: Socket; peer: JsonRpcPeer }>();
  private changeTimer: NodeJS.Timeout | undefined;
  private tokenReady: Promise<string> = Promise.resolve("");

  constructor(
    private readonly paths: MatePaths,
    private readonly api: MateAppApi,
    private readonly log: (message: string) => void,
  ) {}

  /** 소켓을 열고 Mate 홈을 감시한다. 다른 실행기가 이미 듣고 있으면 false */
  async listen(): Promise<boolean> {
    const env = socketEnv(this.paths);
    const path = socketPath(env);
    mkdirSync(runDir(env), { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(runDir(env), 0o700);
    let tokenWritten: (token: string) => void = () => {};
    this.tokenReady = new Promise((resolve) => (tokenWritten = resolve));
    const server = createServer((socket) => this.accept(socket));
    let result = await tryListen(server, path);
    if (result === "in-use") {
      // 살아 있는 다른 실행기인지, 죽은 실행기가 남긴 소켓 파일인지 본다
      if (await isAlive(path)) return false;
      if (process.platform === "win32") return false;
      await unlink(path).catch(() => {});
      result = await tryListen(server, path);
      if (result !== "ok") return false;
    }
    this.server = server;
    const token = createToken();
    await writeToken(token, env);
    tokenWritten(token);
    this.watchHome();
    this.log(`rpc listen ${path}`);
    return true;
  }

  close(): void {
    this.watcher?.close();
    clearTimeout(this.changeTimer);
    for (const client of this.clients) {
      client.peer.close("실행기가 종료되었습니다");
      client.socket.destroy();
    }
    this.server?.close();
  }

  /** 붙은 앱 모두에 바뀌었다고 알린다. 잦은 변경은 200ms로 묶는다 */
  notifyChanged(): void {
    clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => {
      for (const client of this.clients) client.peer.notify(MATE_CHANGED, null);
    }, 200);
  }

  private watchHome(): void {
    try {
      this.watcher = watch(this.paths.home, { recursive: true }, (_event, name) => {
        if (name && ignoredChange(String(name))) return;
        this.notifyChanged();
      });
    } catch (error) {
      // 감시를 못 해도 앱은 주기적으로 다시 읽는다
      this.log(`watch error ${(error as Error).message}`);
    }
  }

  private accept(socket: Socket): void {
    socket.on("error", () => {});
    void this.tokenReady
      .then((token) => serverHandshake(socket, token, process.platform !== "win32"))
      .then(
        ({ rest }) => this.startClient(socket, rest),
        () => socket.destroy(),
      );
  }

  private startClient(socket: Socket, rest: Buffer): void {
    const peer = new JsonRpcPeer({ send: (message) => socket.write(encodeJsonl(message)) });
    const client = { socket, peer };
    this.clients.add(client);
    peer.handle(MATE_CALL, async (params): Promise<unknown> => {
      const p = params as { name?: unknown; args?: unknown } | undefined;
      if (!p || typeof p.name !== "string") throw new JsonRpcError(ErrorCodes.InvalidParams, "name이 필요합니다");
      const fn = Object.hasOwn(this.api, p.name) ? this.api[p.name] : undefined;
      if (!fn) throw new JsonRpcError(ErrorCodes.InvalidParams, `모르는 Mate 함수입니다: ${p.name}`);
      try {
        const result = await fn(...(Array.isArray(p.args) ? p.args : []));
        return result === undefined ? null : result;
      } catch (error) {
        throw new JsonRpcError(ErrorCodes.InvalidParams, error instanceof Error ? error.message : String(error));
      }
    });
    const reader = createJsonlReader((record) => peer.receive(record));
    if (rest.length > 0) reader.push(rest);
    socket.on("data", (chunk: Buffer) => reader.push(chunk));
    socket.on("close", () => {
      peer.close();
      this.clients.delete(client);
    });
    socket.resume();
  }
}

function tryListen(server: Server, path: string): Promise<"ok" | "in-use"> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      if (error.code === "EADDRINUSE") resolve("in-use");
      else reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve("ok");
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(path);
  });
}

function isAlive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}
