import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface NodeRuntime {
  /** 실행 파일 경로 */
  command: string;
  /** 이 런타임으로 실행할 때 추가할 환경 변수 */
  env: Record<string, string>;
  /** 어디서 찾았는지 (UI 표시용) */
  source: "system" | "electron";
}

/**
 * Host Agent(와 그 아래 Pi)를 실행할 Node를 고른다.
 *
 * Pi는 사용자가 설치한 시스템 Node(22.19 이상)에서 돌도록 만들어졌으므로 시스템 node를 우선한다.
 * 찾지 못하면 Electron 실행 파일을 Node 모드(ELECTRON_RUN_AS_NODE)로 쓴다.
 */
export async function resolveNodeRuntime(): Promise<NodeRuntime> {
  const finder = process.platform === "win32" ? "where" : "which";
  try {
    const { stdout } = await execFileAsync(finder, ["node"], { timeout: 5_000, windowsHide: true });
    const first = stdout.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim();
    if (first) return { command: first, env: {}, source: "system" };
  } catch {
    // 아래 대체 경로로 진행
  }
  return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" }, source: "electron" };
}
