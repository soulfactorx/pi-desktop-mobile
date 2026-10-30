import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** 권한 상승 켜기·끄기 (agent-kit 상태 폴더의 elevation.json). 기본은 꺼짐 */
export function elevationFile(dataDir: string): string {
  return join(dataDir, "elevation.json");
}

export async function loadElevationEnabled(dataDir: string): Promise<boolean> {
  try {
    return (JSON.parse(await readFile(elevationFile(dataDir), "utf8")) as { enabled?: unknown }).enabled === true;
  } catch {
    return false;
  }
}

export async function saveElevationEnabled(dataDir: string, enabled: boolean): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(elevationFile(dataDir), `${JSON.stringify({ enabled }, null, 2)}\n`, "utf8");
}
