import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Schedule } from "./plan";

/** 예약 목록 파일. 사람이 읽고 고칠 수 있는 JSON 하나 (설계 DESIGN-AGENT.md §3) */
export function schedulesPath(dataDir: string): string {
  return join(dataDir, "schedules.json");
}

export async function loadSchedules(path: string): Promise<Schedule[]> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { schedules?: unknown };
    return Array.isArray(parsed.schedules) ? (parsed.schedules as Schedule[]) : [];
  } catch {
    return [];
  }
}

export async function saveSchedules(path: string, schedules: Schedule[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ schedules }, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

/**
 * 읽고-고치고-쓰기를 한 번에 하나씩 한다. 스케줄러 세션과 대화 세션이 같은 파일을 고칠 수 있어,
 * 같은 프로세스 안에서라도 겹치지 않게 줄을 세운다 (프로세스 사이 잠금은 없다 — 고치는 일이 드물다).
 */
let queue: Promise<unknown> = Promise.resolve();
export function updateSchedules(path: string, change: (schedules: Schedule[]) => Schedule[]): Promise<Schedule[]> {
  const next = queue.then(async () => {
    const updated = change(await loadSchedules(path));
    await saveSchedules(path, updated);
    return updated;
  });
  queue = next.catch(() => undefined);
  return next;
}

export function newScheduleId(now = new Date()): string {
  return `s-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 4)}`;
}
