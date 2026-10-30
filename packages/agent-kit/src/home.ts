import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Agent의 앱 홈 (설계 DESIGN-APPS.md §3). 세션·스킬·프롬프트·MCP·AGENTS.md와 agent-kit 상태(`data/`)가 여기 있다.
 * 앱은 세션을 열 때 PI_DESKTOP_AGENT_HOME으로 알려 준다. 없으면 기본 `~/.pi-desktop-agent`.
 * 로그인·모델·설정은 Pi 설정 폴더(`~/.pi/agent`)를 그대로 쓴다.
 *
 * 확장은 대상 호스트의 Pi가 jiti로 불러오므로 이 파일은 node 내장 모듈 말고는 import하지 않는다.
 */

export const AGENT_HOME_ENV = "PI_DESKTOP_AGENT_HOME";

export function agentHome(env: NodeJS.ProcessEnv = process.env): string {
  return env[AGENT_HOME_ENV] || join(homedir(), ".pi-desktop-agent");
}
