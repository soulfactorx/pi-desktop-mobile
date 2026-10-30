/**
 * 최근에 대화를 연 작업 폴더 (설계 DESIGN-AGENT.md §4 "작업 폴더").
 * 새 대화·폴더 옮기기에서 고를 수 있게 이 PC(앱 화면)에만 둔다. 저장하지 못해도 동작한다.
 */
let KEY = "agent.recentCwds";
let LAST_KEY = "agent.lastCwd";

/**
 * 호스트마다 최근 폴더를 따로 둔다 (원격 호스트의 폴더는 이 PC에 없다, DESIGN-APPS.md §6 D3).
 * 로컬은 예전 키를 그대로 써서 전에 기억한 폴더를 잃지 않는다.
 */
export function setRecentScope(hostId: string): void {
  const suffix = hostId === "local" ? "" : `:${hostId}`;
  KEY = `agent.recentCwds${suffix}`;
  LAST_KEY = `agent.lastCwd${suffix}`;
}
export const MAX_RECENT = 6;

/** Windows 경로는 대소문자·구분자가 달라도 같은 폴더로 본다 */
function same(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
  return norm(a) === norm(b);
}

export function addRecent(list: string[], folder: string, max = MAX_RECENT): string[] {
  return [folder, ...list.filter((f) => !same(f, folder))].slice(0, max);
}

export function recentFolders(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    const list = Array.isArray(parsed) ? parsed.filter((f): f is string => typeof f === "string") : [];
    // 최근 목록이 없던 예전 버전(v0.1.2)이 기억한 마지막 폴더도 살린다
    const last = localStorage.getItem(LAST_KEY);
    return last && !list.some((f) => same(f, last)) ? [...list, last].slice(0, MAX_RECENT) : list;
  } catch {
    return [];
  }
}

export function lastFolder(): string | undefined {
  return recentFolders()[0];
}

export function rememberFolder(folder: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(addRecent(recentFolders(), folder)));
    localStorage.setItem(LAST_KEY, folder);
  } catch {
    // 기억하지 못해도 대화는 연다
  }
}

export function isSameFolder(a: string, b: string): boolean {
  return same(a, b);
}

export function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}
