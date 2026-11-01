/**
 * 워크스페이스 탭 목록 (설계 §3.3). 순수 함수와 저장만 담당한다.
 */

export interface TabsState {
  ids: string[];
  active: string;
}

/** 탭 표시용 상태 변화로 생기는 알림 */
export type Attention = "done" | "input";

export const TABS_KEY = "pi-desktop.tabs";

/**
 * 앱을 다시 열 때 되살릴 탭. 첫 탭은 늘 두고, 다른 탭은 보던 세션이 기억된 것만 둔다.
 * 세션 없이 열어 둔 빈 "새 탭"까지 되살리면, 한 번 연 빈 탭이 실행할 때마다 따라 나온다.
 */
export function restorableTabIds(ids: readonly string[], mainTab: string, hasSession: (id: string) => boolean): string[] {
  return ids.filter((id) => id === mainTab || hasSession(id));
}

/** 그 탭에 기억된 세션이 있는지 (use-session.ts의 저장 키: pi-desktop.tab.<탭>.lastSession.<호스트>, 닫으면 null) */
function tabHasSession(id: string): boolean {
  const prefix = `pi-desktop.tab.${id}.lastSession.`;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(prefix)) continue;
    const value = localStorage.getItem(key);
    if (value && value !== "null") return true;
  }
  return false;
}

/** 되살리지 않는 탭의 저장값을 지운다 (use-session.ts forgetTab과 같은 키) */
function forgetTabKeys(id: string): void {
  const prefix = `pi-desktop.tab.${id}.`;
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (key?.startsWith(prefix)) localStorage.removeItem(key);
  }
}

export function loadTabs(mainTab: string): TabsState {
  try {
    const raw = localStorage.getItem(TABS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<TabsState>;
      const saved = Array.isArray(parsed.ids) ? parsed.ids.filter((id): id is string => typeof id === "string") : [];
      const ids = restorableTabIds(saved, mainTab, tabHasSession);
      for (const id of saved) if (!ids.includes(id)) forgetTabKeys(id);
      if (ids.length > 0) return { ids, active: ids.includes(String(parsed.active)) ? String(parsed.active) : ids[0]! };
    }
  } catch {
    // 저장값이 깨졌으면 처음 상태로
  }
  return { ids: [mainTab], active: mainTab };
}

export function saveTabs(state: TabsState): void {
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify(state));
  } catch {
    // 무시
  }
}

/** 새 탭을 지금 탭 오른쪽에 열고 활성화한다. */
export function addTab(state: TabsState, id: string): TabsState {
  const at = state.ids.indexOf(state.active);
  const ids = [...state.ids];
  ids.splice(at + 1, 0, id);
  return { ids, active: id };
}

/** 탭을 닫는다. 마지막 탭은 닫지 않는다. 활성 탭을 닫으면 오른쪽(없으면 왼쪽) 탭을 연다. */
export function closeTab(state: TabsState, id: string): TabsState {
  if (state.ids.length <= 1 || !state.ids.includes(id)) return state;
  const at = state.ids.indexOf(id);
  const ids = state.ids.filter((t) => t !== id);
  const active = state.active === id ? ids[Math.min(at, ids.length - 1)]! : state.active;
  return { ids, active };
}

/** 다음(+1)·이전(-1) 탭으로. 끝에서는 반대쪽으로 넘어간다. */
export function cycleTab(state: TabsState, step: 1 | -1): TabsState {
  const at = state.ids.indexOf(state.active);
  const next = (at + step + state.ids.length) % state.ids.length;
  return { ...state, active: state.ids[next]! };
}

/**
 * 숨긴 탭의 상태 변화에서 알릴 것을 고른다.
 * - 입력이 필요해졌다 → "input" (작업 완료보다 먼저 알린다)
 * - 실행 중이었다가 끝났다 → "done"
 */
export function attentionFor(
  before: { running: boolean; needsInput: boolean } | undefined,
  after: { running: boolean; needsInput: boolean },
): Attention | undefined {
  if (after.needsInput && !before?.needsInput) return "input";
  if (before?.running && !after.running) return "done";
  return undefined;
}

/**
 * 같은 세션을 보는 탭이 둘 이상이면 하나만 남기고 닫을 탭들을 돌려준다.
 * 지금 보는 탭이 그중에 있으면 그 탭을, 아니면 왼쪽 탭을 남긴다.
 * (알림·사이드바·활동 패널로 이미 다른 탭에 열린 세션을 다시 열면 같은 이름의 탭이 늘어나던 것을 막는다)
 */
export function duplicateSessionTabs(
  state: TabsState,
  statuses: Readonly<Record<string, { hostId: string; sessionId?: string } | undefined>>,
): string[] {
  const keep = new Map<string, string>();
  const close: string[] = [];
  const order = [state.active, ...state.ids.filter((id) => id !== state.active)].filter((id) => state.ids.includes(id));
  for (const id of order) {
    const status = statuses[id];
    if (!status?.sessionId) continue;
    const key = `${status.hostId}\u0000${status.sessionId}`;
    if (keep.has(key)) close.push(id);
    else keep.set(key, id);
  }
  return close;
}
