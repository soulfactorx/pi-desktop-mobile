import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ChatLine } from "./shared";

/**
 * Mate 대화 기록(chat.jsonl)과 대화 한 차례의 할 일 목록 (설계 DESIGN-MATE.md §13).
 * 둘 다 한 줄씩 추가만 하므로 여러 곳(앱·실행기·Pi 확장)이 함께 써도 줄이 섞이지 않는다.
 */

export async function readChat(path: string): Promise<ChatLine[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const lines: ChatLine[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const line = JSON.parse(raw) as ChatLine;
      if (line && typeof line.id === "string" && typeof line.text === "string") lines.push(line);
    } catch {
      // 쓰는 도중 끊긴 줄은 건너뛴다
    }
  }
  return lines;
}

export async function appendChat(path: string, line: Omit<ChatLine, "id" | "at"> & { id?: string; at?: number }): Promise<ChatLine> {
  const full: ChatLine = { id: line.id ?? randomUUID(), at: line.at ?? Date.now(), ...line } as ChatLine;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(full)}\n`, "utf8");
  return full;
}

/** 아직 답하지 않은 같은 질문이 최근(하루)에 있으면 다시 묻지 않는다 */
export async function appendChatQuestion(
  path: string,
  q: { text: string; options?: string[]; dutyId?: string; runId?: string; cwd?: string; permission?: ChatLine["permission"] },
  now = Date.now(),
): Promise<boolean> {
  const lines = await readChat(path);
  const norm = (s: string) => s.trim().replace(/\s+/g, " ");
  const answered = new Set(lines.filter((l) => l.answerTo).map((l) => l.answerTo));
  const dup = lines.some((l) => l.kind === "question" && !answered.has(l.id) && now - l.at < 24 * 3_600_000 && norm(l.text) === norm(q.text));
  if (dup) return false;
  await appendChat(path, { role: "mate", kind: "question", ...q, text: q.text.trim(), at: now });
  return true;
}

/** mate_do가 남기는 할 일 한 줄 */
export async function appendChatAction(path: string, action: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(action)}\n`, "utf8");
}

export async function readChatActions(path: string): Promise<Array<Record<string, unknown>>> {
  try {
    return (await readFile(path, "utf8"))
      .split("\n")
      .filter((l) => l.trim())
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}
