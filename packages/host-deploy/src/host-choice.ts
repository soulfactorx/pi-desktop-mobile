import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SSH_PREFIX } from "./ssh";

export const LOCAL_HOST_ID = "local";
export const WSL_PREFIX = "wsl:";

/**
 * 지금 쓰는 호스트 (설계 DESIGN-APPS.md §6 D3, DESIGN-MATE-REMOTE.md §3.1). Agent·Mate는 한 번에 한 호스트에 붙는다.
 * 앱 userData의 JSON 파일에 호스트 id만 둔다. 없거나 깨졌으면 로컬.
 */

export function isHostId(id: unknown): id is string {
  if (typeof id !== "string") return false;
  if (id === LOCAL_HOST_ID) return true;
  const rest = id.startsWith(WSL_PREFIX) ? id.slice(WSL_PREFIX.length) : id.startsWith(SSH_PREFIX) ? id.slice(SSH_PREFIX.length) : "";
  return rest.trim().length > 0;
}

export function readHostChoice(file: string): string {
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as { current?: unknown };
    return isHostId(data.current) ? data.current : LOCAL_HOST_ID;
  } catch {
    return LOCAL_HOST_ID;
  }
}

export function writeHostChoice(file: string, hostId: string): void {
  if (!isHostId(hostId)) throw new Error(`알 수 없는 호스트입니다: ${hostId}`);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ current: hostId }, null, 2)}\n`);
  renameSync(tmp, file);
}
