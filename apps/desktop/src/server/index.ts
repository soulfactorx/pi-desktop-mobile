import { createServer, type IncomingMessage } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import type { SessionEventNotification } from "@pi-desktop/host-protocol";
import { IpcChannels, type UpdateState } from "../shared/api";
import { WebPaths } from "../shared/web-protocol";
import { ActionLog } from "../main/action-log";
import { agentVersion } from "../main/agent-build";
import { CopyStore } from "../main/copies";
import { HostManager } from "../main/host-manager";
import { ImportStore } from "../main/imports";
import { hostEventHandlers, registerHandlers } from "../main/ipc-handlers";
import { ReplayCollector } from "../main/replay-collector";
import { SshHostStore } from "../main/ssh-hosts";
import { TerminalService } from "../main/terminal";
import { bearerToken, isLoopbackAddress, loadOrCreateToken, requestAllowed, tokenMatches } from "./auth";
import { serveStatic } from "./static-files";
import { WebRouter } from "./web-router";

/**
 * 웹 서버 pi-web (설계 §5.10). 데스크톱 앱의 main 프로세스 자리를 Node 서버가 맡고, 화면은 브라우저로 연다.
 * Android 휴대폰에서는 Termux에서 이 서버와 Pi를 돌리고 휴대폰 브라우저로 http://127.0.0.1:<포트>를 연다.
 *
 * 묶음(release) 구조: server.mjs 옆에 public/(화면), host-agent/host-agent.mjs, package.json
 */

const here = dirname(fileURLToPath(import.meta.url));

const { values: flags } = parseArgs({
  options: {
    port: { type: "string" },
    host: { type: "string" },
    home: { type: "string" },
  },
});

const port = Number(flags.port ?? process.env.PI_WEB_PORT ?? 8787);
const listenHost = flags.host ?? process.env.PI_WEB_HOST ?? "127.0.0.1";
/** 데이터(토큰·SSH 호스트·작업 기록) 위치. 설치 스크립트는 ~/.pi-web/data를 쓴다 */
const dataDir = flags.home ?? process.env.PI_WEB_DATA ?? join(homedir(), ".pi-web", "data");
const publicDir = process.env.PI_WEB_PUBLIC ?? join(here, "public");
const agentScript = process.env.PI_DESKTOP_AGENT_SCRIPT ?? join(here, "host-agent", "host-agent.mjs");
const loopbackOnly = isLoopbackAddress(listenHost);

function appVersion(): string {
  try {
    return String(JSON.parse(readFileSync(join(here, "package.json"), "utf8")).version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}
const version = appVersion();

const token = loadOrCreateToken(join(dataDir, "token"));
const router = new WebRouter();
const replays = new ReplayCollector<SessionEventNotification>();
const sshHosts = new SshHostStore(join(dataDir, "ssh-hosts.json"));
const hosts = new HostManager({
  agentScript,
  agentVersion: agentVersion(agentScript),
  sshHosts,
  ...hostEventHandlers((channel, ...payload) => router.broadcast(channel, ...payload), replays),
});
const terminals = new TerminalService({ data: IpcChannels.terminalData, exit: IpcChannels.terminalExit });

registerHandlers(router, {
  manager: hosts,
  sshHosts,
  imports: new ImportStore(join(dataDir, "imports.json")),
  copies: new CopyStore(join(dataDir, "copies.json")),
  actionLog: new ActionLog(join(dataDir, "activity-log.jsonl")),
  terminals,
  replays,
  // 브라우저는 서버의 OS 대화상자를 띄울 수 없다. 화면은 대신 폴더 탐색 창을 쓴다 (shell === "web")
  pickDirectory: async () => undefined,
  revealPath: () => false,
});

// 앱 자동 업데이트는 데스크톱 앱 것이다. 웹 묶음은 `pi-web update`(설치 스크립트)로 바꾼다.
const noUpdates: UpdateState = { status: "disabled", current: version, mode: "notify" };
router.handle(IpcChannels.updateState, () => noUpdates);
router.handle(IpcChannels.checkForUpdates, () => noUpdates);
router.handle(IpcChannels.confirmUpdate, () => undefined);
router.handle(IpcChannels.installUpdate, () => undefined);
router.handle(IpcChannels.openRelease, () => undefined);

const allowed = (req: IncomingMessage) => requestAllowed({ host: req.headers.host, origin: req.headers.origin }, loopbackOnly);

const server = createServer((req, res) => {
  if (!allowed(req)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("허용하지 않는 주소입니다");
    return;
  }
  if (req.url?.split("?")[0] === WebPaths.auth) {
    const ok = tokenMatches(token, bearerToken(req.headers.authorization));
    res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(ok ? { ok: true, version } : { ok: false }));
    return;
  }
  void serveStatic(publicDir, req, res).catch(() => {
    if (!res.headersSent) res.writeHead(500).end();
  });
});

// 이미지 첨부(한 장 20MB, 열 장까지)가 base64로 한 메시지에 담길 수 있어 넉넉히 받는다.
const sockets = new WebSocketServer({ noServer: true, maxPayload: 300 * 1024 * 1024 });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== WebPaths.socket || !allowed(req) || !tokenMatches(token, url.searchParams.get("token"))) {
    socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    return;
  }
  sockets.handleUpgrade(req, socket, head, (ws) => {
    let alive = true;
    ws.on("pong", () => (alive = true));
    // 휴대폰 브라우저가 백그라운드로 가면 연결이 말없이 끊긴다. 응답 없는 연결은 정리한다.
    const timer = setInterval(() => {
      if (!alive) return void ws.terminate();
      alive = false;
      ws.ping();
    }, 30_000);
    ws.once("close", () => clearInterval(timer));
    router.attach(ws);
  });
});

server.on("error", (error: NodeJS.ErrnoException) => {
  console.error(error.code === "EADDRINUSE" ? `포트 ${port}를 이미 쓰고 있습니다. --port로 다른 포트를 고르세요.` : error.message);
  process.exit(1);
});

server.listen(port, listenHost, () => {
  const shown = listenHost === "0.0.0.0" || listenHost === "::" ? "127.0.0.1" : listenHost.includes(":") ? `[${listenHost}]` : listenHost;
  const url = `http://${shown}:${port}/#token=${token}`;
  // pi-web url이 이 파일을 읽어 보여 준다
  writeFileSync(join(dataDir, "url"), `${url}\n`, { mode: 0o600 });
  console.log(`Pi Web ${version}`);
  console.log(`브라우저로 여세요: ${url}`);
  if (!loopbackOnly) console.log(`주의: ${listenHost}에 열었습니다. 같은 네트워크의 다른 기기도 접속할 수 있으니 토큰을 남에게 보이지 마세요.`);
});

// 서버를 꺼도 각 호스트의 데몬과 Pi 세션은 계속 돈다. 연결기와 터미널만 정리한다 (설계 §3.4).
function shutdown(): void {
  terminals.dispose();
  hosts.dispose();
  sockets.close();
  server.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
