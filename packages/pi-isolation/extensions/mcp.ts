import { createMcpExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { filterMcpConfig, loadMcpConfigFile } from "../src/mcp-config";
import { ISOLATION_MCP_EXPOSURE_ENV, ISOLATION_MCP_SERVERS_ENV, isolatedPaths, isolationHome } from "../src/paths";

/**
 * 앱 홈의 `mcp.json`을 읽는 MCP 확장 (설계 DESIGN-APPS.md §3.1).
 *
 * Pi의 내장 MCP는 Pi 설정 폴더의 `mcp.json`만 읽으므로 `-ne`로 끄고, 같은 구현(createMcpExtension)을
 * 설정 읽기와 로그 위치만 바꿔 올린다. 앱 홈을 모르면(PI_ISOLATION_HOME 없음) 아무것도 하지 않는다.
 * PI_ISOLATION_MCP_SERVERS가 있으면 그 서버만, PI_ISOLATION_MCP_EXPOSURE=direct면 도구를 모델에 바로 선언한다 (Mate).
 *
 * OAuth로 로그인하는 서버의 자격 증명은 아직 Pi 설정 폴더의 `mcp-auth.json`을 쓴다.
 * Pi가 자격 증명 저장소를 공개하지 않아 위치를 바꿀 수 없기 때문이다 (서버 이름·주소로 나뉜다).
 */
export default function mcp(pi: ExtensionAPI): void | Promise<void> {
  const home = isolationHome();
  if (!home) return;
  const paths = isolatedPaths(home);
  const list = process.env[ISOLATION_MCP_SERVERS_ENV];
  const servers = list === undefined ? undefined : list.split(",").map((s) => s.trim()).filter(Boolean);
  const exposure = process.env[ISOLATION_MCP_EXPOSURE_ENV] === "direct" ? "direct" : undefined;
  const loadConfig = () => filterMcpConfig(loadMcpConfigFile(paths.mcp), { ...(servers ? { servers } : {}), ...(exposure ? { exposure } : {}) });
  return createMcpExtension({ loadConfig, logPath: paths.mcpLog })(pi);
}
