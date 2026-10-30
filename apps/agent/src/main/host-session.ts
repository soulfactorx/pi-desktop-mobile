import { join, posix } from "node:path";
import type { SessionOpenParams } from "@pi-desktop/host-protocol";
import { extensionEntries } from "@pi-desktop/agent-kit";
import { AGENT_HOME_ENV } from "@pi-desktop/agent-kit/home";
import { isolatedPaths, isolationArgs, isolationEnv } from "@pi-desktop/pi-isolation";
import { remoteExtensionEntries, type HostPaths } from "./hosts";

/**
 * 고른 호스트 기준으로 세션을 여는 값 (설계 DESIGN-APPS.md §3.1, §4 D3).
 * 로컬이면 이 PC의 경로를, 원격이면 그 호스트에 올린 kit과 Agent 홈의 경로(`/`로 잇는다)를 쓴다.
 */

/** 그 호스트의 Agent 세션 폴더 */
export function sessionsDirFor(paths: HostPaths): string {
  return isolatedPaths(paths.home, paths.remote).sessions;
}

/** 예약을 돌리는 스케줄러 세션의 작업 폴더 (호스트마다 하나) */
export function schedulerDirFor(paths: HostPaths): string {
  return paths.remote ? posix.join(paths.home, "scheduler") : join(paths.home, "scheduler");
}

export interface SessionParamsOptions {
  paths: HostPaths;
  /** 이 PC의 agent-kit 폴더 (확장 목록을 읽는다) */
  localKitDir: string;
  cwd: string;
  /** 개발용 덮어쓰기 (로컬에서만 준다) */
  overrides?: Partial<SessionOpenParams>;
  extraEnv?: Record<string, string>;
}

/**
 * 세션 열기 파라미터. 개발용 덮어쓰기를 먼저 깔고 앱 홈 옵션과 agent-kit 확장을 뒤에 붙인다.
 * API 키·로그인은 그 호스트의 Pi 설정(auth.json)을 쓰므로 여기서 넘기지 않는다.
 */
export async function sessionParamsFor(options: SessionParamsOptions): Promise<SessionOpenParams> {
  const { paths } = options;
  const overrides = options.overrides ?? {};
  const extensions = paths.remote ? await remoteExtensionEntries(options.localKitDir, paths.kitDir) : await extensionEntries(paths.kitDir);
  const homeArgs = isolationArgs({
    home: paths.home,
    isolationDir: paths.isolationDir,
    extensions,
    sessionDir: sessionsDirFor(paths),
    remote: paths.remote,
  });
  const env = { ...overrides.env, ...isolationEnv(paths.home), [AGENT_HOME_ENV]: paths.home, ...options.extraEnv };
  return { ...overrides, cwd: options.cwd, piArgs: [...(overrides.piArgs ?? []), ...homeArgs], env };
}
