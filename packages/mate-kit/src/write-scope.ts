import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * act 단계에서 write·edit가 쓰려는 경로가 작업 공간(git worktree) 안인지 판정한다 (설계 DESIGN-MATE.md §4).
 *
 * - Pi와 같이 앞의 `@`를 떼고 cwd 기준으로 푼다. `~`로 시작하면(홈 폴더) 막는다.
 * - `.git` 안은 막는다 (저장소 메타데이터를 바꾸지 못하게).
 * - 링크를 따라 밖으로 나가지 못하게, 이미 있는 가장 가까운 상위 경로의 실제 위치로 검사한다.
 */
export function writeScopeError(rawPath: string, cwd: string, root: string): string | undefined {
  const path = rawPath.trim().replace(/^@/, "");
  if (!path) return "경로가 비었습니다";
  if (path.startsWith("~")) return "작업 공간 밖(홈 폴더)에는 쓸 수 없습니다";
  const target = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const realRoot = realOrSelf(root);
  if (!inside(target, resolve(root)) && !inside(target, realRoot)) return "작업 공간 밖에는 쓸 수 없습니다";
  const rel = relative(resolve(root), target);
  if (rel.split(/[\\/]/).some((part) => part.toLowerCase() === ".git")) return ".git 안에는 쓸 수 없습니다";
  // 링크 탈출 검사: 존재하는 가장 가까운 경로의 실제 위치가 작업 공간 안이어야 한다
  let probe = target;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  if (!inside(realOrSelf(probe), realRoot)) return "작업 공간 밖을 가리키는 링크로는 쓸 수 없습니다";
  return undefined;
}

function realOrSelf(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function inside(child: string, parent: string): boolean {
  const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const c = norm(child);
  const p = norm(parent.endsWith(sep) ? parent.slice(0, -1) : parent);
  return c === p || c.startsWith(p + sep);
}
