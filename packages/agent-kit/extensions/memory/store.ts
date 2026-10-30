import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MEMORY_TYPES, TYPE_LABEL, type BulkAction, type EntryInput, type KnowledgeEntry, type KnowledgeStats, type MemoryType, type ReviewItem } from "./types";

export * from "./types";

/**
 * 지식베이스 저장소 (설계 DESIGN-AGENT.md §4 "지식베이스"). 항목 하나 = memory/<id>.md (frontmatter + Markdown 본문).
 *
 * desktop-agent는 JSON 한 파일(memories.json)이었지만, Pi의 "파일이 곧 인터페이스" 원칙대로 사람이 직접 읽고 고칠 수 있는
 * 파일로 둔다. 지운 항목은 forgotten/으로 옮겨 되돌릴 수 있다. 회상 횟수는 회상할 때마다 항목 파일을 다시 쓰지 않도록
 * recall-stats.json에 따로 둔다.
 *
 * 예전 형식(kind: preference·fact·lesson, 본문 한 줄)도 읽는다: preference는 고정된 user, fact는 user, lesson은 lesson.
 */

export function memoryDir(dataDir: string): string {
  return join(dataDir, "memory");
}

const STATS_FILE = "recall-stats.json";
type RecallStats = Record<string, { count: number; last: string }>;

// ── 파일 형식 ──

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const cleanTag = (tag: string) => oneLine(tag).replace(/,/g, "").slice(0, 40);

export function normalizeTags(tags: string[] | undefined): string[] {
  return [...new Set((tags ?? []).map(cleanTag).filter(Boolean))];
}

export function formatEntry(entry: KnowledgeEntry): string {
  const lines = [
    `type: ${entry.type}`,
    `title: ${oneLine(entry.title)}`,
    ...(entry.tags.length ? [`tags: ${entry.tags.join(", ")}`] : []),
    ...(entry.pinned ? ["pinned: true"] : []),
    ...(entry.status === "archived" ? ["status: archived"] : []),
    `origin: ${entry.origin}`,
    ...(entry.unverified ? ["unverified: true"] : []),
    `created: ${entry.created}`,
    `updated: ${entry.updated}`,
    ...(entry.reviewed ? [`reviewed: ${entry.reviewed}`] : []),
    ...(entry.source ? [`source: ${oneLine(entry.source)}`] : []),
  ];
  return `---\n${lines.join("\n")}\n---\n${entry.content.trim()}\n`;
}

/** 파일 내용을 항목으로. 본문이 없으면 undefined. 예전 형식도 받는다 */
export function parseEntry(id: string, text: string): KnowledgeEntry | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return undefined;
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0) fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  const content = match[2]!.trim();
  if (!content) return undefined;
  // 예전 형식: kind만 있고 title이 없다
  const legacy = !fields.type && fields.kind !== undefined;
  const type: MemoryType = legacy
    ? fields.kind === "lesson"
      ? "lesson"
      : "user"
    : MEMORY_TYPES.includes(fields.type as MemoryType)
      ? (fields.type as MemoryType)
      : "reference";
  const created = fields.created ?? "";
  return {
    id,
    type,
    title: fields.title || oneLine(content).slice(0, 60),
    content,
    tags: normalizeTags(fields.tags?.split(",")),
    status: fields.status === "archived" ? "archived" : "active",
    pinned: fields.pinned === "true" || (legacy && fields.kind === "preference"),
    origin: fields.origin === "user" ? "user" : "agent",
    ...(fields.unverified === "true" ? { unverified: true } : {}),
    created,
    updated: fields.updated ?? created,
    ...(fields.reviewed ? { reviewed: fields.reviewed } : {}),
    ...(fields.source && fields.source !== "auto" ? { source: fields.source } : {}),
  };
}

// ── 읽기·쓰기 ──

async function readStats(dir: string): Promise<RecallStats> {
  try {
    return JSON.parse(await readFile(join(dir, STATS_FILE), "utf8")) as RecallStats;
  } catch {
    return {};
  }
}

async function writeEntry(dir: string, entry: KnowledgeEntry): Promise<void> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${entry.id}.md`);
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, formatEntry(entry), "utf8");
  await rename(temp, path);
}

/** 항목들 (기본은 보관한 것 빼고). 고정 먼저, 그다음 최근에 고친 순 */
export async function loadEntries(dir: string, options: { includeArchived?: boolean } = {}): Promise<KnowledgeEntry[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const stats = await readStats(dir);
  const entries: KnowledgeEntry[] = [];
  for (const name of names.filter((n) => n.endsWith(".md"))) {
    try {
      const entry = parseEntry(name.slice(0, -3), await readFile(join(dir, name), "utf8"));
      if (!entry || (!options.includeArchived && entry.status === "archived")) continue;
      const stat = stats[entry.id];
      entries.push(stat ? { ...entry, recallCount: stat.count, lastRecalledAt: stat.last } : entry);
    } catch {
      // 사람이 고치다 만 파일 하나 때문에 지식베이스 전체가 사라지면 안 된다
    }
  }
  return entries.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id));
}

export async function getEntry(dir: string, id: string): Promise<KnowledgeEntry | undefined> {
  if (!validId(id)) return undefined;
  try {
    return parseEntry(id, await readFile(join(dir, `${id}.md`), "utf8"));
  } catch {
    return undefined;
  }
}

const validId = (id: string) => /^[A-Za-z0-9_-]+$/.test(id);

/** 시간이 드러나는 짧은 id (예: 20261029-134210-a1b2) */
function newId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

export async function createEntry(
  dir: string,
  input: EntryInput & { origin?: KnowledgeEntry["origin"]; unverified?: boolean; source?: string },
  now = new Date(),
): Promise<KnowledgeEntry> {
  const title = oneLine(input.title);
  if (!title || !input.content.trim()) throw new Error("제목과 본문이 필요하다");
  const entry: KnowledgeEntry = {
    id: newId(now),
    type: input.type,
    title,
    content: input.content.trim(),
    tags: normalizeTags(input.tags),
    status: "active",
    pinned: input.pinned ?? false,
    origin: input.origin ?? "agent",
    ...(input.unverified ? { unverified: true } : {}),
    created: now.toISOString(),
    updated: now.toISOString(),
    ...(input.source ? { source: input.source } : {}),
  };
  await writeEntry(dir, entry);
  return entry;
}

/** 고친다. 없으면 undefined. 본문이 바뀌면 다시 점검받도록 확인 표시를 지운다 */
export async function updateEntry(
  dir: string,
  id: string,
  patch: Partial<Pick<KnowledgeEntry, "type" | "title" | "content" | "tags" | "pinned" | "status" | "unverified" | "origin">>,
  now = new Date(),
): Promise<KnowledgeEntry | undefined> {
  const current = await getEntry(dir, id);
  if (!current) return undefined;
  const next: KnowledgeEntry = {
    ...current,
    ...patch,
    ...(patch.title !== undefined ? { title: oneLine(patch.title) || current.title } : {}),
    ...(patch.content !== undefined ? { content: patch.content.trim() || current.content } : {}),
    ...(patch.tags ? { tags: normalizeTags(patch.tags) } : {}),
    updated: now.toISOString(),
  };
  if (patch.unverified === false) delete next.unverified;
  if (patch.content !== undefined && patch.content.trim() !== current.content) delete next.reviewed;
  await writeEntry(dir, next);
  return next;
}

/**
 * 같은 제목(보관 안 한 것)이 있으면 고치고, 없으면 새로 만든다. 모델이 같은 것을 여러 번 저장해 쌓이지 않게 한다.
 */
export async function upsertByTitle(
  dir: string,
  input: EntryInput & { origin?: KnowledgeEntry["origin"]; unverified?: boolean; source?: string },
  now = new Date(),
): Promise<{ entry: KnowledgeEntry; op: "create" | "update" }> {
  const title = oneLine(input.title).toLowerCase();
  const existing = (await loadEntries(dir)).find((e) => e.title.toLowerCase() === title);
  if (existing) {
    const entry = (await updateEntry(
      dir,
      existing.id,
      { type: input.type, content: input.content, ...(input.tags ? { tags: [...existing.tags, ...input.tags] } : {}), ...(input.unverified ? { unverified: true } : {}) },
      now,
    ))!;
    return { entry, op: "update" };
  }
  return { entry: await createEntry(dir, input, now), op: "create" };
}

/** 지운다. 파일은 forgotten/으로 옮겨 되돌릴 수 있게 한다. 없으면 false */
export async function deleteEntry(dir: string, id: string): Promise<boolean> {
  if (!validId(id)) return false;
  try {
    await mkdir(join(dir, "forgotten"), { recursive: true });
    await rename(join(dir, `${id}.md`), join(dir, "forgotten", `${id}.md`));
    return true;
  } catch {
    return false;
  }
}

export const archiveEntry = (dir: string, id: string, now = new Date()) => updateEntry(dir, id, { status: "archived" }, now);
export const markReviewed = (dir: string, id: string, now = new Date()) => updateEntry(dir, id, { unverified: false }, now).then(async (entry) => {
  if (!entry) return undefined;
  const reviewed = { ...entry, reviewed: now.toISOString() };
  await writeEntry(dir, reviewed);
  return reviewed;
});

/** 여러 항목에 한 번에. 바뀐 개수 */
export async function bulkUpdate(dir: string, ids: string[], action: BulkAction, tag?: string, now = new Date()): Promise<number> {
  let changed = 0;
  for (const id of ids) {
    const entry = await getEntry(dir, id);
    if (!entry) continue;
    if (action === "delete") {
      if (await deleteEntry(dir, id)) changed++;
      continue;
    }
    const patch: Parameters<typeof updateEntry>[2] =
      action === "archive"
        ? { status: "archived" }
        : action === "activate"
          ? { status: "active" }
          : action === "pin"
            ? { pinned: true }
            : action === "unpin"
              ? { pinned: false }
              : action === "addTag" && tag
                ? { tags: [...entry.tags, tag] }
                : action === "removeTag" && tag
                  ? { tags: entry.tags.filter((t) => t !== cleanTag(tag)) }
                  : {};
    if (Object.keys(patch).length === 0) continue;
    await updateEntry(dir, id, patch, now);
    changed++;
  }
  return changed;
}

/** 여러 항목을 하나로 합친다: 남길 항목에 나머지 본문(겹치지 않는 것)과 태그를 붙이고, 나머지는 지운다 */
export async function mergeEntries(dir: string, keepId: string, dropIds: string[], now = new Date()): Promise<KnowledgeEntry | undefined> {
  const keep = await getEntry(dir, keepId);
  if (!keep) return undefined;
  let content = keep.content;
  let tags = keep.tags;
  for (const id of dropIds.filter((d) => d !== keepId)) {
    const drop = await getEntry(dir, id);
    if (!drop) continue;
    if (!content.includes(drop.content)) content = `${content}\n\n---\n${drop.title === keep.title ? "" : `**${drop.title}**\n\n`}${drop.content}`;
    tags = [...tags, ...drop.tags];
    await deleteEntry(dir, id);
  }
  return updateEntry(dir, keepId, { content, tags }, now);
}

/** 프롬프트에 실린 항목의 회상 횟수를 올린다 */
export async function recordRecall(dir: string, ids: string[], now = new Date()): Promise<void> {
  if (ids.length === 0) return;
  const stats = await readStats(dir);
  for (const id of ids) stats[id] = { count: (stats[id]?.count ?? 0) + 1, last: now.toISOString() };
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, STATS_FILE), `${JSON.stringify(stats)}\n`, "utf8");
  } catch {
    // 회상 기록을 남기지 못해도 대화는 계속한다
  }
}

// ── 점검·통계·내보내기 ──

function bigrams(text: string): Set<string> {
  const grams = new Set<string>();
  for (const word of text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(" ")) {
    for (let i = 0; i + 2 <= word.length; i++) grams.add(word.slice(i, i + 2));
  }
  return grams;
}

/** 두 항목이 같은 것을 말하는지 (제목·태그의 2-gram 겹침, 0~1) */
export function similarity(a: Pick<KnowledgeEntry, "title" | "tags">, b: Pick<KnowledgeEntry, "title" | "tags">): number {
  const x = bigrams(`${a.title} ${a.tags.join(" ")}`);
  const y = bigrams(`${b.title} ${b.tags.join(" ")}`);
  if (x.size === 0 || y.size === 0) return 0;
  let hit = 0;
  for (const g of x) if (y.has(g)) hit++;
  return hit / Math.min(x.size, y.size);
}

const DUP_THRESHOLD = 0.7;
const STALE_DAYS = 30;

/**
 * 점검 대기함 (desktop-agent needsReview). 자동으로 쌓이는 지식의 문제는 "많다"가 아니라
 * "틀린 게 섞여 있는데 어느 것인지 모른다"이다. 사람이 볼 것만 골라 이유와 함께 보인다.
 * 확인한 것(reviewed)과 고정한 것은 다시 올리지 않는다.
 */
export function needsReview(entries: KnowledgeEntry[], now = new Date()): ReviewItem[] {
  const active = entries.filter((e) => e.status === "active" && !e.reviewed && !e.pinned);
  const items: ReviewItem[] = [];
  const paired = new Set<string>();
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i]!;
      const b = active[j]!;
      if (a.type !== b.type || paired.has(a.id) || paired.has(b.id) || similarity(a, b) < DUP_THRESHOLD) continue;
      paired.add(a.id).add(b.id);
      items.push({ kind: "duplicate", id: a.id, title: a.title, type: a.type, reason: "제목·태그가 크게 겹칩니다. 하나로 합칠 수 있습니다.", pairId: b.id, pairTitle: b.title });
    }
  }
  for (const e of active) {
    if (paired.has(e.id)) continue;
    const age = (now.getTime() - Date.parse(e.lastRecalledAt ?? e.created)) / 86_400_000;
    if (!(e.recallCount ?? 0) && age >= STALE_DAYS) {
      items.push({ kind: "stale", id: e.id, title: e.title, type: e.type, reason: `${Math.floor(age)}일 동안 한 번도 쓰이지 않았습니다.` });
    }
  }
  for (const e of active) {
    if (e.type === "lesson" && !e.content.includes("재발 방지")) {
      items.push({ kind: "malformed", id: e.id, title: e.title, type: e.type, reason: '교훈에 "재발 방지" 항목이 없습니다. 규칙이 없으면 같은 실수를 막지 못합니다.' });
    }
  }
  for (const e of active) {
    if (e.unverified) {
      items.push({ kind: "unverified", id: e.id, title: e.title, type: e.type, reason: "도구로 확인하지 않은 대화에서 저장됐습니다. 에이전트가 그냥 아는 대로 말한 내용일 수 있습니다." });
    }
  }
  return items;
}

export function knowledgeStats(all: KnowledgeEntry[]): KnowledgeStats {
  const active = all.filter((e) => e.status === "active");
  const byType = Object.fromEntries(MEMORY_TYPES.map((t) => [t, active.filter((e) => e.type === t).length])) as Record<MemoryType, number>;
  const tagCount = new Map<string, number>();
  for (const e of active) for (const t of e.tags) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
  return {
    active: active.length,
    archived: all.length - active.length,
    pinned: active.filter((e) => e.pinned).length,
    unverified: active.filter((e) => e.unverified).length,
    byType,
    tags: [...tagCount.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
  };
}

/** 한 파일로 읽을 수 있는 Markdown (종류별로) */
export function exportMarkdown(entries: KnowledgeEntry[], now = new Date()): string {
  const parts = [`# 지식베이스\n\n${now.toISOString().slice(0, 10)} 내보냄 · ${entries.length}개`];
  for (const type of MEMORY_TYPES) {
    const list = entries.filter((e) => e.type === type);
    if (list.length === 0) continue;
    parts.push(`## ${TYPE_LABEL[type]} (${list.length})`);
    for (const e of list) {
      const flags = [e.pinned && "고정", e.status === "archived" && "보관", e.unverified && "확인 안 됨"].filter(Boolean).join(", ");
      parts.push(`### ${e.title}${flags ? ` (${flags})` : ""}\n\n${e.tags.length ? `태그: ${e.tags.join(", ")}\n\n` : ""}${e.content}`);
    }
  }
  return `${parts.join("\n\n")}\n`;
}

// ── 설정 ──

/** 지식베이스 설정 파일 (사람이 고칠 수 있는 JSON). 지금은 자동 기억 켜기·끄기만 있다 */
export function memorySettingsFile(dir: string): string {
  return join(dir, "settings.json");
}

/** 턴이 끝난 뒤 자동으로 지식을 뽑는가. 파일이 없거나 읽지 못하면 켠 것으로 본다 */
export async function loadAutoLearn(dir: string): Promise<boolean> {
  try {
    const settings = JSON.parse(await readFile(memorySettingsFile(dir), "utf8")) as { autoLearn?: unknown };
    return settings.autoLearn !== false;
  } catch {
    return true;
  }
}

export async function saveAutoLearn(dir: string, on: boolean): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(memorySettingsFile(dir), `${JSON.stringify({ autoLearn: on }, null, 2)}\n`, "utf8");
}
