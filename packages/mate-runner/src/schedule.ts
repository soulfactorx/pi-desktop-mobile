import {
  DEFAULT_COOLDOWN_MINUTES,
  DEFAULT_QUIET_SECONDS,
  isChangeTrigger,
  type ChangeTrigger,
  type Duty,
  type WatchState,
} from "./types";

const DAY = 24 * 60 * 60 * 1000;

/**
 * 지금 돌려야 하는 임무인지 (설계 DESIGN-MATE.md §2.3, §3).
 *
 * - interval: 마지막 실행(없으면 만든 시각)에서 N분이 지났으면. 시간대·요일을 정했으면 그 안에서만
 *   (시간대가 열리면 바로 한 번 돌고, 그 뒤 N분마다).
 * - daily: 지금 이전의 가장 최근 시간표가 마지막 실행·만든 시각 뒤면. 실행기가 꺼져 있던 동안
 *   여러 번을 놓쳤어도 가장 최근 것 하나만 따라잡는다.
 * - 변화 계기(git·files·poll): 기다리는 변화가 있고 쉬는 시간(·파일은 잠잠한 시간)이 지났으면.
 */
export function isDue(duty: Duty, lastRunAt: number | undefined, now: number, watch?: WatchState): boolean {
  if (!duty.enabled) return false;
  const base = Math.max(lastRunAt ?? 0, duty.createdAt);
  const t = duty.trigger;
  if (isChangeTrigger(t)) {
    const readyAt = changeReadyAt(t, lastRunAt, watch);
    return readyAt !== undefined && readyAt <= now;
  }
  switch (t.kind) {
    case "manual":
      return false;
    case "interval":
      return now - base >= t.minutes * 60_000 && inWindow(t, now);
    case "daily": {
      const slot = previousSlot(t.time, t.weekdays, now);
      return slot !== undefined && slot > base;
    }
  }
}

/**
 * 기다리는 변화가 실행될 수 있는 시각. 변화가 없으면 undefined.
 * 쉬는 시간: 마지막 실행 뒤 cooldown(poll은 간격이 곧 쉬는 시간이라 없음). 파일은 마지막 변경 뒤 quiet초.
 */
export function changeReadyAt(trigger: ChangeTrigger, lastRunAt: number | undefined, watch: WatchState | undefined): number | undefined {
  const pending = watch?.pending;
  if (!pending) return undefined;
  const cooldown = trigger.kind === "poll" ? 0 : (trigger.cooldownMinutes ?? DEFAULT_COOLDOWN_MINUTES) * 60_000;
  const quiet = trigger.kind === "files" ? (trigger.quietSeconds ?? DEFAULT_QUIET_SECONDS) * 1000 : 0;
  return Math.max(lastRunAt === undefined ? 0 : lastRunAt + cooldown, pending.lastAt + quiet);
}

/** 화면에 보일 다음 실행 시각. 지금 돌아야 하면 now, 정해진 때가 없으면 undefined */
export function nextRunAt(duty: Duty, lastRunAt: number | undefined, now: number, watch?: WatchState): number | undefined {
  if (!duty.enabled) return undefined;
  if (isDue(duty, lastRunAt, now, watch)) return now;
  const t = duty.trigger;
  if (isChangeTrigger(t)) return changeReadyAt(t, lastRunAt, watch);
  switch (t.kind) {
    case "manual":
      return undefined;
    case "interval": {
      // 간격은 지났는데 시간대 밖이면 다음에 시간대가 열릴 때
      const at = Math.max(Math.max(lastRunAt ?? 0, duty.createdAt) + t.minutes * 60_000, now);
      return inWindow(t, at) ? at : nextWindowStart(t, at);
    }
    case "daily":
      return nextSlot(t.time, t.weekdays, now);
  }
}

type IntervalTrigger = Extract<Duty["trigger"], { kind: "interval" }>;

/** 간격 임무가 이 시각에 돌 수 있는가 (시간대·요일). 정하지 않았으면 언제나 */
export function inWindow(t: IntervalTrigger, ms: number): boolean {
  const from = t.from ? parseTime(t.from) : undefined;
  const to = t.to ? parseTime(t.to) : undefined;
  if (!from || !to) return matchesDay(ms, t.weekdays);
  const d = new Date(ms);
  const m = d.getHours() * 60 + d.getMinutes();
  const start = from.hour * 60 + from.minute;
  const end = to.hour * 60 + to.minute;
  if (start < end) return m >= start && m < end && matchesDay(ms, t.weekdays);
  // 자정을 넘는 시간대: 자정 뒤 부분은 전날 시작한 시간대다
  if (m >= start) return matchesDay(ms, t.weekdays);
  return m < end && matchesDay(ms - DAY, t.weekdays);
}

/** ms 뒤에 시간대가 처음 열리는 시각 (최대 8일 뒤까지) */
function nextWindowStart(t: IntervalTrigger, ms: number): number | undefined {
  const from = t.from ? parseTime(t.from) : { hour: 0, minute: 0 };
  if (!from) return undefined;
  for (let ahead = 0; ahead <= 8; ahead++) {
    const slot = slotOn(ms + ahead * DAY, from);
    if (slot >= ms && inWindow(t, slot)) return slot;
  }
  return undefined;
}

export function parseTime(time: string): { hour: number; minute: number } | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return undefined;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  return hour < 24 && minute < 60 ? { hour, minute } : undefined;
}

/** now 이하인 가장 최근 시간표 (로컬 시각, 최대 7일 전까지) */
function previousSlot(time: string, weekdays: number[] | undefined, now: number): number | undefined {
  const hm = parseTime(time);
  if (!hm) return undefined;
  for (let back = 0; back <= 7; back++) {
    const slot = slotOn(now - back * DAY, hm);
    if (slot <= now && matchesDay(slot, weekdays)) return slot;
  }
  return undefined;
}

function nextSlot(time: string, weekdays: number[] | undefined, now: number): number | undefined {
  const hm = parseTime(time);
  if (!hm) return undefined;
  for (let ahead = 0; ahead <= 7; ahead++) {
    const slot = slotOn(now + ahead * DAY, hm);
    if (slot > now && matchesDay(slot, weekdays)) return slot;
  }
  return undefined;
}

function slotOn(dayMs: number, hm: { hour: number; minute: number }): number {
  const d = new Date(dayMs);
  d.setHours(hm.hour, hm.minute, 0, 0);
  return d.getTime();
}

function matchesDay(ms: number, weekdays: number[] | undefined): boolean {
  return !weekdays || weekdays.length === 0 || weekdays.includes(new Date(ms).getDay());
}

/** 로컬 날짜 키 (하루 실행 수 세기용) */
export function localDateKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
