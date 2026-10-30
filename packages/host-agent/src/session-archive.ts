import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * 세션 아카이브 (설계 DESIGN-APPS.md §3.2). 파일은 그대로 두고 앱 목록에서만 숨긴다.
 * 데몬 홈의 `archive.json`에 세션 파일 경로와 아카이브한 시각을 적는다. 앱마다 데몬 홈이 다르므로 앱마다 따로다.
 * Pi의 파일을 옮기지 않으므로 터미널 pi의 `/resume`에는 계속 보이고 분기·이어 열기가 깨지지 않는다.
 */

interface ArchiveFile {
  sessions: Record<string, number>;
}

export function archivePath(home: string): string {
  return join(home, "archive.json");
}

export async function loadArchive(home: string): Promise<Record<string, number>> {
  try {
    const parsed = JSON.parse(await readFile(archivePath(home), "utf8")) as Partial<ArchiveFile>;
    if (!parsed.sessions || typeof parsed.sessions !== "object") return {};
    return Object.fromEntries(Object.entries(parsed.sessions).filter(([, at]) => typeof at === "number"));
  } catch {
    // 없거나 깨진 파일은 아카이브 없음으로 본다
    return {};
  }
}

/** 데몬 안에서 차례로 고치도록 한 줄로 세운다 (같은 파일을 동시에 고치면 앞의 변경이 사라진다) */
let queue: Promise<unknown> = Promise.resolve();

export function setArchived(home: string, path: string, archived: boolean, now = Date.now()): Promise<void> {
  const run = queue.then(async () => {
    const sessions = await loadArchive(home);
    if (archived) sessions[path] = now;
    else delete sessions[path];
    const file = archivePath(home);
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify({ sessions } satisfies ArchiveFile, null, 2)}\n`, "utf8");
    await rename(temp, file);
  });
  queue = run.catch(() => undefined);
  return run;
}
