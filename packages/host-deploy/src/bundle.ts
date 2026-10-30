import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

/**
 * 다른 호스트(WSL 배포판, SSH 서버)에 실행할 번들(의존성 없는 .mjs 한 파일)을 올리는 공통 절차 (설계 DESIGN.md §3.2 "배포와 부트스트랩").
 * Pi Desktop의 apps/desktop/src/main/remote-agent.ts에서 가져와, 올릴 홈 폴더·하위 폴더·파일 이름 앞부분을 받게 했다
 * (Agent: ~/.pi-desktop-agent/agent/host-agent-…, Mate: ~/.pi-desktop-mate/runner/mate-runner-…).
 *
 * 그 호스트에서는 앱의 파일이 보이지 않을 수 있다(WSL automount 해제, 원격). 그래서 번들을 호스트 홈으로 복사해 두고 그 파일을 실행한다.
 * 파일 이름에 내용 해시를 넣어, 앱이 업데이트되면 새 파일을 올리고 같은 번들이면 다시 올리지 않는다.
 */

/** 번들 내용의 짧은 해시 (Host Agent의 agentBuildId와 같은 규칙) */
export function bundleBuildId(bundle: Buffer): string {
  return createHash("sha256").update(bundle).digest("hex").slice(0, 12);
}

/** Pi가 요구하는 최소 Node 주 버전 */
export const MIN_NODE_MAJOR = 22;

/** POSIX 셸용 작은따옴표 인용. 어떤 문자열이든 단일 인자로 전달된다. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface ProbeResult {
  home: string;
  /** 사용할 node 경로. 없으면 빈 문자열 */
  node: string;
  nodeVersion: string;
  /** 같은 해시의 번들이 이미 올라가 있는지 */
  agentPresent: boolean;
}

/** 원격 탐지 스크립트의 `key=value` 출력을 읽는다. 알 수 없는 줄(로그인 안내 등)은 무시한다. */
export function parseProbe(output: string): ProbeResult {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^pi-desktop-(\w+)=(.*)$/.exec(line.trim());
    if (match) values.set(match[1]!, match[2]!);
  }
  return {
    home: values.get("home") ?? "",
    node: values.get("node") ?? "",
    nodeVersion: values.get("nodeVersion") ?? "",
    agentPresent: values.get("agent") === "1",
  };
}

/** "v24.20.0" → 24. 읽을 수 없으면 0 */
export function nodeMajor(version: string): number {
  const match = /^v?(\d+)\./.exec(version.trim());
  return match ? Number(match[1]) : 0;
}

/** 번들 내용으로 원격 파일 이름을 정한다 (prefix: host-agent, mate-runner) */
export function bundleFileName(prefix: string, version: string, bundle: Buffer): string {
  return `${prefix}-${version}-${bundleBuildId(bundle)}.mjs`;
}

/**
 * 원격에서 node와 Agent 파일을 확인하는 스크립트.
 * PATH에 node가 없으면 Pi 공식 설치기가 깐 Node(pi-node)를 쓴다.
 */
/** @param dir 홈 기준 번들 폴더 (예: .pi-desktop-agent/agent) */
export function probeScript(file: string, dir: string): string {
  return [
    'NODE="$(command -v node 2>/dev/null || true)"',
    'if [ -z "$NODE" ] && [ -x "$HOME/.local/share/pi-node/current/bin/node" ]; then NODE="$HOME/.local/share/pi-node/current/bin/node"; fi',
    'printf "pi-desktop-home=%s\\n" "$HOME"',
    'printf "pi-desktop-node=%s\\n" "$NODE"',
    'if [ -n "$NODE" ]; then printf "pi-desktop-nodeVersion=%s\\n" "$("$NODE" -v)"; fi',
    `if [ -f "$HOME/${dir}/${file}" ]; then echo pi-desktop-agent=1; else echo pi-desktop-agent=0; fi`,
  ].join("\n");
}

/** 호스트에서 셸 스크립트를 실행하는 방법 (stdin으로 바이트를 넘길 수 있다). 실패하면 예외 */
export type RemoteRunner = (script: string, input?: Buffer) => Promise<string>;

export interface DeployOptions {
  /** 오류 문구에 쓰는 호스트 이름 (예: "WSL(Ubuntu)", "SSH(phone)") */
  label: string;
  run: RemoteRunner;
  /** 로컬의 번들 파일 */
  bundle: string;
  /** 번들 버전 (파일 이름에 넣는다) */
  version: string;
  /** 파일 이름 앞부분 (host-agent, mate-runner) */
  prefix: string;
  /** 홈 기준 번들 폴더 (예: .pi-desktop-agent/agent, .pi-desktop-mate/runner) */
  dir: string;
  /** Node가 없을 때 덧붙일 안내 */
  nodeHint: string;
}

export interface DeployResult {
  /** 호스트의 홈 ($HOME) */
  home: string;
  /** 호스트에서 실행할 node */
  node: string;
  /** 호스트에 올린 번들 파일 */
  remotePath: string;
  /** 번들 해시 */
  build: string;
}

/**
 * node 확인 → 필요하면 번들 업로드.
 * 업로드는 임시 파일에 쓴 뒤 mv로 바꿔치기해, 실행 중인 프로세스가 읽는 파일을 망가뜨리지 않는다.
 */
export async function deployBundle(options: DeployOptions): Promise<DeployResult> {
  const bundle = await readFile(options.bundle);
  const build = bundleBuildId(bundle);
  const fileName = bundleFileName(options.prefix, options.version, bundle);
  const probe = parseProbe(await options.run(probeScript(fileName, options.dir)));

  if (!probe.node) throw new Error(`${options.label}에서 Node.js를 찾지 못했습니다. ${options.nodeHint}`);
  if (nodeMajor(probe.nodeVersion) < MIN_NODE_MAJOR) {
    throw new Error(`${options.label}의 Node.js ${probe.nodeVersion}는 너무 오래되었습니다. ${MIN_NODE_MAJOR} 이상이 필요합니다.`);
  }

  const remotePath = `${probe.home}/${options.dir}/${fileName}`;
  if (!probe.agentPresent) {
    const tmp = `${remotePath}.uploading`;
    await options.run(`mkdir -p ${shQuote(`${probe.home}/${options.dir}`)} && cat > ${shQuote(tmp)} && mv ${shQuote(tmp)} ${shQuote(remotePath)}`, bundle);
  }
  return { home: probe.home, node: probe.node, remotePath, build };
}

/** 오류 표시용으로 stderr 마지막 몇 줄만 남긴다. WSL의 경로 변환 경고처럼 의미 없는 줄은 뺀다. */
export function stderrTail(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.includes("Failed to translate"))
    .slice(-5)
    .join("\n");
}

/** 명령을 실행해 표준 출력을 돌려준다. 실패하면 stderr 끝부분을 담은 오류. stdin으로 바이트를 넘길 수 있다. */
/** 원격 확인·Agent 올리기 명령 하나를 기다리는 최대 시간. 연결은 됐는데 응답이 멈춘 경우에도 끝나게 한다 */
const RUN_TIMEOUT_MS = 60_000;

export function runCommand(command: string, args: string[], label: string, input?: Buffer, timeoutMs = RUN_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`${label} 응답이 ${timeoutMs / 1000}초 안에 오지 않았습니다 (timed out)`));
      else if (code === 0) resolve(stdout);
      else {
        const detail = stderrTail(stderr);
        reject(new Error(`${label} 명령 실패 (code ${code})${detail ? `: ${detail}` : ""}`));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
