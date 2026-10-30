import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export { KIT_VERSION, STATUS_COMMAND } from "./constants";

/**
 * agent-kit 폴더의 package.json에서 확장 진입 파일(`pi.extensions`)을 절대 경로로 읽는다.
 *
 * 앱은 이 경로마다 `-e`를 붙여 세션을 연다 (설계 DESIGN-AGENT.md §2.1). 사용자 settings.json에는 기록하지 않는다.
 * 폴더 위치는 앱이 정한다 (개발: 워크스페이스, 설치본: 앱 리소스). 번들된 앱에서는 이 파일의 위치로 알 수 없기 때문이다.
 */
export async function extensionEntries(kitDir: string): Promise<string[]> {
  const manifest = JSON.parse(await readFile(join(kitDir, "package.json"), "utf8")) as { pi?: { extensions?: unknown } };
  const entries = manifest.pi?.extensions;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`agent-kit의 package.json에 pi.extensions가 없습니다: ${kitDir}`);
  }
  return entries.map((entry) => {
    if (typeof entry !== "string" || isAbsolute(entry)) throw new Error(`잘못된 확장 경로입니다: ${String(entry)}`);
    return resolve(kitDir, entry);
  });
}

/** 확장 경로들을 `pi --mode rpc` 뒤에 붙일 인자로 바꾼다 */
export function extensionArgs(entries: string[]): string[] {
  return entries.flatMap((entry) => ["-e", entry]);
}
