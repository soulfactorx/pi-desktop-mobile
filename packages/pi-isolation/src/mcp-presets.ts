/**
 * MCP 설정 화면이 쓰는 모양과 미리 정한 서버 목록 (설계 DESIGN-AGENT.md §4 "웹 페이지 읽기, 웹 검색", DESIGN-APPS.md §3.4).
 * Agent와 Mate가 함께 쓴다. 두 앱 모두 앱 홈의 설정 파일(`<앱 홈>/mcp.json`)을 고친다 (DESIGN-APPS.md §3.1).
 * Mate가 제안할 수 있는 MCP 서버도 이 목록 안의 것뿐이다.
 * 렌더러도 쓰므로 node 모듈을 import하지 않는다.
 */

/** mcp.json의 서버 하나를 화면에 보이는 모양. 키가 든 env·headers 값은 화면으로 보내지 않는다 */
export interface McpServerView {
  name: string;
  kind: "command" | "url";
  /** 명령과 인자, 또는 주소 */
  target: string;
  enabled: boolean;
  description?: string;
  /** env나 headers가 있는가 (값은 숨긴다) */
  hasSecrets: boolean;
}

export interface McpCheckResult {
  ok: boolean;
  /** `pi mcp list` 출력 */
  output: string;
}

export interface McpPreset {
  id: string;
  /** mcp.json에 쓸 서버 이름 */
  name: string;
  label: string;
  detail: string;
  /** API 키가 필요하면 그 환경 변수 이름 */
  keyEnv?: string;
  keyUrl?: string;
  entry: Record<string, unknown>;
}

export const WEB_SEARCH_PRESETS: McpPreset[] = [
  {
    id: "exa",
    name: "exa",
    label: "Exa (키 없이)",
    detail: "원격 서버라 설치할 것이 없습니다. 무료 사용량 제한이 있습니다. 도구: web_search_exa, web_fetch_exa",
    entry: { url: "https://mcp.exa.ai/mcp", description: "Exa 웹 검색과 페이지 읽기" },
  },
  {
    id: "brave",
    name: "brave-search",
    label: "Brave Search",
    detail: "Brave Search API 키가 필요합니다. Node.js(npx)로 서버를 띄웁니다",
    keyEnv: "BRAVE_API_KEY",
    keyUrl: "https://brave.com/search/api/",
    entry: { command: "npx", args: ["-y", "@brave/brave-search-mcp-server"], description: "Brave 웹·뉴스 검색" },
  },
  {
    id: "tavily",
    name: "tavily",
    label: "Tavily",
    detail: "Tavily API 키가 필요합니다. Node.js(npx)로 서버를 띄웁니다",
    keyEnv: "TAVILY_API_KEY",
    keyUrl: "https://tavily.com/",
    entry: { command: "npx", args: ["-y", "tavily-mcp"], description: "Tavily 웹 검색과 페이지 추출" },
  },
];

/** Pi 규칙: 서버 이름은 글자·숫자·_·-만 */
export function validServerName(name: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(name);
}
