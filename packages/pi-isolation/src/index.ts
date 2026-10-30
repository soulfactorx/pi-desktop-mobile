import { posix, resolve } from "node:path";
import { join } from "node:path";
import { ISOLATION_HOME_ENV, ISOLATION_MCP_EXPOSURE_ENV, ISOLATION_MCP_SERVERS_ENV, isolatedPaths } from "./paths";

export { ISOLATION_HOME_ENV, isolatedPaths, isolationHome } from "./paths";
export { mcpToolPattern } from "./mcp-config";

/**
 * Agent·Mate가 Pi를 띄울 때 데이터가 들어오는 길만 바꾸는 옵션 (설계 DESIGN-APPS.md §3.1).
 *
 * Pi 설정 폴더(`PI_CODING_AGENT_DIR`)는 바꾸지 않는다. 바꾸면 로그인·모델까지 갈라진다.
 * 대신 Pi 기본 폴더의 스킬·프롬프트·확장·문맥 파일을 끄고 앱 홈의 것만 올린다.
 * 꺼진 MCP와 문맥 파일은 이 패키지의 확장이 앱 홈에서 다시 읽는다.
 */

const MCP_EXTENSION = "extensions/mcp.ts";
const CONTEXT_EXTENSION = "extensions/context.ts";

/** Pi 내장 확장 중 다시 올릴 것. MCP 도구는 기본 노출이 codemode라 이 둘이 있어야 쓸 수 있다. 내장 MCP는 올리지 않는다 */
const BUILTIN_EXTENSIONS = ["builtin:codemode", "builtin:tool-search"];

export interface IsolationOptions {
  /** 앱 홈 (예: `~/.pi-desktop-agent`) */
  home: string;
  /** 이 패키지 폴더. 개발 중에는 워크스페이스, 설치본에서는 앱 리소스 */
  isolationDir: string;
  /** 앱의 kit 확장 진입 파일들 (절대 경로) */
  extensions: string[];
  /** 세션 폴더. 주지 않으면 `--session-dir`를 붙이지 않는다 (호출하는 쪽이 따로 정할 때) */
  sessionDir?: string;
  /** false면 MCP를 아예 올리지 않는다 (MCP 확장과 codemode·tool-search 모두). 기본 true */
  mcp?: boolean;
  /** 올릴 스킬 이름. 주면 앱 홈 skills/ 아래 그 스킬 폴더만 올린다 (빈 배열이면 스킬 없음). 없으면 skills/ 전부 */
  skills?: string[];
  /** 다른 호스트(WSL·SSH)에서 띄울 때 true. 경로를 `/`로 잇는다 (home·isolationDir도 그 호스트의 절대 경로) */
  remote?: boolean;
}

/** 이 패키지의 확장 진입 파일 (절대 경로) */
export function isolationExtensionPaths(isolationDir: string, options: { mcp?: boolean; remote?: boolean } = {}): string[] {
  const entries = options.mcp === false ? [CONTEXT_EXTENSION] : [MCP_EXTENSION, CONTEXT_EXTENSION];
  return entries.map((entry) => (options.remote ? posix.join(isolationDir, entry) : resolve(isolationDir, entry)));
}

/** `pi --mode …` 뒤에 붙일 인자 */
export function isolationArgs(options: IsolationOptions): string[] {
  const remote = options.remote === true;
  const paths = isolatedPaths(options.home, remote);
  const pathJoin = remote ? posix.join : join;
  const mcp = options.mcp !== false;
  const extensions = [...options.extensions, ...isolationExtensionPaths(options.isolationDir, { mcp, remote }), ...(mcp ? BUILTIN_EXTENSIONS : [])];
  return [
    ...(options.sessionDir ? ["--session-dir", options.sessionDir] : []),
    "-ns",
    ...(options.skills ? options.skills.flatMap((name) => ["--skill", pathJoin(paths.skills, name)]) : ["--skill", paths.skills]),
    "-np",
    "--prompt-template",
    paths.prompts,
    "-ne",
    ...extensions.flatMap((entry) => ["-e", entry]),
    "-nc",
  ];
}

/**
 * Pi 프로세스에 줄 환경 변수.
 * mcpServers를 주면 그 서버만 올리고(빈 배열이면 없음), mcpExposure: "direct"면 도구를 모델에 바로 선언한다.
 */
export function isolationEnv(home: string, options: { mcpServers?: string[]; mcpExposure?: "direct" } = {}): Record<string, string> {
  return {
    [ISOLATION_HOME_ENV]: home,
    ...(options.mcpServers ? { [ISOLATION_MCP_SERVERS_ENV]: options.mcpServers.join(",") } : {}),
    ...(options.mcpExposure ? { [ISOLATION_MCP_EXPOSURE_ENV]: options.mcpExposure } : {}),
  };
}
