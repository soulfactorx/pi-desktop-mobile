import { randomUUID } from "node:crypto";
import { appendFile, cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { MatePaths } from "./paths";
import type { MateTrashItem, TrashKind } from "./types";

export type { MateTrashItem, TrashKind };

/**
 * Mate 휴지통 (설계 DESIGN-APPS.md §3.2, §6 D2). 지운 임무·실행 기록·대화를 바로 지우지 않고
 * `<Mate 홈>/trash/<항목 id>/`로 옮긴다. 항목의 meta.json에 원래 자리를 적어 되살릴 수 있게 하고, "비우기"를 해야 정말 지운다.
 * 200개 넘는 실행 기록 정리도 여기를 거친다.
 */

interface StoredFile {
  /** 원래 자리 */
  original: string;
  /** 항목 폴더 안 이름 */
  stored: string;
  /** 되살릴 때 원래 자리에 파일이 있으면 줄 단위로 합친다 (대화 기록) */
  merge?: boolean;
}

interface TrashMeta {
  kind: TrashKind;
  title: string;
  detail?: string;
  deletedAt: number;
  files: StoredFile[];
}

const META = "meta.json";

function stampOf(now: number): string {
  return new Date(now).toISOString().replace(/[-:.]/g, "").replace("T", "-").slice(0, 15);
}

async function move(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    // 다른 드라이브로는 옮기지 못하므로 복사하고 지운다 (스킬은 폴더)
    await cp(from, to, { recursive: true });
    await rm(from, { recursive: true, force: true });
  }
}

const exists = (path: string) => stat(path).then(() => true, () => false);

/**
 * 파일들을 한 항목으로 휴지통에 옮긴다. 없는 파일은 건너뛰고, 옮길 것이 하나도 없으면 아무것도 만들지 않는다.
 */
export async function moveToTrash(
  paths: MatePaths,
  item: { kind: TrashKind; title: string; detail?: string },
  files: Array<{ path: string; merge?: boolean }>,
  now = Date.now(),
): Promise<MateTrashItem | undefined> {
  const present: Array<{ path: string; merge?: boolean }> = [];
  for (const file of files) if (await exists(file.path)) present.push(file);
  if (present.length === 0) return undefined;
  const id = `${stampOf(now)}-${item.kind}-${randomUUID().slice(0, 6)}`;
  const dir = join(paths.trash, id);
  await mkdir(dir, { recursive: true });
  const stored: StoredFile[] = present.map((file, i) => ({
    original: file.path,
    stored: `${i}-${basename(file.path)}`,
    ...(file.merge ? { merge: true } : {}),
  }));
  const meta: TrashMeta = { kind: item.kind, title: item.title, ...(item.detail ? { detail: item.detail } : {}), deletedAt: now, files: stored };
  // 메타를 먼저 써야 옮기다 멈춰도 무엇이 어디서 왔는지 남는다
  await writeFile(join(dir, META), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  for (const file of stored) await move(file.original, join(dir, file.stored));
  return { id, kind: meta.kind, title: meta.title, ...(meta.detail ? { detail: meta.detail } : {}), deletedAt: now, files: stored.length };
}

async function readMeta(dir: string): Promise<TrashMeta | undefined> {
  try {
    const meta = JSON.parse(await readFile(join(dir, META), "utf8")) as Partial<TrashMeta>;
    if (!meta.kind || typeof meta.title !== "string" || typeof meta.deletedAt !== "number" || !Array.isArray(meta.files)) return undefined;
    return meta as TrashMeta;
  } catch {
    return undefined;
  }
}

/** 휴지통 목록 (최근에 지운 것부터) */
export async function listTrash(paths: MatePaths): Promise<MateTrashItem[]> {
  let names: string[];
  try {
    names = await readdir(paths.trash);
  } catch {
    return [];
  }
  const items: MateTrashItem[] = [];
  for (const id of names) {
    const meta = await readMeta(join(paths.trash, id));
    if (!meta) continue;
    items.push({ id, kind: meta.kind, title: meta.title, ...(meta.detail ? { detail: meta.detail } : {}), deletedAt: meta.deletedAt, files: meta.files.length });
  }
  return items.sort((a, b) => b.deletedAt - a.deletedAt);
}

function itemDir(paths: MatePaths, id: string): string {
  if (!/^[0-9A-Za-z-]+$/.test(id)) throw new Error(`잘못된 휴지통 항목입니다: ${id}`);
  return join(paths.trash, id);
}

/**
 * 항목을 원래 자리로 되살린다. 합치지 않는 파일의 자리에 이미 파일이 있으면 아무것도 옮기지 않고 거절한다
 * (예: 같은 id의 임무를 다시 만들었을 때). 대화 기록은 지금 기록과 시각 순으로 합친다.
 */
export async function restoreTrash(paths: MatePaths, id: string): Promise<MateTrashItem> {
  const dir = itemDir(paths, id);
  const meta = await readMeta(dir);
  if (!meta) throw new Error(`휴지통에 없는 항목입니다: ${id}`);
  for (const file of meta.files) {
    if (!file.merge && (await exists(file.original))) throw new Error(`원래 자리에 이미 파일이 있습니다: ${file.original}`);
  }
  for (const file of meta.files) {
    const from = join(dir, file.stored);
    if (!(await exists(from))) continue;
    if (file.merge && (await exists(file.original))) await mergeJsonl(from, file.original);
    else await move(from, file.original);
  }
  await rm(dir, { recursive: true, force: true });
  return { id, kind: meta.kind, title: meta.title, deletedAt: meta.deletedAt, files: meta.files.length };
}

/** 휴지통을 비운다. ids가 없으면 전부. 정말 지운 항목 수 */
export async function emptyTrash(paths: MatePaths, ids?: string[]): Promise<number> {
  const targets = ids ?? (await listTrash(paths)).map((i) => i.id);
  for (const id of targets) await rm(itemDir(paths, id), { recursive: true, force: true });
  return targets.length;
}

/**
 * 옛 JSONL 기록(from)을 지금 기록(to)에 합친다. 같은 id 줄은 한 번만, 시각(at) 순으로 다시 쓴다.
 * 지금 기록에 쓰는 사이 실행기가 덧붙인 줄을 잃지 않도록, 다시 쓴 뒤에 생긴 줄은 이어 붙인다.
 */
async function mergeJsonl(from: string, to: string): Promise<void> {
  const parse = (text: string) =>
    text
      .split("\n")
      .filter((l) => l.trim())
      .flatMap((raw) => {
        try {
          return [{ raw, line: JSON.parse(raw) as { id?: string; at?: number } }];
        } catch {
          return [];
        }
      });
  const before = await readFile(to, "utf8");
  const old = parse(await readFile(from, "utf8"));
  const current = parse(before);
  const seen = new Set<string>();
  const merged = [...old, ...current]
    .filter(({ line }) => {
      if (!line.id) return true;
      if (seen.has(line.id)) return false;
      seen.add(line.id);
      return true;
    })
    .sort((a, b) => (a.line.at ?? 0) - (b.line.at ?? 0));
  const temp = `${to}.${process.pid}.tmp`;
  await writeFile(temp, merged.map((m) => `${m.raw}\n`).join(""), "utf8");
  const after = await readFile(to, "utf8");
  await rename(temp, to);
  if (after.length > before.length) await appendFile(to, after.slice(before.length), "utf8");
  await rm(from, { force: true });
}
