import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { validServerName, type McpPreset, type McpServerView } from "./mcp-presets";

/**
 * 앱 홈의 MCP 설정(`<앱 홈>/mcp.json`, Pi와 같은 형식)을 읽고 고친다 (Agent·Mate). 모르는 칸과 다른 서버는 그대로 둔다.
 * 파일이 깨져 있으면 덮어쓰지 않고 오류를 낸다 (사람이 고치던 파일을 날리지 않게).
 */

type McpFile = { mcpServers?: Record<string, Record<string, unknown>> } & Record<string, unknown>;

export function parseMcpFile(text: string | undefined): McpFile {
  if (text === undefined || !text.trim()) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("mcp.json이 객체가 아닙니다");
  return parsed as McpFile;
}

export function serverViews(file: McpFile): McpServerView[] {
  return Object.entries(file.mcpServers ?? {}).map(([name, entry]) => {
    const url = typeof entry.url === "string" ? entry.url : undefined;
    const command = typeof entry.command === "string" ? entry.command : "";
    const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
    return {
      name,
      kind: url ? "url" : "command",
      target: url ?? [command, ...args].join(" "),
      enabled: entry.enabled !== false,
      ...(typeof entry.description === "string" ? { description: entry.description } : {}),
      hasSecrets: Boolean(entry.env || entry.headers),
    };
  });
}

/** 미리 정한 서버를 넣는다. 키가 필요한 서버는 env에 키를 넣는다. 같은 이름이 있으면 바꾼다 */
export function withPreset(file: McpFile, preset: McpPreset, key?: string): McpFile {
  if (preset.keyEnv && !key?.trim()) throw new Error(`${preset.label}에는 API 키가 필요합니다`);
  const entry: Record<string, unknown> = { ...preset.entry };
  if (preset.keyEnv && key) entry.env = { [preset.keyEnv]: key.trim() };
  return { ...file, mcpServers: { ...file.mcpServers, [preset.name]: entry } };
}

export function withEnabled(file: McpFile, name: string, enabled: boolean): McpFile {
  const entry = file.mcpServers?.[name];
  if (!entry) throw new Error(`그런 서버가 없습니다: ${name}`);
  const next = { ...entry };
  // Pi 기본값이 켜짐이라 켤 때는 칸을 지운다
  if (enabled) delete next.enabled;
  else next.enabled = false;
  return { ...file, mcpServers: { ...file.mcpServers, [name]: next } };
}

export function withoutServer(file: McpFile, name: string): McpFile {
  if (!validServerName(name)) throw new Error(`서버 이름이 올바르지 않습니다: ${name}`);
  const { [name]: _removed, ...rest } = file.mcpServers ?? {};
  return { ...file, mcpServers: rest };
}

export async function readMcpFile(path: string): Promise<McpFile> {
  let text: string | undefined;
  try {
    text = await readFile(path, "utf8");
  } catch {
    text = undefined;
  }
  return parseMcpFile(text);
}

/** 임시 파일에 쓴 뒤 바꿔 끼운다 (쓰다 만 파일이 남지 않게) */
export async function writeMcpFile(path: string, file: McpFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

export async function updateMcpFile(path: string, change: (file: McpFile) => McpFile): Promise<McpServerView[]> {
  const next = change(await readMcpFile(path));
  await writeMcpFile(path, next);
  return serverViews(next);
}
