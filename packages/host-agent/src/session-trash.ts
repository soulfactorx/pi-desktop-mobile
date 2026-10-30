import { mkdir, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { StoredDeleteResult, TrashItem } from "@pi-desktop/host-protocol";
import { movePath } from "./import-manage";

/**
 * 세션 휴지통 (설계 DESIGN-APPS.md §3.2).
 *
 * 지운 세션 파일은 바로 지우지 않고 데몬 홈의 `session-trash/`로 옮긴다. 옆에 `<파일>.meta.json`으로
 * 원래 자리와 지운 시각을 적어 되살릴 수 있게 한다. "비우기"를 해야 정말 지운다.
 * 예전 삭제는 `session-backups/deleted/`에 메타 없이 옮겼다. 그것도 휴지통에 보이고, 원래 자리는
 * 세션 헤더의 cwd로 Pi 기본 규칙(`<Pi 설정 폴더>/sessions/--<폴더>--/`)을 따라 계산한다.
 * 다른 파일을 건드리지 않도록 확장자가 .jsonl이고 첫 줄이 Pi 세션 헤더인 파일만 다룬다.
 */

const META_SUFFIX = ".meta.json";
const FIRST_MESSAGE_MAX = 200;

export function trashDirs(home: string) {
  return { trash: join(home, "session-trash"), legacy: join(home, "session-backups", "deleted") };
}

interface TrashMeta {
  originalPath: string;
  deletedAt: number;
}

/** 세션 파일을 휴지통으로 옮긴다. 파일이 아직 없으면(메시지를 주고받기 전) 옮길 것이 없으므로 그대로 돌려준다 */
export async function moveToTrash(path: string, home: string, now = new Date()): Promise<StoredDeleteResult> {
  if (!path.toLowerCase().endsWith(".jsonl")) throw new Error(`세션 파일(.jsonl)만 지울 수 있습니다: ${path}`);
  const info = await stat(path).catch(() => undefined);
  if (!info) return { path };
  if (!info.isFile()) throw new Error(`파일이 아닙니다: ${path}`);
  if (!(await readHeader(path))) throw new Error(`Pi 세션 파일이 아닙니다: ${path}`);
  const { trash } = trashDirs(home);
  await mkdir(trash, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  const id = `${stamp}-${basename(path)}`;
  const target = join(trash, id);
  const meta: TrashMeta = { originalPath: path, deletedAt: now.getTime() };
  await writeFile(`${target}${META_SUFFIX}`, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  await movePath(path, target);
  return { path, backup: target, trashId: id };
}

/** Pi 기본 세션 폴더 규칙 (Pi session-manager의 getDefaultSessionDirPath와 같음) */
export function defaultSessionPath(piAgentDir: string, cwd: string, fileName: string): string {
  const safe = `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(piAgentDir, "sessions", safe, fileName);
}

/** 예전 백업 이름(`<YYYYMMDD-HHMMSS>-<원래 이름>`)에서 원래 이름과 지운 시각을 꺼낸다 */
function parseStamped(id: string): { fileName: string; deletedAt?: number } {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(.+)$/.exec(id);
  if (!match) return { fileName: id };
  const [, y, mo, d, h, mi, s, rest] = match;
  return { fileName: rest!, deletedAt: Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) };
}

/** 휴지통 목록 (최근에 지운 것부터). piAgentDir는 예전 백업의 원래 자리를 계산할 때 쓴다 */
export async function listTrash(home: string, piAgentDir: string): Promise<TrashItem[]> {
  const { trash, legacy } = trashDirs(home);
  const items: TrashItem[] = [];
  for (const [dir, isLegacy] of [
    [trash, false],
    [legacy, true],
  ] as const) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const id of names) {
      if (!id.toLowerCase().endsWith(".jsonl")) continue;
      const item = await readItem(dir, id, isLegacy, piAgentDir).catch(() => undefined);
      if (item) items.push(item);
    }
  }
  return items.sort((a, b) => b.deletedAt - a.deletedAt);
}

async function readItem(dir: string, id: string, legacy: boolean, piAgentDir: string): Promise<TrashItem | undefined> {
  const path = join(dir, id);
  const info = await stat(path);
  if (!info.isFile()) return undefined;
  const summary = summarize(await readFile(path, "utf8"));
  if (!summary) return undefined;
  const meta = legacy ? undefined : await readMeta(path);
  const stamped = parseStamped(id);
  const originalPath = meta?.originalPath ?? defaultSessionPath(piAgentDir, summary.cwd, stamped.fileName);
  const item: TrashItem = {
    id,
    originalPath,
    deletedAt: meta?.deletedAt ?? stamped.deletedAt ?? info.mtimeMs,
    sessionId: summary.sessionId,
    cwd: summary.cwd,
    firstMessage: summary.firstMessage,
    size: info.size,
  };
  if (summary.name) item.name = summary.name;
  if (legacy) item.legacy = true;
  return item;
}

/** 휴지통 항목을 원래 자리로 되살린다. 그 자리에 이미 파일이 있으면 덮어쓰지 않는다 */
export async function restoreFromTrash(home: string, id: string, piAgentDir: string): Promise<string> {
  const found = await findItem(home, id);
  const item = await readItem(found.dir, id, found.legacy, piAgentDir);
  if (!item) throw new Error(`휴지통에 없는 세션입니다: ${id}`);
  if (await stat(item.originalPath).catch(() => undefined)) {
    throw new Error(`원래 자리에 이미 파일이 있습니다: ${item.originalPath}`);
  }
  await mkdir(dirname(item.originalPath), { recursive: true });
  await movePath(join(found.dir, id), item.originalPath);
  await rm(`${join(found.dir, id)}${META_SUFFIX}`, { force: true });
  return item.originalPath;
}

/** 휴지통을 비운다. ids가 없으면 전부 지운다 */
export async function emptyTrash(home: string, ids?: string[]): Promise<number> {
  const { trash, legacy } = trashDirs(home);
  const targets: Array<{ dir: string; id: string }> = [];
  if (ids) {
    for (const id of ids) {
      const found = await findItem(home, id);
      targets.push({ dir: found.dir, id });
    }
  } else {
    for (const dir of [trash, legacy]) {
      const names = await readdir(dir).catch(() => [] as string[]);
      for (const id of names) if (id.toLowerCase().endsWith(".jsonl")) targets.push({ dir, id });
    }
  }
  for (const { dir, id } of targets) {
    await rm(join(dir, id), { force: true });
    await rm(`${join(dir, id)}${META_SUFFIX}`, { force: true });
  }
  return targets.length;
}

/** id가 휴지통 안의 파일 이름인지 확인하고 어느 폴더에 있는지 찾는다 (경로를 벗어나는 id는 거절) */
async function findItem(home: string, id: string): Promise<{ dir: string; legacy: boolean }> {
  if (!id || id !== basename(id) || id.includes(sep) || id.includes("/") || !id.toLowerCase().endsWith(".jsonl")) {
    throw new Error(`잘못된 휴지통 항목입니다: ${id}`);
  }
  const { trash, legacy } = trashDirs(home);
  for (const [dir, isLegacy] of [
    [trash, false],
    [legacy, true],
  ] as const) {
    if (await stat(join(dir, id)).catch(() => undefined)) return { dir, legacy: isLegacy };
  }
  throw new Error(`휴지통에 없는 세션입니다: ${id}`);
}

async function readMeta(path: string): Promise<TrashMeta | undefined> {
  try {
    const parsed = JSON.parse(await readFile(`${path}${META_SUFFIX}`, "utf8")) as Partial<TrashMeta>;
    if (typeof parsed.originalPath !== "string" || typeof parsed.deletedAt !== "number") return undefined;
    return { originalPath: parsed.originalPath, deletedAt: parsed.deletedAt };
  } catch {
    return undefined;
  }
}

/** 첫 줄이 Pi 세션 헤더인지 (파일 전체를 읽지 않고 앞부분만 본다) */
async function readHeader(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const first = buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0] ?? "";
    try {
      return (JSON.parse(first) as { type?: unknown }).type === "session";
    } catch {
      return false;
    }
  } finally {
    await handle.close();
  }
}

type Part = { type?: string; text?: string };

/** 세션 파일에서 목록에 보일 것만 꺼낸다: 헤더의 id·cwd, 마지막 이름, 첫 사용자 메시지. 헤더가 아니면 undefined */
export function summarize(content: string): { sessionId: string; cwd: string; name?: string; firstMessage: string } | undefined {
  const lines = content.split("\n");
  let header: { id?: unknown; cwd?: unknown; type?: unknown };
  try {
    header = JSON.parse(lines[0] ?? "") as typeof header;
  } catch {
    return undefined;
  }
  if (header.type !== "session") return undefined;
  let name: string | undefined;
  let firstMessage = "";
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; name?: string; message?: { role?: string; content?: unknown } };
      if (entry.type === "session_info" && typeof entry.name === "string") name = entry.name;
      if (!firstMessage && entry.type === "message" && entry.message?.role === "user") {
        const c = entry.message.content;
        const text = typeof c === "string" ? c : Array.isArray(c) ? (c as Part[]).filter((p) => p.type === "text").map((p) => p.text ?? "").join(" ") : "";
        firstMessage = text.trim().slice(0, FIRST_MESSAGE_MAX);
      }
    } catch {
      // 깨진 줄은 건너뛴다
    }
  }
  const result: { sessionId: string; cwd: string; name?: string; firstMessage: string } = {
    sessionId: typeof header.id === "string" ? header.id : "",
    cwd: typeof header.cwd === "string" ? header.cwd : "",
    firstMessage,
  };
  if (name) result.name = name;
  return result;
}
