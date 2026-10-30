import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { app, appReady, configureShell, emitApp, hub, onQuit } from "@pi-desktop/web-shell/electron-main";
import { startWebServer } from "@pi-desktop/web-shell/server";
import { IpcChannels } from "../../mate/src/shared/api";

/**
 * Pi Desktop Mate 웹 버전의 서버 (설계 DESIGN.md §5.11). Mate의 main 코드(apps/mate/src/main)를 고치지 않고 Node에서 돌린다.
 * "electron"은 web-shell의 대체 모듈로, 자동 업데이트·로그인 항목은 웹 대체로 바뀌어 묶인다 (scripts/build.mjs).
 *
 * 실행기(mate-runner)는 Mate 설치본처럼 따로 떠서 서버를 꺼도 임무 시간표를 지키고 텔레그램에 연결한다.
 * 묶음 구조: server.mjs 옆에 public/(화면), resources/(mate-runner·mate-kit·pi-isolation: Mate 설치본의 extraResources와 같다)
 */

const here = dirname(fileURLToPath(import.meta.url));

const { values: flags } = parseArgs({
  options: {
    port: { type: "string" },
    host: { type: "string" },
    home: { type: "string" },
  },
});

const port = Number(flags.port ?? process.env.PI_WEB_PORT ?? 8789);
const host = flags.host ?? process.env.PI_WEB_HOST ?? "127.0.0.1";
/** 웹 서버의 데이터(토큰·호스트 선택·SSH 호스트·텔레그램 토큰 암호화 키·올린 파일). Mate 홈(~/.pi-desktop-mate)과는 다르다 */
const dataDir = flags.home ?? process.env.PI_WEB_DATA ?? join(homedir(), ".pi-web", "mate");
const publicDir = process.env.PI_WEB_PUBLIC ?? join(here, "public");

function version(): string {
  try {
    return String(JSON.parse(readFileSync(join(here, "package.json"), "utf8")).version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}

configureShell({ name: "Pi Desktop Mate", version: version(), dataDir, appPath: here, packaged: true });
// 설치본처럼 번들 파일(mate-runner, mate-kit, pi-isolation)을 resources에서 찾게 한다
(process as unknown as { resourcesPath: string }).resourcesPath = process.env.PI_WEB_RESOURCES ?? join(here, "resources");

// Mate main: ipcMain 처리기를 걸고, app.whenReady 뒤에 실행기에 붙는다 (없으면 띄운다)
await import("../../mate/src/main/index");

/**
 * Pi 설치·로그인은 Pi Desktop이 맡는다. 휴대폰에서는 같은 묶음의 Pi Web(pi-web, 8787)이 그 자리다.
 * "Pi Desktop 열기·설치"를 누르면 Pi Web 주소를 새 탭으로 연다.
 */
function piWebUrl(): string | undefined {
  try {
    return readFileSync(join(process.env.PI_WEB_HOME ?? join(homedir(), ".pi-web"), "data", "url"), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function openPiWeb(): void {
  const url = piWebUrl();
  if (!url) throw new Error("Pi Web이 꺼져 있습니다. Termux에서 pi-web을 실행한 뒤 다시 누르세요");
  hub.controlOne({ kind: "open", url });
}

appReady();
await app.whenReady();
hub.override(IpcChannels.openPiDesktop, () => {
  openPiWeb();
  return true;
});
hub.override(IpcChannels.installPiDesktop, () => {
  openPiWeb();
  return { status: "opened" };
});
// Pi 준비 안내에 "Pi Desktop 열기"가 보이도록, Pi Web이 켜져 있으면 그 주소를 Pi Desktop 자리에 둔다
const readiness = hub.handler(IpcChannels.piReadiness);
if (readiness) {
  hub.override(IpcChannels.piReadiness, async (event, ...args) => {
    const view = (await readiness(event, ...args)) as Record<string, unknown>;
    return piWebUrl() ? { ...view, piDesktopPath: "Pi Web" } : view;
  });
}

const server = await startWebServer({ app: "Pi Desktop Mate", version: version(), port, host, dataDir, publicDir }).catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});

console.log(`Pi Mate Web ${version()}`);
console.log(`브라우저로 여세요: ${server.url}`);

// 서버를 꺼도 실행기는 남아 임무를 돌린다. 연결기만 정리한다 (Mate의 will-quit과 같다)
function shutdown(): void {
  emitApp("before-quit");
  emitApp("will-quit");
  server.close();
  process.exit(0);
}
onQuit(shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
