import { resolve } from "node:path";
import { collectKit, execCommand, prepareSsh, prepareWsl, type LaunchSpec, type RemoteApp, type SshHostConfig } from "@pi-desktop/host-deploy";

/**
 * Mate의 원격 호스트 (설계 DESIGN-MATE-REMOTE.md §3). 원격 배포는 공용 패키지 host-deploy가 한다 (Agent와 같은 코드).
 * Mate에 맞춘 것만 여기 둔다:
 * - 실행기 번들은 그 호스트의 `~/.pi-desktop-mate/runner/mate-runner-…`에 둔다
 * - Pi가 `-e`로 불러올 mate-kit·pi-isolation을 `~/.pi-desktop-mate/kits/<내용 해시>/`에 올린다 (pi-isolation은 mate-kit 옆)
 * - 앱은 `MATE_HOME=~/.pi-desktop-mate PI_DESKTOP_MATE_KIT=<올린 mate-kit> mate-runner connect`로 붙는다
 */

export const MATE_HOME_DIR = ".pi-desktop-mate";

export interface MateRemoteOptions {
  /** 로컬의 번들된 실행기 (dist/mate-runner.mjs) */
  runnerScript: string;
  version: string;
  /** 로컬의 mate-kit 폴더. pi-isolation은 그 옆에 있다 */
  kitDir: string;
}

/** 그 호스트에 놓인 Mate */
export interface RemoteMate {
  /** 그 호스트의 Mate 홈 */
  home: string;
  /** 그 호스트의 사용자 홈 (폴더 고르기의 시작) */
  userHome: string;
}

export function mateRemoteApp(options: MateRemoteOptions): RemoteApp {
  return {
    homeDir: MATE_HOME_DIR,
    bundle: { path: options.runnerScript, version: options.version, prefix: "mate-runner", dir: "runner" },
    kit: () =>
      collectKit([
        { name: "mate-kit", dir: options.kitDir },
        { name: "pi-isolation", dir: resolve(options.kitDir, "..", "pi-isolation") },
      ]),
    command: (placed) => execCommand(placed, "connect", { MATE_HOME: placed.appHome, PI_DESKTOP_MATE_KIT: `${placed.kitBase}/mate-kit` }),
  };
}

export async function prepareMateWsl(distro: string, options: MateRemoteOptions): Promise<{ spec: LaunchSpec; remote: RemoteMate }> {
  const prepared = await prepareWsl(distro, mateRemoteApp(options));
  return { spec: prepared.spec, remote: { home: prepared.placed.appHome, userHome: prepared.placed.userHome } };
}

export async function prepareMateSsh(host: SshHostConfig, options: MateRemoteOptions): Promise<{ spec: LaunchSpec; remote: RemoteMate }> {
  const prepared = await prepareSsh(host, mateRemoteApp(options));
  return { spec: prepared.spec, remote: { home: prepared.placed.appHome, userHome: prepared.placed.userHome } };
}
