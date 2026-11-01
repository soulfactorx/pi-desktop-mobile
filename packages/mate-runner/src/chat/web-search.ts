import { extToolGrant } from "@pi-desktop/mate-kit";
import { readMcpFile, serverViews, updateMcpFile, withEnabled, withPreset } from "@pi-desktop/pi-isolation/mcp-file";
import { WEB_SEARCH_PRESETS } from "@pi-desktop/pi-isolation/mcp-presets";
import { packageToolNames } from "@pi-desktop/pi-resources";
import type { MatePaths } from "../paths";
import { loadConfig } from "../store";

/**
 * 대화에서 켜는 웹 검색 (설계 DESIGN-MATE.md §13 "대화로 임무 만들기", DESIGN-APPS.md §3.5 4단계).
 * 앱 사용법을 모르는 사용자도 "오늘 날씨 어때?"처럼 말하면 Mate가 웹 검색을 켜자고 묻고, 허용하면 켠다.
 * 특정 서비스를 정해 넣지 않는다. 이미 있는 것(설치한 확장의 웹 도구, mcp.json의 검색 서버)을 먼저 고르게 하고,
 * 아무것도 없을 때만 키 없이 쓰는 Exa를 선택지로 보인다. 키가 필요한 서버·다른 패키지는 방법만 알린다.
 */
const exa = WEB_SEARCH_PRESETS.find((p) => p.id === "exa")!;

/** Exa 서버의 도구 (Pi가 붙이는 MCP 도구 이름) */
export const WEB_SEARCH = {
  server: exa.name,
  label: "Exa 웹 검색",
  host: "mcp.exa.ai",
  tools: [`mcp__${exa.name}__web_search_exa`, `mcp__${exa.name}__web_fetch_exa`],
};

const presetTools = (name: string): string[] => (name === exa.name ? WEB_SEARCH.tools : []);

/** Mate 홈에 설치한 패키지의 웹 도구 (이름에 search·fetch·web이 든 것) */
export function packageWebTools(paths: MatePaths): string[] {
  return packageToolNames(paths.home).filter((t) => /search|fetch|web/i.test(t));
}

/** 웹 검색을 켜는 방법 하나 (질문의 선택지) */
export interface WebChoice {
  label: string;
  detail: string;
  /** 대화에 허용할 도구 이름 (MCP 도구, 확장 도구는 ext__) */
  commands: string[];
  /** 켜고 대화에 쓸 MCP 서버 */
  mcpServers?: string[];
}

/** 지금 고를 수 있는 웹 검색 방법. 이미 있는 것이 앞에 온다 */
export async function webChoices(paths: MatePaths): Promise<WebChoice[]> {
  const choices: WebChoice[] = [];
  const tools = packageWebTools(paths);
  if (tools.length > 0) {
    choices.push({ label: "설치한 확장으로 켜기", detail: `Mate에 설치한 확장의 도구(${tools.join(", ")})를 대화에서 써요.`, commands: tools.map(extToolGrant) });
  }
  const servers = serverViews(await readMcpFile(paths.mcp).catch(() => ({ mcpServers: {} })));
  for (const preset of WEB_SEARCH_PRESETS) {
    const server = servers.find((s) => s.name === preset.name);
    if (!server) continue;
    if (preset.keyEnv && !server.hasSecrets) continue;
    choices.push({ label: `${preset.label.replace(/\s*\(.*\)$/, "")} 켜기`, detail: `이미 넣어 둔 검색 서버예요. ${preset.detail}`, commands: presetTools(preset.name), mcpServers: [preset.name] });
  }
  if (!servers.some((s) => s.name === exa.name)) {
    choices.push({
      label: "Exa로 켜기 (키 없이)",
      detail: `검색어와 읽을 웹 페이지 주소가 ${WEB_SEARCH.host}로 나가요. 파일이나 대화 내용은 보내지 않아요.`,
      commands: WEB_SEARCH.tools,
      mcpServers: [exa.name],
    });
  }
  return choices;
}

/** mcp.json에 서버가 없으면 넣고, 꺼져 있으면 켠다 (웹 검색 서버만 다룬다) */
export async function enableWebSearch(paths: MatePaths, servers: readonly string[]): Promise<void> {
  for (const name of servers) {
    const preset = WEB_SEARCH_PRESETS.find((p) => p.name === name);
    if (!preset) continue;
    await updateMcpFile(paths.mcp, (file) => {
      const existing = file.mcpServers?.[name];
      if (!existing) return preset.keyEnv ? file : withPreset(file, preset);
      return withEnabled(file, name, true);
    });
  }
}

/** 대화에서 쓸 웹 검색: 대화에 고른 검색 서버(켜져 있는 것)와, 허용한 확장 웹 도구 */
export async function webSetup(paths: MatePaths): Promise<{ mcpServers: string[]; grants: string[] } | undefined> {
  const config = await loadConfig(paths);
  const servers = serverViews(await readMcpFile(paths.mcp).catch(() => ({ mcpServers: {} })));
  const names = new Set(WEB_SEARCH_PRESETS.map((p) => p.name));
  const mcpServers = config.chatMcpServers.filter((n) => names.has(n) && servers.some((s) => s.name === n && s.enabled));
  const extGrants = packageWebTools(paths).map(extToolGrant).filter((g) => config.chatGrants.includes(g));
  if (mcpServers.length === 0 && extGrants.length === 0) return undefined;
  const grants = [...mcpServers.flatMap(presetTools).filter((t) => config.chatGrants.includes(t)), ...extGrants];
  return { mcpServers, grants };
}

/** 대화에서 웹 검색을 쓸 수 있는가 */
export async function webSearchOn(paths: MatePaths): Promise<boolean> {
  return (await webSetup(paths)) !== undefined;
}
