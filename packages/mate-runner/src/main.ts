// Mate 실행기 진입점. 사용법: node mate-runner.mjs <start|daemon|stop|run <임무 id>>
//
// - start: 실행기가 없거나 번들이 바뀌었으면(도는 실행이 없을 때) 새로 띄운다. 앱이 켜질 때 부른다.
// - daemon: 상주 실행기 본체 (start가 분리된 프로세스로 띄움)
// - status: Pi 준비 상태(설치·버전·로그인한 프로바이더·쓸 수 있는 모델·Pi 기본 모델)를 JSON으로
// - run: 임무 하나를 지금 이 프로세스에서 실행하고 기록을 출력한다 (확인·테스트용)
// - mcp-check: Mate 홈 mcp.json의 서버에 연결해 보고 결과를 JSON으로 ({ ok, output })
// - connect: 실행기가 없거나 번들이 바뀌었으면 띄우고, 표준 입출력을 실행기 소켓(JSON-RPC)에 잇는다. 앱이 붙는 길이다
//   (설계 DESIGN-MATE-REMOTE.md §2.1, Host Agent의 connect와 같은 방식)
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { locatePi } from "../../host-agent/src/pi-locator";
import { spawnDaemon } from "../../host-agent/src/spawn-daemon";
import { runConnect } from "../../host-agent/src/connect";
import { mateAppApi } from "./app-api";
import { RunnerServer, socketEnv } from "./rpc-server";
import { acquirePid, fileHash, isAlive, killRunner, log, readPid, releasePid, Runner, runDuty, type RunnerOptions } from "./daemon";
import type { PiLaunch } from "./executor";
import { mateHome, matePaths } from "./paths";
import { piReadiness } from "./pi-readiness";
import { getDuty, loadState } from "./store";

const script = fileURLToPath(import.meta.url);
const paths = matePaths(mateHome());

function kitDir(): string {
  return process.env.PI_DESKTOP_MATE_KIT || resolve(dirname(script), "../../mate-kit");
}

async function findPi(): Promise<PiLaunch> {
  const found = await locatePi();
  return { cliPath: found.cliPath, ...(found.nodePath ? { nodePath: found.nodePath } : {}), ...(found.env ? { env: found.env } : {}) };
}

async function options(): Promise<RunnerOptions> {
  return { paths, kitDir: kitDir(), locatePi: findPi, build: await fileHash(script) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => Promise<boolean>, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await check()) return true;
  return false;
}

/** 실행기가 없으면 띄우고, 번들이 바뀌었고 도는 실행이 없으면 새 실행기로 바꾼다 (Host Agent의 데몬 교체와 같은 이유) */
async function ensureStarted(): Promise<{ status: "running" | "started" | "failed"; pid: number | undefined; replaced?: boolean }> {
  const pid = await readPid(paths);
  if (isAlive(pid)) {
    const state = await loadState(paths);
    const build = await fileHash(script);
    if (state.build === build || state.current) return { status: "running", pid, replaced: false };
    await log(paths, `runner replace pid=${pid} build=${state.build}→${build}`);
    await killRunner(paths, pid!);
  }
  await spawnDaemon(script, process.env);
  const started = await waitFor(async () => isAlive(await readPid(paths)), 10_000);
  return { status: started ? "started" : "failed", pid: await readPid(paths) };
}

async function start(): Promise<void> {
  const result = await ensureStarted();
  console.log(JSON.stringify(result));
  if (result.status === "failed") process.exitCode = 1;
}

/** 앱이 붙는 길. 표준 출력은 JSON-RPC 통로라 다른 글을 쓰지 않는다 */
async function connect(): Promise<void> {
  const result = await ensureStarted();
  if (result.status === "failed") throw new Error("실행기를 띄우지 못했습니다. run/mated.log를 확인하세요");
  await runConnect({ env: socketEnv(paths), agentScript: script });
}

async function daemon(): Promise<void> {
  if (!(await acquirePid(paths))) return;
  const runner = new Runner(await options());
  // 앱이 붙는 JSON-RPC 서버 (DESIGN-MATE-REMOTE.md §2). 화면이 쓰는 함수는 app-api에 있다
  const server = new RunnerServer(
    paths,
    mateAppApi({
      paths,
      runnerView: async () => {
        const state = await loadState(paths);
        return {
          alive: true,
          pid: process.pid,
          ...(state.heartbeatAt ? { heartbeatAt: state.heartbeatAt } : {}),
          ...(state.current ? { current: state.current } : {}),
          today: state.today,
          phone: runner.phoneActive,
        };
      },
      wake: () => void runner.tick(),
      locatePi: findPi,
      shutdown: () => void shutdown(),
      setTelegramToken: (token) => runner.setTelegramToken(token),
    }),
    (message) => void log(paths, message),
  );
  async function shutdown(): Promise<void> {
    server.close();
    await runner.stop();
    await releasePid(paths);
    process.exit(0);
  }
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  process.on("uncaughtException", (error) => void log(paths, `uncaught ${error.stack ?? error}`));
  await runner.start();
  if (!(await server.listen())) await log(paths, "rpc listen skipped: 다른 실행기가 소켓을 쓰고 있다");
}

async function stop(): Promise<void> {
  const pid = await readPid(paths);
  if (isAlive(pid)) await killRunner(paths, pid!);
  console.log(JSON.stringify({ status: "stopped", pid }));
}

async function runOnce(id: string | undefined): Promise<void> {
  const duty = id ? await getDuty(paths, id) : undefined;
  if (!duty) throw new Error(`임무를 찾지 못했습니다: ${id ?? "(없음)"}`);
  console.log(JSON.stringify(await runDuty(await options(), duty, { reason: "manual" }), null, 2));
}

const [command, arg] = process.argv.slice(2);
async function status(): Promise<void> {
  console.log(JSON.stringify(await piReadiness()));
}

/**
 * MCP 연결 확인 (Mate의 MCP 탭 "연결 확인"). pi mcp list는 Pi 설정 폴더의 mcp.json만 읽으므로
 * 이 실행에서만 설정 폴더를 Mate 홈으로 바꾼다 (Agent의 연결 확인과 같은 방식). OAuth 서버는 로그인 안 됨으로 보일 수 있다.
 */
async function mcpCheck(): Promise<void> {
  const pi = await findPi();
  await mkdir(paths.home, { recursive: true });
  const result = await new Promise<{ ok: boolean; output: string }>((resolve) => {
    execFile(
      pi.nodePath ?? process.execPath,
      [pi.cliPath, "mcp", "list"],
      { cwd: paths.home, env: { ...process.env, ...pi.env, PI_CODING_AGENT_DIR: paths.home }, timeout: 120_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ ok: !error, output: `${stdout}${stderr ? `\n${stderr}` : ""}` }),
    );
  });
  console.log(JSON.stringify(result));
}

const commands: Record<string, () => Promise<void>> = { start, daemon, stop, status, connect, "mcp-check": mcpCheck, run: () => runOnce(arg) };
const handler = command ? commands[command] : undefined;
if (!handler) {
  console.error("사용법: mate-runner <start|daemon|stop|status|connect|mcp-check|run <임무 id>>");
  process.exitCode = 2;
} else {
  handler().catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
