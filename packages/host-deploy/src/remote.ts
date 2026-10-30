import { deployBundle, shQuote, type RemoteRunner } from "./bundle";
import { deployKit, type KitBundle } from "./kit";
import { explainSshError, sshRunner, sshShell, type SshHostConfig } from "./ssh";
import { wslRunner, wslShell } from "./wsl";

/**
 * 원격 호스트 준비의 공통 절차 (설계 DESIGN-MATE-REMOTE.md §3): Node 확인 → 번들 올리기 → kit 올리기 → 그 호스트에서 실행할 명령.
 * 앱마다 다른 것(홈 폴더, 번들, kit, 실행할 하위 명령과 환경)은 옵션으로 받는다.
 */

/** 연결기를 띄우는 명령 (Pi Desktop host-connection의 LaunchSpec과 같은 모양) */
export interface LaunchSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** 실행할 번들의 해시 */
  agentBuild?: string;
}

export interface RemoteApp {
  /** 호스트 홈 아래 앱 홈 폴더 이름 (예: .pi-desktop-agent) */
  homeDir: string;
  /** 번들: 로컬 파일, 버전, 파일 이름 앞부분, 앱 홈 아래 폴더 이름 (예: host-agent·agent, mate-runner·runner) */
  bundle: { path: string; version: string; prefix: string; dir: string };
  /** 올릴 kit (로컬 폴더를 모아 해시를 붙인 것) */
  kit: () => Promise<KitBundle>;
  /** 그 호스트에서 exec할 명령 줄 (셸 스크립트). 인자는 shQuote로 감싼다 */
  command: (placed: Placed) => string;
}

/** 그 호스트에 놓인 것들의 경로 */
export interface Placed {
  /** 호스트의 사용자 홈 */
  userHome: string;
  /** 앱 홈 (<사용자 홈>/<homeDir>) */
  appHome: string;
  node: string;
  /** 올린 번들 파일 */
  bundle: string;
  /** 올린 kit 폴더 (<앱 홈>/kits/<해시>) */
  kitBase: string;
}

export interface Prepared {
  spec: LaunchSpec;
  placed: Placed;
}

export async function prepareRemote(
  label: string,
  run: RemoteRunner,
  launch: (script: string) => { command: string; args: string[] },
  nodeHint: string,
  app: RemoteApp,
): Promise<Prepared> {
  const deployed = await deployBundle({
    label,
    run,
    bundle: app.bundle.path,
    version: app.bundle.version,
    prefix: app.bundle.prefix,
    dir: `${app.homeDir}/${app.bundle.dir}`,
    nodeHint,
  });
  const appHome = `${deployed.home}/${app.homeDir}`;
  const kitBase = await deployKit(run, appHome, await app.kit());
  const placed: Placed = { userHome: deployed.home, appHome, node: deployed.node, bundle: deployed.remotePath, kitBase };
  return { spec: { ...launch(app.command(placed)), agentBuild: deployed.build }, placed };
}

export function prepareWsl(distro: string, app: RemoteApp): Promise<Prepared> {
  return prepareRemote(`WSL(${distro})`, wslRunner(distro), wslShell(distro), "배포판에 Node.js 22 이상을 설치하세요 (Pi Desktop의 Pi 관리에서 안내합니다).", app);
}

export function prepareSsh(host: SshHostConfig, app: RemoteApp): Promise<Prepared> {
  return prepareRemote(`SSH(${host.name})`, sshRunner(host), sshShell(host), "서버에 Node.js 22 이상을 설치하세요.", app).catch((error: unknown) => {
    throw new Error(explainSshError(error instanceof Error ? error.message : String(error)));
  });
}

/** `exec env A=… <node> <번들> <하위 명령>` 꼴의 명령 줄 */
export function execCommand(placed: Placed, subcommand: string, env: Record<string, string> = {}): string {
  const vars = Object.entries(env).map(([key, value]) => `${key}=${shQuote(value)}`);
  return `exec ${vars.length ? `env ${vars.join(" ")} ` : ""}${shQuote(placed.node)} ${shQuote(placed.bundle)} ${subcommand}`;
}
