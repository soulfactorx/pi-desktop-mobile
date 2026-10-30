import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BlockedCommand } from "./shared";

/**
 * 허용 목록에 없어 막힌 명령의 기록 (설계 DESIGN-MATE.md §4 "권한 요청").
 * mate-guard가 실행 중에 한 줄씩 남기고, 실행이 끝나면 실행기가 읽어 사용자에게 허용을 묻는다.
 */

export async function appendBlocked(path: string, entry: BlockedCommand): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
}

export async function readBlocked(path: string): Promise<BlockedCommand[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        const e = JSON.parse(l) as Partial<BlockedCommand>;
        return typeof e.name === "string" && typeof e.command === "string" ? [{ name: e.name, command: e.command, at: Number(e.at) || 0 }] : [];
      } catch {
        return [];
      }
    });
}
