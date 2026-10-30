import { TYPE_LABEL, type KnowledgeEntry } from "./types";

/**
 * 이번 요청에 실을 지식을 고른다 (desktop-agent buildMemoryContext). 파일·Pi에 손대지 않는 순수 로직이다.
 *
 * 세 부분으로 싣는다:
 * 1. 전체 목록 — 항목마다 한 줄(종류·제목·id). 모델이 무엇이 있는지 알고 필요하면 memory_read로 본문을 읽는다
 * 2. 고정 항목 — 본문 전체
 * 3. 관련 항목 — 요청과 겹치는 것 몇 개의 본문
 * 예산(글자 수)을 넘지 않게 목록·본문 길이·개수를 줄인다. 좁은 창의 로컬 모델에서 지식이 대화를 밀어내면 안 된다.
 * 겹침은 글자 2-gram으로 잰다. 한국어는 조사가 붙어 낱말이 그대로 맞지 않으므로("커밋 메시지" ↔ "커밋메시지는") 낱말 비교보다 낫다.
 */

function bigrams(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ");
  const grams = new Set<string>();
  for (const word of normalized.split(" ")) {
    for (let i = 0; i + 2 <= word.length; i++) grams.add(word.slice(i, i + 2));
  }
  return grams;
}

/**
 * 0~1. 겹친 2-gram 수를 둘 중 짧은 쪽으로 나눈다. 우연히 한 조각만 겹친 것은 세지 않는다.
 */
export function overlap(text: string, prompt: string): number {
  const mine = bigrams(text);
  const theirs = bigrams(prompt);
  if (mine.size === 0 || theirs.size === 0) return 0;
  let hit = 0;
  for (const gram of mine) if (theirs.has(gram)) hit++;
  return hit < 2 ? 0 : hit / Math.min(mine.size, theirs.size);
}

/** 항목이 요청과 얼마나 관련 있는가. 제목·태그를 본문보다 무겁게 본다 */
export function relevance(entry: KnowledgeEntry, prompt: string): number {
  return Math.max(overlap(`${entry.title} ${entry.tags.join(" ")}`, prompt), overlap(entry.content, prompt) * 0.8);
}

/** 이보다 관련이 작으면 본문을 싣지 않는다 */
const MIN_RELEVANCE = 0.2;

export interface KnowledgeSection {
  /** 시스템 프롬프트 섹션 본문. 실을 것이 없으면 undefined */
  text?: string;
  /** 본문까지 실린 항목 (회상 횟수를 올린다) */
  injected: string[];
}

const label = (e: KnowledgeEntry) => `[${TYPE_LABEL[e.type]}]${e.unverified ? "[확인 안 됨]" : ""}`;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…(memory_read로 전문)` : text);

export function buildKnowledgeSection(entries: KnowledgeEntry[], prompt: string, budgetChars: number): KnowledgeSection {
  const active = entries.filter((e) => e.status === "active");
  if (active.length === 0) return { injected: [] };
  // 넉넉하면 목록 1/4, 본문 하나당 1,500자, 관련 5개. 좁으면 비율대로 줄인다
  const indexBudget = Math.floor(budgetChars / 4);
  const bodyChars = Math.max(200, Math.min(1500, Math.floor(budgetChars / 5)));
  const topK = Math.max(1, Math.min(5, Math.floor(budgetChars / 800)));

  const index: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const e of active) {
    const line = `- ${label(e)} ${e.title} (id: ${e.id})`;
    if (used + line.length > indexBudget) {
      omitted++;
      continue;
    }
    index.push(line);
    used += line.length;
  }

  const injected: string[] = [];
  const bodies: string[] = [];
  let bodyUsed = 0;
  const addBody = (e: KnowledgeEntry, heading: string) => {
    const body = `### ${heading} ${label(e)} ${e.title} (id: ${e.id})\n${clip(e.content, bodyChars)}`;
    if (bodyUsed + body.length > budgetChars - used) return;
    bodies.push(body);
    bodyUsed += body.length;
    injected.push(e.id);
  };
  for (const e of active.filter((x) => x.pinned)) addBody(e, "고정");
  active
    .filter((e) => !e.pinned)
    .map((e) => ({ e, score: relevance(e, prompt) }))
    .filter((s) => s.score >= MIN_RELEVANCE)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .forEach(({ e }) => addBody(e, "관련"));

  const text = [
    "지식베이스: 사용자와 지난 작업에 대해 알고 있는 것이다. 지금 요청과 관련 있을 때만 따르고, 틀렸으면 memory_save로 고치거나 memory_forget으로 보관하라.",
    "[확인 안 됨]은 도구로 확인하지 않은 대화에서 나온 것이니 근거로 삼기 전에 확인하라. 목록의 본문이 필요하면 memory_read(id)로 읽어라.",
    `## 목록 (${active.length}개)`,
    ...index,
    ...(omitted ? [`- …그 밖에 ${omitted}개 (memory_search로 찾기)`] : []),
    ...(bodies.length ? ["## 본문", ...bodies] : []),
  ].join("\n");
  return { text, injected };
}
