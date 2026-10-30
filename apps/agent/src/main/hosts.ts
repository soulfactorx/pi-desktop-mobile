import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import {
  collectKit,
  execCommand,
  LOCAL_HOST_ID,
  prepareSsh,
  prepareWsl,
  SSH_PREFIX,
  WSL_PREFIX,
  type LaunchSpec,
  type Placed,
  type RemoteApp,
  type SshHostConfig,
} from "@pi-desktop/host-deploy";

/**
 * 에이전트 앱의 호스트 (설계 DESIGN-APPS.md §4, §6 D3). 로컬·WSL·SSH 중 하나에 연결한다.
 *
 * 원격 배포는 공용 패키지 host-deploy가 한다 (Mate와 같은 코드). Agent에 맞춘 것만 여기 둔다:
 * - Host Agent 번들은 `~/.pi-desktop-agent/agent/`에 두고, 데몬 홈을 `~/.pi-desktop-agent`로 띄운다 (PI_DESKTOP_HOME).
 *   Pi Desktop의 데몬·휴지통과 섞이지 않는다
 * - Pi가 `-e`로 불러올 agent-kit·pi-isolation을 `~/.pi-desktop-agent/kits/<내용 해시>/`에 올린다
 */

export { LOCAL_HOST_ID, SSH_PREFIX, WSL_PREFIX };

/** 호스트 홈 아래 Agent 홈 폴더 이름 */
export const AGENT_HOME_DIR = ".pi-desktop-agent";

/** 세션을 열 때 그 호스트 기준으로 쓰는 경로 */
export interface HostPaths {
  /** 다른 호스트(WSL·SSH)인가. 경로를 `/`로 잇는다 */
  remote: boolean;
  /** 그 호스트의 Agent 홈 */
  home: string;
  /** 그 호스트의 agent-kit 폴더 */
  kitDir: string;
  /** 그 호스트의 pi-isolation 폴더 */
  isolationDir: string;
  /** 그 호스트의 사용자 홈 (새 대화의 기본 폴더) */
  userHome: string;
}

export interface RemotePrepareOptions {
  /** 로컬의 번들된 Host Agent 파일 */
  agentScript: string;
  agentVersion: string;
  /** 로컬의 agent-kit·pi-isolation 폴더 (올릴 내용) */
  kitDir: string;
  isolationDir: string;
}

/** 연결 준비 결과: 연결기 실행 명령과 그 호스트 기준 경로 */
export interface Prepared {
  spec: LaunchSpec;
  paths: HostPaths;
}

/** Agent를 원격에 올리는 방법 (host-deploy의 RemoteApp) */
export function agentRemoteApp(options: RemotePrepareOptions): RemoteApp {
  return {
    homeDir: AGENT_HOME_DIR,
    bundle: { path: options.agentScript, version: options.agentVersion, prefix: "host-agent", dir: "agent" },
    kit: () => collectKit([{ name: "agent-kit", dir: options.kitDir }, { name: "pi-isolation", dir: options.isolationDir }]),
    command: (placed) => execCommand(placed, "connect", { PI_DESKTOP_HOME: placed.appHome }),
  };
}

export function hostPathsOf(placed: Placed): HostPaths {
  return { remote: true, home: placed.appHome, kitDir: `${placed.kitBase}/agent-kit`, isolationDir: `${placed.kitBase}/pi-isolation`, userHome: placed.userHome };
}

export async function prepareAgentWsl(distro: string, options: RemotePrepareOptions): Promise<Prepared> {
  const prepared = await prepareWsl(distro, agentRemoteApp(options));
  return { spec: prepared.spec, paths: hostPathsOf(prepared.placed) };
}

export async function prepareAgentSsh(host: SshHostConfig, options: RemotePrepareOptions): Promise<Prepared> {
  const prepared = await prepareSsh(host, agentRemoteApp(options));
  return { spec: prepared.spec, paths: hostPathsOf(prepared.placed) };
}

/** 원격 kit의 확장 진입 파일 (로컬 package.json의 pi.extensions를 그 호스트 경로로) */
export async function remoteExtensionEntries(localKitDir: string, remoteKitDir: string): Promise<string[]> {
  const manifest = JSON.parse(await readFile(join(localKitDir, "package.json"), "utf8")) as { pi?: { extensions?: unknown } };
  const entries = Array.isArray(manifest.pi?.extensions) ? manifest.pi.extensions : [];
  return entries.filter((e): e is string => typeof e === "string").map((entry) => posix.join(remoteKitDir, entry));
}
