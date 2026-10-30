import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskRecord } from "./types";

export type { TaskRecord, TaskStatus } from "./types";

/**
 * 작업 기록 (설계 DESIGN-AGENT.md §3, §4). 작업 하나 = tasks/<id>.json.
 * 앱의 작업 목록과 예약 실행 결과도 이 파일을 읽는다.
 */

export function tasksDir(dataDir: string): string {
  return join(dataDir, "tasks");
}

export async function saveTask(dir: string, task: TaskRecord): Promise<void> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${task.id}.json`);
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(task, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

/** 최근 것부터 */
export async function loadTasks(dir: string): Promise<TaskRecord[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const tasks: TaskRecord[] = [];
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    try {
      tasks.push(JSON.parse(await readFile(join(dir, name), "utf8")) as TaskRecord);
    } catch {
      // 쓰는 중이거나 깨진 파일은 건너뛴다
    }
  }
  return tasks.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** 시간이 드러나는 짧은 id (예: t-20261029-134210-ab) */
export function newTaskId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `t-${stamp}-${Math.random().toString(36).slice(2, 4)}`;
}
