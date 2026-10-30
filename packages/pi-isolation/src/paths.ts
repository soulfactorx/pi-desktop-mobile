import { join as nativeJoin, posix } from "node:path";

/**
 * 앱 홈 안의 Pi 데이터 위치 (설계 DESIGN-APPS.md §3).
 *
 * 확장은 대상 호스트의 Pi가 jiti로 불러오므로 이 파일은 node 내장 모듈 말고는 import하지 않는다.
 */

/** 앱이 Pi에 앱 홈을 알리는 환경 변수. 이 패키지의 확장은 이 값이 없으면 아무것도 하지 않는다 */
export const ISOLATION_HOME_ENV = "PI_ISOLATION_HOME";

/** 올릴 MCP 서버 이름 (쉼표로 구분). 없으면 mcp.json의 서버 전부, 빈 값이면 없음 (Mate가 임무마다 고른 서버) */
export const ISOLATION_MCP_SERVERS_ENV = "PI_ISOLATION_MCP_SERVERS";
/** "direct"면 모든 서버의 도구를 모델에 바로 선언되는 노출로 바꾼다 (Mate처럼 --tools로 도구를 정하는 실행) */
export const ISOLATION_MCP_EXPOSURE_ENV = "PI_ISOLATION_MCP_EXPOSURE";

export function isolationHome(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[ISOLATION_HOME_ENV] || undefined;
}

/**
 * @param remote 다른 호스트(WSL·SSH)의 경로를 만들 때 true. 이 PC가 Windows여도 `/`로 잇는다 (DESIGN-APPS.md §4)
 */
export function isolatedPaths(home: string, remote = false) {
  const join = remote ? posix.join : nativeJoin;
  return {
    home,
    sessions: join(home, "sessions"),
    skills: join(home, "skills"),
    prompts: join(home, "prompts"),
    mcp: join(home, "mcp.json"),
    mcpLog: join(home, "mcp.log"),
  };
}
