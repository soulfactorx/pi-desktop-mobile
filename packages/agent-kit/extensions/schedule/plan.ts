/**
 * 예약의 순수 로직: 입력 검증, 다음 실행 시각, 도래 판정. 파일·Pi에 손대지 않는다.
 *
 * desktop-agent와 같은 세 종류다. once(한 번, ISO 시각) / interval(N분마다, 최소 5분) / daily(매일 HH:MM, 이 PC의 시간대).
 */

export type ScheduleKind = "once" | "interval" | "daily";

export interface Schedule {
  id: string;
  title: string;
  instruction: string;
  cwd: string;
  kind: ScheduleKind;
  /** once: 실행 시각 (ISO) */
  at?: string;
  /** interval: 분 */
  minutes?: number;
  /** daily: "HH:MM" */
  time?: string;
  enabled: boolean;
  /** 다음 실행 시각 (ISO). 끝난 once는 없음 */
  nextRun?: string;
  lastRun?: string;
  lastTaskId?: string;
  provider?: string;
  model?: string;
  createdAt: string;
}

export const MIN_INTERVAL_MINUTES = 5;

export interface ScheduleInput {
  kind: ScheduleKind;
  at?: string;
  minutes?: number;
  time?: string;
}

/** 입력이 맞지 않으면 그 이유 (모델에 돌려줄 글), 맞으면 undefined */
export function invalidReason(input: ScheduleInput, now: Date): string | undefined {
  if (input.kind === "once") {
    const at = input.at ? Date.parse(input.at) : Number.NaN;
    if (Number.isNaN(at)) return "once에는 실행 시각 at(ISO 8601, 예: 2026-10-30T15:00:00+09:00)이 필요하다";
    if (at <= now.getTime()) return "at이 이미 지난 시각이다";
    return undefined;
  }
  if (input.kind === "interval") {
    if (!input.minutes || !Number.isFinite(input.minutes) || input.minutes < MIN_INTERVAL_MINUTES) {
      return `interval에는 ${MIN_INTERVAL_MINUTES}분 이상의 minutes가 필요하다`;
    }
    return undefined;
  }
  if (!input.time || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)) return "daily에는 HH:MM 형식의 time이 필요하다 (예: 09:00)";
  return undefined;
}

/** from 다음의 실행 시각. once가 이미 지났으면 undefined */
export function nextRunAfter(schedule: ScheduleInput, from: Date): Date | undefined {
  if (schedule.kind === "once") {
    const at = new Date(schedule.at ?? "");
    return at.getTime() > from.getTime() ? at : undefined;
  }
  if (schedule.kind === "interval") return new Date(from.getTime() + (schedule.minutes ?? MIN_INTERVAL_MINUTES) * 60_000);
  const [hours, minutes] = (schedule.time ?? "00:00").split(":").map(Number);
  const next = new Date(from);
  next.setHours(hours!, minutes!, 0, 0);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

/** 처음 등록할 때의 다음 실행 시각. once는 그 시각, 나머지는 지금부터 */
export function firstRun(input: ScheduleInput, now: Date): Date | undefined {
  return input.kind === "once" ? new Date(input.at ?? "") : nextRunAfter(input, now);
}

/** 지금 실행할 예약들. 앱·PC가 꺼져 있던 동안 놓친 것도 한 번만 실행한다 */
export function dueSchedules(schedules: Schedule[], now: Date): Schedule[] {
  return schedules.filter((s) => s.enabled && s.nextRun !== undefined && Date.parse(s.nextRun) <= now.getTime());
}

/** 실행을 시작할 때 예약을 고친다: 지난 실행 기록, 다음 실행 시각 (once는 끝) */
export function markStarted(schedule: Schedule, now: Date, taskId: string): Schedule {
  const next = schedule.kind === "once" ? undefined : nextRunAfter(schedule, now);
  return {
    ...schedule,
    lastRun: now.toISOString(),
    lastTaskId: taskId,
    nextRun: next?.toISOString(),
    enabled: schedule.kind === "once" ? false : schedule.enabled,
  };
}

/** 사람이 읽을 예약 설명 */
export function describeSchedule(s: Pick<Schedule, "kind" | "at" | "minutes" | "time">): string {
  if (s.kind === "once") return `한 번 ${s.at ?? "?"}`;
  if (s.kind === "interval") return `${s.minutes ?? "?"}분마다`;
  return `매일 ${s.time ?? "?"}`;
}
