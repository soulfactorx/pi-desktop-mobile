import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * 문맥 파일(`AGENTS.md`·`CLAUDE.md`) 찾기 (설계 DESIGN-APPS.md §3.1 "문맥 파일").
 *
 * `-nc`로 Pi의 찾기를 끈 대신 같은 규칙으로 찾는다: 앱 홈의 파일을 먼저, 그다음 작업 폴더에서 위로 올라가며
 * 폴더마다 하나씩(위쪽 폴더가 앞). Pi처럼 프로젝트 신뢰와 관계없이 읽는다 (Pi docs/configuration.md).
 * Pi 설정 폴더의 `AGENTS.md`는 앱 홈이 아니므로 읽지 않는다.
 * Pi가 하는 git worktree 중복 제거(바깥 저장소의 같은 파일을 빼기)는 하지 않는다.
 */

export interface ContextFile {
  path: string;
  content: string;
}

/** 한 폴더에서 고르는 순서 (Pi와 같음) */
export const CONTEXT_FILE_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

const stripBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

export function contextFileIn(dir: string): ContextFile | undefined {
  for (const name of CONTEXT_FILE_NAMES) {
    const path = join(dir, name);
    try {
      if (!existsSync(path) || !statSync(path).isFile()) continue;
      return { path, content: stripBom(readFileSync(path, "utf8")) };
    } catch {
      // 읽지 못하는 파일은 건너뛴다
    }
  }
  return undefined;
}

export function findContextFiles(home: string, cwd: string): ContextFile[] {
  const files: ContextFile[] = [];
  const seen = new Set<string>();
  const own = contextFileIn(resolve(home));
  if (own) {
    files.push(own);
    seen.add(own.path);
  }
  const ancestors: ContextFile[] = [];
  let dir = resolve(cwd);
  for (;;) {
    const file = contextFileIn(dir);
    if (file && !seen.has(file.path)) {
      ancestors.unshift(file);
      seen.add(file.path);
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [...files, ...ancestors];
}
