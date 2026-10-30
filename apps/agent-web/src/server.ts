import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { app, appReady, configureShell, emitApp, hub, onQuit } from "@pi-desktop/web-shell/electron-main";
import { startWebServer } from "@pi-desktop/web-shell/server";
import { IpcChannels } from "../../agent/src/shared/api";

/**
 * Pi Desktop Agent 웹 버전의 서버 (설계 DESIGN.md §5.11). Agent의 main 코드(apps/agent/src/main)를 고치지 않고 Node에서 돌린다.
 * "electron"은 web-shell의 대체 모듈로 바뀌어 묶인다 (scripts/build.mjs).
 *
 * 묶음 구조: server.mjs 옆에 public/(화면), resources/(host-agent·agent-kit·pi-isolation: Agent 설치본의 extraResources와 같다)
 */

const here = dirname(fileURLToPath(import.meta.url));

const { values: flags } = parseArgs({
  options: {
    port: { type: "string" },
    host: { type: "string" },
    home: { type: "string" },
  },
});

const port = Number(flags.port ?? process.env.PI_WEB_PORT ?? 8788);
const host = flags.host ?? process.env.PI_WEB_HOST ?? "127.0.0.1";
/** 웹 서버의 데이터(토큰·호스트 선택·SSH 호스트·올린 파일). Agent의 앱 홈(~/.pi-desktop-agent)과는 다르다 */
const dataDir = flags.home ?? process.env.PI_WEB_DATA ?? join(homedir(), ".pi-web", "agent");
const publicDir = process.env.PI_WEB_PUBLIC ?? join(here, "public");

function version(): string {
  try {
    return String(JSON.parse(readFileSync(join(here, "package.json"), "utf8")).version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}

configureShell({ name: "Pi Desktop Agent", version: version(), dataDir, appPath: here, packaged: true });
// 설치본처럼 번들 파일(host-agent, agent-kit, pi-isolation)을 resources에서 찾게 한다
(process as unknown as { resourcesPath: string }).resourcesPath = process.env.PI_WEB_RESOURCES ?? join(here, "resources");

// Agent main: ipcMain 처리기를 걸고, app.whenReady 뒤에 데몬에 붙는다
await import("../../agent/src/main/index");

/**
 * Pi 관리·로그인은 Pi Desktop이 맡는다. 휴대폰에서는 같은 묶음의 Pi Web(pi-web, 8787)이 그 자리다.
 * "Pi Desktop 열기·설치"를 누르면 Pi Web 주소를 새 탭으로 연다.
 */
function piWebUrl(): string | undefined {
  try {
    return readFileSync(join(process.env.PI_WEB_HOME ?? join(homedir(), ".pi-web"), "data", "url"), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function openPiWeb(): { status: string } {
  const url = piWebUrl();
  if (!url) throw new Error("Pi Web이 꺼져 있습니다. Termux에서 pi-web을 실행한 뒤 다시 누르세요");
  hub.controlOne({ kind: "open", url });
  return { status: "opened" };
}

appReady();
await app.whenReady();
hub.override(IpcChannels.openPiDesktop, () => Boolean(openPiWeb()));
hub.override(IpcChannels.installPiDesktop, () => openPiWeb());
// Pi 상태 안내에 "Pi Desktop 열기"가 보이도록, Pi Web이 켜져 있으면 그 주소를 Pi Desktop 자리에 둔다
const piSetup = hub.handler(IpcChannels.piSetup);
if (piSetup) {
  hub.override(IpcChannels.piSetup, async (event, ...args) => {
    const view = (await piSetup(event, ...args)) as Record<string, unknown>;
    return piWebUrl() ? { ...view, piDesktopPath: "Pi Web" } : view;
  });
}

const server = await startWebServer({ app: "Pi Desktop Agent", version: version(), port, host, dataDir, publicDir }).catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});

console.log(`Pi Agent Web ${version()}`);
console.log(`브라우저로 여세요: ${server.url}`);

// 서버를 꺼도 데몬과 Pi 세션(예약 작업 포함)은 계속 돈다. 연결기만 정리한다 (Agent의 will-quit과 같다)
function shutdown(): void {
  emitApp("before-quit");
  emitApp("will-quit");
  server.close();
  process.exit(0);
}
onQuit(shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
