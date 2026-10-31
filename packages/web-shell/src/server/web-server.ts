import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { WebSocketServer } from "ws";
import { clickMenu, clickNotification, hub, onBackgroundNotify } from "../electron/main";
import { CLICK_OPEN, SERVICE_WORKER_PATH, ShellChannels, WebPaths, type DirEntry, type DirListing } from "../protocol";
import { PushCenter } from "./push";
import { SERVICE_WORKER_SOURCE } from "./service-worker";
import { bearerToken, isLoopbackAddress, loadOrCreateToken, requestAllowed, tokenMatches } from "./auth";
import { serveStatic } from "./static-files";

export { hub };
export { bearerToken, isLoopbackAddress, loadOrCreateToken, requestAllowed, tokenMatches } from "./auth";

export interface WebServerOptions {
  /** 화면에 보일 이름 (hello) */
  app: string;
  version: string;
  port: number;
  host: string;
  /** 토큰·주소 파일·올린 파일을 두는 곳 */
  dataDir: string;
  /** 화면 파일 (vite 결과) */
  publicDir: string;
}

/** 휴대폰에서 올린 파일 하나의 크기 한도 (base64 전) */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * 웹 껍데기의 서버 (설계 DESIGN.md §5.11): 화면 파일을 내주고, 토큰을 확인한 WebSocket을 IpcHub의 세션에 잇는다.
 * 앱 main 코드는 electron 대체 모듈(electron/main.ts)로 hub에 처리기를 건다.
 * 서버가 뜨면 토큰이 든 주소를 dataDir/url에 쓴다 (실행 명령이 읽어 보여 준다).
 */
export function startWebServer(options: WebServerOptions): Promise<{ server: Server; url: string; close: () => void }> {
  const token = loadOrCreateToken(join(options.dataDir, "token"));
  const loopbackOnly = isLoopbackAddress(options.host);
  const allowed = (req: IncomingMessage) => requestAllowed({ host: req.headers.host, origin: req.headers.origin }, loopbackOnly);
  registerShellHandlers(options.dataDir);
  const push = new PushCenter(options.dataDir);
  registerPush(push, options.app);

  const server = createServer((req, res) => {
    if (!allowed(req)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("허용하지 않는 주소입니다");
      return;
    }
    if (req.url?.split("?")[0] === SERVICE_WORKER_PATH) {
      // 서비스 워커는 사이트 전체(/)를 맡는다. 바뀌면 바로 새것을 쓰도록 캐시하지 않는다
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache", "Service-Worker-Allowed": "/" });
      res.end(SERVICE_WORKER_SOURCE);
      return;
    }
    if (req.url?.split("?")[0] === WebPaths.auth) {
      const ok = tokenMatches(token, bearerToken(req.headers.authorization));
      res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(ok ? { ok: true, app: options.app, version: options.version } : { ok: false }));
      return;
    }
    void serveStatic(options.publicDir, req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });

  // 이미지·파일 올리기가 base64로 한 메시지에 담기므로 넉넉히 받는다
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 100 * 1024 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const clientId = url.searchParams.get("client") ?? "";
    const last = Number(url.searchParams.get("last") ?? "0");
    if (
      url.pathname !== WebPaths.socket ||
      !allowed(req) ||
      !tokenMatches(token, url.searchParams.get("token")) ||
      !/^[\w-]{8,64}$/.test(clientId) ||
      !Number.isInteger(last) ||
      last < 0
    ) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      let alive = true;
      ws.on("pong", () => (alive = true));
      // 휴대폰 브라우저가 백그라운드로 가면 연결이 말없이 끊긴다. 응답 없는 연결은 정리한다 (세션은 남는다)
      const timer = setInterval(() => {
        if (!alive) return void ws.terminate();
        alive = false;
        ws.ping();
      }, 30_000);
      ws.once("close", () => clearInterval(timer));
      const { session, resumed } = hub.sessions.open(clientId, last);
      session.attach(ws, { t: "hello", resumed, app: options.app, version: options.version }, last);
      hub.attached(session, resumed);
    });
  });

  return new Promise((resolvePromise, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) =>
      reject(error.code === "EADDRINUSE" ? new Error(`포트 ${options.port}를 이미 쓰고 있습니다. --port로 다른 포트를 고르세요.`) : error),
    );
    server.listen(options.port, options.host, () => {
      const shown = options.host === "0.0.0.0" || options.host === "::" ? "127.0.0.1" : options.host.includes(":") ? `[${options.host}]` : options.host;
      const url = `http://${shown}:${options.port}/#token=${token}`;
      writeFileSync(join(options.dataDir, "url"), `${url}\n`, { mode: 0o600 });
      const sweeper = setInterval(() => hub.sessions.sweep(), 60_000);
      sweeper.unref();
      resolvePromise({
        server,
        url,
        close: () => {
          clearInterval(sweeper);
          sockets.close();
          server.close();
        },
      });
    });
  });
}

/**
 * 웹 푸시: 브라우저가 알림을 허용하면 구독을 받아 두고, 보는 탭이 없을 때 앱의 알림(Notification)을 휴대폰 알림으로 보낸다.
 * 알림 제목 앞에 앱 이름을 붙인다 (Pi Web·Agent·Mate가 같은 휴대폰에서 알림을 보내므로).
 */
function registerPush(push: PushCenter, app: string): void {
  hub.override(ShellChannels.pushKey, () => push.publicKey());
  hub.override(ShellChannels.pushSubscribe, (_event, subscription: unknown) => {
    push.subscribe(subscription as Parameters<PushCenter["subscribe"]>[0]);
    return push.count;
  });
  hub.override(ShellChannels.pushUnsubscribe, (_event, endpoint: string) => push.unsubscribe(String(endpoint)));
  onBackgroundNotify((note) => {
    void push
      .send({ title: note.title ? `${app} · ${note.title}` : app, ...(note.body ? { body: note.body } : {}), ...(note.clickId ? { open: `${CLICK_OPEN}${note.clickId}` } : {}) })
      .catch(() => 0);
  });
  hub.override(ShellChannels.notificationClick, (_event, id: string) => clickNotification(String(id)));
}

/** 웹 껍데기가 직접 처리하는 채널: 메뉴 누르기, 대화상자의 폴더 훑기, 휴대폰 파일 올리기 */
function registerShellHandlers(dataDir: string): void {
  hub.override(ShellChannels.menuClick, (_event, id: string) => clickMenu(String(id)));
  hub.override(ShellChannels.listDir, (_event, path?: string) => listDir(path));
  hub.override(ShellChannels.upload, async (_event, name: string, base64: string) => {
    const data = Buffer.from(String(base64), "base64");
    if (data.length > MAX_UPLOAD_BYTES) throw new Error(`${(data.length / 1024 / 1024).toFixed(1)}MB라 너무 큽니다 (50MB까지)`);
    const dir = join(dataDir, "uploads", new Date().toISOString().slice(0, 10));
    await mkdir(dir, { recursive: true });
    // 이름은 경로 조각을 빼고 쓴다. 같은 이름이 있으면 앞에 시각을 붙인다
    const safe = basename(String(name)).replace(/[\\/:*?"<>|\0]/g, "_") || "file";
    let target = join(dir, safe);
    if (await stat(target).catch(() => undefined)) target = join(dir, `${Date.now()}-${safe}`);
    await writeFile(target, data, { mode: 0o600 });
    return target;
  });
}

/** 서버의 폴더 내용 (숨긴 파일 포함, 폴더 먼저). 경로가 없으면 홈 */
export async function listDir(path?: string): Promise<DirListing> {
  const dir = resolve(path && path.trim() ? path.replace(/^~(?=$|\/)/, homedir()) : homedir());
  const names = await readdir(dir, { withFileTypes: true });
  const entries: DirEntry[] = [];
  for (const entry of names) {
    let isDir = entry.isDirectory();
    if (entry.isSymbolicLink()) isDir = (await stat(join(dir, entry.name)).catch(() => undefined))?.isDirectory() ?? false;
    entries.push({ name: entry.name, path: join(dir, entry.name), dir: isDir });
  }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  const parent = dirname(dir);
  return { path: dir, ...(parent !== dir ? { parent } : {}), entries };
}
