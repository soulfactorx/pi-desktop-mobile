import type { StoredSession } from "@pi-desktop/host-protocol";

/** 검색에 쓰는 세션 정보 (지난 대화 목록의 한 줄) */
export type SearchableSession = Pick<StoredSession, "path" | "name" | "firstMessage">;

/**
 * 지난 대화 검색 (설계 DESIGN-AGENT.md §4 "지난 대화"). 목록은 데몬의 session.history(Pi SDK)가 주고, 본문은 그 호스트의 데몬이 app-api로 읽는다 (D4).
 * 여기서는 세션 파일 본문(사용자·에이전트의 글)에서 검색어를 찾는다. 따로 색인을 만들지 않는다.
 * 파일 읽기는 밖에서 넘겨받아 테스트할 수 있게 한다.
 */

export interface HistoryHit {
  path: string;
  /** 처음 찾은 곳 앞뒤 (한 줄) */
  snippet: string;
}

type Part = { type?: string; text?: string };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Part[])
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join(" ");
}

/** 세션 파일에서 사람이 읽는 글만 꺼낸다 (사용자·에이전트 메시지, 세션 이름). 도구 결과·사고는 뺀다 */
export function sessionText(jsonl: string): string {
  const parts: string[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; name?: string; message?: { role?: string; content?: unknown } };
      if (entry.type === "session_info" && entry.name) parts.push(entry.name);
      const role = entry.message?.role;
      if (entry.type === "message" && (role === "user" || role === "assistant")) {
        const text = textOf(entry.message?.content).trim();
        if (text) parts.push(text);
      }
    } catch {
      // 깨진 줄은 건너뛴다
    }
  }
  return parts.join("\n");
}

/** 검색어를 낱말로 나눈다. 모든 낱말이 들어 있어야 찾은 것으로 본다 */
export function queryTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

export function snippetAround(text: string, term: string, radius = 40): string {
  const flat = text.replace(/\s+/g, " ");
  const at = flat.toLowerCase().indexOf(term);
  if (at < 0) return flat.slice(0, radius * 2);
  const start = Math.max(0, at - radius);
  const end = Math.min(flat.length, at + term.length + radius);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

/** 이름·첫 메시지·본문에서 검색어를 모두 담은 세션을 최근 순서 그대로 돌려준다 */
export async function searchSessions(sessions: SearchableSession[], query: string, read: (path: string) => Promise<string>): Promise<HistoryHit[]> {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const hits: HistoryHit[] = [];
  for (const session of sessions) {
    let body: string;
    try {
      body = sessionText(await read(session.path));
    } catch {
      continue;
    }
    const text = `${session.name ?? ""}\n${session.firstMessage}\n${body}`;
    const lower = text.toLowerCase();
    if (!terms.every((t) => lower.includes(t))) continue;
    // 앞뒤 글은 본문에서 고른다 (이름·첫 메시지는 목록에 이미 보인다). 본문에 없을 때만 전체에서
    const source = body.toLowerCase().includes(terms[0]!) ? body : text;
    hits.push({ path: session.path, snippet: snippetAround(source, terms[0]!) });
  }
  return hits;
}
