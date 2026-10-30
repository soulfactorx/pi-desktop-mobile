import { existsSync, readFileSync } from "node:fs";
import type { LoadedMcpConfig, McpServerConfig, McpServerEntry } from "@earendil-works/pi-coding-agent";

/**
 * 앱 홈의 `mcp.json`을 Pi의 MCP 확장이 받는 모양으로 읽는다 (설계 DESIGN-APPS.md §3.1 "MCP").
 *
 * Pi의 `loadMcpConfig`는 공개되어 있지 않고 Pi 설정 폴더만 읽으므로 같은 형식을 여기서 읽는다.
 * 프로젝트의 `.pi/mcp.json`은 읽지 않는다. 앱이 쓰는 서버는 앱 홈에서만 정한다.
 * 깨진 서버는 빼고 오류로 알린다. 꺼진 서버도 `enabled: false`로 넣는다 (Pi와 같음).
 */

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** 도구 이름 공간이 같은지 (`-`와 `_`만 다른 이름은 같은 `mcp__<이름>`이 된다) */
const namespaceOf = (name: string) => name.replace(/-/g, "_");

export function serverConfigError(name: string, value: unknown): string | undefined {
  if (!SERVER_NAME.test(name)) return `invalid server name "${name}" (use letters, digits, "_" and "-")`;
  if (!isRecord(value)) return `server "${name}" must be an object`;
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") return `server "${name}": enabled must be a boolean`;
  if (typeof value.url === "string") {
    if (!URL.canParse(value.url) || !/^https?:$/.test(new URL(value.url).protocol)) return `server "${name}": url must be an http or https URL`;
    return undefined;
  }
  if (typeof value.command === "string") {
    if (value.args !== undefined && !(Array.isArray(value.args) && value.args.every((arg) => typeof arg === "string"))) {
      return `server "${name}": args must be an array of strings`;
    }
    return undefined;
  }
  return `server "${name}" needs either "command" (stdio) or "url" (streamable HTTP)`;
}

export function parseMcpConfig(path: string, text: string | undefined): LoadedMcpConfig {
  const errors: string[] = [];
  if (text === undefined || !text.trim()) return { servers: [], errors };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { servers: [], errors: [`${path}: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
    return { servers: [], errors: [`${path}: expected an object with an "mcpServers" object`] };
  }
  const servers: McpServerEntry[] = [];
  for (const [name, value] of Object.entries((parsed.mcpServers as Record<string, unknown> | undefined) ?? {})) {
    const error = serverConfigError(name, value);
    if (error) {
      errors.push(`${path}: ${error}`);
      continue;
    }
    const clash = servers.find((other) => namespaceOf(other.name) === namespaceOf(name));
    if (clash) {
      errors.push(`${path}: server "${name}" conflicts with "${clash.name}"`);
      continue;
    }
    servers.push({ name, config: value as McpServerConfig, source: path, scope: "global" });
  }
  let autoEnableCodemode: boolean | undefined;
  if (typeof parsed.autoEnableCodemode === "boolean") autoEnableCodemode = parsed.autoEnableCodemode;
  else if (parsed.autoEnableCodemode !== undefined) errors.push(`${path}: autoEnableCodemode must be a boolean`);
  return { servers, errors, ...(autoEnableCodemode === undefined ? {} : { autoEnableCodemode }) };
}

/**
 * 고른 서버만 남기고, direct면 서버·도구의 노출을 모두 direct로 바꾼다.
 * servers가 undefined면 전부 남긴다.
 */
export function filterMcpConfig(loaded: LoadedMcpConfig, options: { servers?: string[]; exposure?: "direct" }): LoadedMcpConfig {
  const picked = options.servers ? new Set(options.servers) : undefined;
  const servers = loaded.servers
    .filter((entry) => !picked || picked.has(entry.name))
    .map((entry) => {
      if (options.exposure !== "direct") return entry;
      const { toolExposure: _tools, ...config } = entry.config as McpServerConfig & { toolExposure?: unknown };
      return { ...entry, config: { ...config, exposure: "direct" } as McpServerConfig };
    });
  return { ...loaded, servers };
}

/** MCP 서버의 도구 이름 패턴 (`--tools`에 넣는다). Pi처럼 `-`는 `_`로 바꾼다 */
export function mcpToolPattern(server: string): string {
  return `mcp__${server.replace(/-/g, "_")}__*`;
}

export function loadMcpConfigFile(path: string): LoadedMcpConfig {
  return parseMcpConfig(path, existsSync(path) ? readFileSync(path, "utf8") : undefined);
}
