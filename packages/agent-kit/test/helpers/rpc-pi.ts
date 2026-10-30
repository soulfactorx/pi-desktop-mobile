import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extensionArgs, extensionEntries } from "../../src/index";

/**
 * 실제 Pi(devDependency)를 앱과 같은 방식(`pi --mode rpc -e <agent-kit 확장>`)으로 띄우는 계약 테스트 공용 코드.
 * 사용자 ~/.pi·~/.pi-desktop-agent를 건드리지 않도록 Pi 설정 폴더와 앱 홈·agent-kit 상태 폴더를 임시 폴더로 격리한다.
 */

export const kitDir = resolve(fileURLToPath(new URL("../..", import.meta.url)));

// Pi의 exports는 import 조건만 열어 두어 require.resolve를 쓸 수 없다. node_modules를 위로 올라가며 찾는다.
function findPiCli(): string {
  let dir = kitDir;
  for (;;) {
    const candidate = join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("Pi를 찾을 수 없습니다. npm install을 먼저 실행하세요");
    dir = parent;
  }
}

/** 저장소의 Pi devDependency CLI */
export const PI_CLI = findPiCli();

export type RpcRecord = Record<string, unknown>;

/** Pi RPC 프로세스 하나. 응답은 id로, 이벤트는 조건으로 기다린다 */
export class RpcPi {
  private buffer = "";
  readonly records: RpcRecord[] = [];
  private readonly waiters: Array<{ match: (r: RpcRecord) => boolean; resolve: (r: RpcRecord) => void; from: number }> = [];
  private nextId = 1;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      // RPC는 LF로만 나눈다 (rpc.md "strict JSONL framing")
      let index: number;
      while ((index = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, index).replace(/\r$/, "");
        this.buffer = this.buffer.slice(index + 1);
        if (line.trim()) this.receive(JSON.parse(line) as RpcRecord);
      }
    });
  }

  private receive(record: RpcRecord): void {
    this.records.push(record);
    for (const waiter of [...this.waiters]) {
      if (waiter.match(record)) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(record);
      }
    }
  }

  /** 지금까지 받은 레코드 수. waitFor의 from에 넘기면 그 뒤에 온 것만 본다 */
  get mark(): number {
    return this.records.length;
  }

  /** from 이후에 받은 것 중에 있으면 바로, 아니면 올 때까지 기다린다 */
  waitFor(match: (r: RpcRecord) => boolean, from = 0): Promise<RpcRecord> {
    const seen = this.records.slice(from).find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve) => this.waiters.push({ match, resolve, from }));
  }

  async request(command: RpcRecord): Promise<RpcRecord> {
    const id = `t${this.nextId++}`;
    this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    return this.waitFor((r) => r.type === "response" && r.id === id);
  }

  /** 응답이 없는 레코드 (extension_ui_response) */
  write(record: RpcRecord): void {
    this.child.stdin.write(`${JSON.stringify(record)}\n`);
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}

export interface StartedPi {
  pi: RpcPi;
  projectDir: string;
  /** agent-kit 상태 폴더 (PI_DESKTOP_AGENT_DATA) */
  dataDir: string;
  /** Pi 설정 폴더 (PI_CODING_AGENT_DIR) */
  piAgentDir: string;
  /** 앱 홈 (PI_DESKTOP_AGENT_HOME). 스킬은 이 아래 skills/ */
  agentHome: string;
}

export interface StartOptions {
  /** models.json의 contextWindow. 작은 창(로컬 모델)을 흉내 낼 때 */
  contextWindow?: number;
  /** settings.json에 쓸 내용 */
  settings?: Record<string, unknown>;
  /** 작업 폴더에 미리 만들 파일 */
  files?: Record<string, string>;
  /** Pi 프로세스에 더할 환경 변수 */
  env?: Record<string, string>;
  /** agent-kit 상태 폴더에 미리 만들 파일 (상대 경로 → 내용) */
  dataFiles?: Record<string, string>;
}

/**
 * @param llmBaseUrl mock LLM 주소. LLM을 부르지 않는 테스트면 아무 값이나 둔다
 */
export async function startPi(llmBaseUrl = "http://127.0.0.1:9/v1", options: StartOptions = {}): Promise<StartedPi> {
  const piAgentDir = mkdtempSync(join(tmpdir(), "agent-kit-pi-"));
  const model: Record<string, unknown> = { id: "mock-model" };
  if (options.contextWindow) model.contextWindow = options.contextWindow;
  writeFileSync(
    join(piAgentDir, "models.json"),
    JSON.stringify({
      providers: {
        mock: { baseUrl: llmBaseUrl, api: "openai-completions", apiKey: "mock", models: [model] },
      },
    }),
  );
  if (options.settings) writeFileSync(join(piAgentDir, "settings.json"), JSON.stringify(options.settings));
  const projectDir = mkdtempSync(join(tmpdir(), "agent-kit-project-"));
  for (const [name, content] of Object.entries(options.files ?? {})) writeFileSync(join(projectDir, name), content);
  const dataDir = mkdtempSync(join(tmpdir(), "agent-kit-data-"));
  const agentHome = mkdtempSync(join(tmpdir(), "agent-kit-home-"));
  for (const [name, content] of Object.entries(options.dataFiles ?? {})) writeFileSync(join(dataDir, name), content);
  const args = [
    PI_CLI,
    "--mode",
    "rpc",
    "--no-session",
    "--provider",
    "mock",
    "--model",
    "mock-model",
    ...extensionArgs(await extensionEntries(kitDir)),
  ];
  const child = spawn(process.execPath, args, {
    cwd: projectDir,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: piAgentDir,
      PI_CODING_AGENT_SESSION_DIR: join(piAgentDir, "sessions"),
      PI_DESKTOP_AGENT_DATA: dataDir,
      PI_DESKTOP_AGENT_HOME: agentHome,
      // 턴 뒤 기억 추출은 기본으로 끈다. 추출 요청이 다른 테스트의 스크립트 단계를 가로채지 않게 한다
      PI_DESKTOP_AGENT_LEARN: "0",
      ...options.env,
    },
  });
  return { pi: new RpcPi(child), projectDir, dataDir, piAgentDir, agentHome };
}
