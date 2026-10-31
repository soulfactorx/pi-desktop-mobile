import { readMcpFile, updateMcpFile, withEnabled, withPreset } from "@pi-desktop/pi-isolation/mcp-file";
import { WEB_SEARCH_PRESETS } from "@pi-desktop/pi-isolation/mcp-presets";
import type { MatePaths } from "../paths";
import { loadConfig } from "../store";

/**
 * 대화에서 켜는 웹 검색 (설계 DESIGN-MATE.md §13 "대화로 임무 만들기").
 * 앱 사용법을 모르는 사용자도 "오늘 날씨 어때?"처럼 말하면 Mate가 웹 검색을 켜자고 묻고, 허용하면 켠다.
 * 키가 필요 없는 Exa를 쓴다 (스킬·MCP 화면의 "Exa (키 없이)"와 같은 서버).
 */
const exa = WEB_SEARCH_PRESETS.find((p) => p.id === "exa")!;

export const WEB_SEARCH = {
  server: exa.name,
  label: "Exa 웹 검색",
  host: "mcp.exa.ai",
  /** 허용할 도구 (Pi가 붙이는 MCP 도구 이름) */
  tools: [`mcp__${exa.name}__web_search_exa`, `mcp__${exa.name}__web_fetch_exa`],
};

/** mcp.json에 서버가 없으면 넣고, 꺼져 있으면 켠다 (웹 검색 서버만 다룬다) */
export async function enableWebSearch(paths: MatePaths, servers: readonly string[]): Promise<void> {
  for (const name of servers) {
    const preset = WEB_SEARCH_PRESETS.find((p) => p.name === name && !p.keyEnv);
    if (!preset) continue;
    await updateMcpFile(paths.mcp, (file) => {
      const existing = file.mcpServers?.[name];
      if (!existing) return withPreset(file, preset);
      return withEnabled(file, name, true);
    });
  }
}

/** 대화에서 웹 검색을 쓸 수 있는가: 서버가 mcp.json에 켜져 있고 대화에 골라져 있다 */
export async function webSearchOn(paths: MatePaths): Promise<boolean> {
  const config = await loadConfig(paths);
  if (!config.chatMcpServers.includes(WEB_SEARCH.server)) return false;
  const entry = (await readMcpFile(paths.mcp)).mcpServers?.[WEB_SEARCH.server] as { enabled?: boolean } | undefined;
  return Boolean(entry) && entry?.enabled !== false;
}
