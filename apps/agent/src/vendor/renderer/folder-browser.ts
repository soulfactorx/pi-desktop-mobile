/**
 * 폴더 탐색 창의 순수 함수들 (설계 §5.5, M3).
 * 경로는 데몬이 돌려준 호스트 경로를 그대로 다룬다. WSL·SSH는 "/", Windows는 "\" 구분자다.
 */

/** 경로가 Windows 형식인지 (드라이브 문자로 시작하거나 "\"를 쓴다) */
function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:/.test(path) || path.includes("\\");
}

/** 폴더 안의 하위 폴더 경로 */
export function childPath(parent: string, name: string): string {
  const sep = isWindowsPath(parent) ? "\\" : "/";
  return parent.endsWith(sep) ? `${parent}${name}` : `${parent}${sep}${name}`;
}

export interface Crumb {
  label: string;
  path: string;
}

/** 경로를 누를 수 있는 마디로 나눈다. 첫 마디는 루트("/" 또는 "C:\") */
export function pathCrumbs(path: string): Crumb[] {
  const sep = isWindowsPath(path) ? "\\" : "/";
  const parts = path.split(sep).filter(Boolean);
  if (sep === "/") {
    const crumbs: Crumb[] = [{ label: "/", path: "/" }];
    let at = "";
    for (const part of parts) {
      at += `/${part}`;
      crumbs.push({ label: part, path: at });
    }
    return crumbs;
  }
  const [drive, ...rest] = parts;
  if (!drive) return [];
  let at = `${drive}\\`;
  const crumbs: Crumb[] = [{ label: at, path: at }];
  for (const part of rest) {
    at = childPath(at, part);
    crumbs.push({ label: part, path: at });
  }
  return crumbs;
}

/** 보일 폴더: 숨김 폴더(".")는 켰을 때만, 거르기 글자가 이름에 들어 있는 것만 (대소문자 무시) */
export function visibleDirs(dirs: readonly string[], filter: string, showHidden: boolean): string[] {
  const q = filter.trim().toLowerCase();
  return dirs.filter((name) => (showHidden || !name.startsWith(".")) && (!q || name.toLowerCase().includes(q)));
}

/**
 * IPC 오류에서 Electron이 붙이는 접두사("Error invoking remote method '…': JsonRpcError: ")를 떼고 데몬의 문구만 남긴다.
 * 데몬이 모르는 메서드면, 세션이 돌고 있어 예전 데몬을 그대로 쓰는 경우라 바꾸는 방법을 덧붙인다 (설계 §3.4).
 */
export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const text = message.replace(/^Error invoking remote method '[^']*': /, "").replace(/^(?:JsonRpc)?Error: /, "");
  return text.startsWith("알 수 없는 메서드")
    ? `${text}
떠 있는 Host Agent가 이 앱보다 예전 것입니다. 상단의 "Agent 업데이트 대기"를 눌러 바꾸세요.`
    : text;
}

/** 보일 폴더가 없을 때의 안내 */
export function emptyText(dirs: readonly string[], filter: string, showHidden: boolean): string {
  if (filter.trim()) return "맞는 폴더가 없습니다";
  if (!showHidden && dirs.some((name) => name.startsWith("."))) return "숨김 폴더만 있습니다";
  return "하위 폴더가 없습니다";
}
