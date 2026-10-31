import { parseTime } from "../schedule";
import type { Trigger } from "../types";

/**
 * 대화에서 쓰는 실행 시점 표현 (mate_do create_duty의 schedule).
 * "manual", "daily HH:MM", "weekdays HH:MM", "every N minutes", "every N hours", "on-commit", "after-session"
 * 간격에는 시간대와 평일을 붙일 수 있다: "every 60 minutes 08:00-20:00", "every 2 hours 09:00-18:00 weekdays"
 */
export function parseSchedulePhrase(phrase: string | undefined): Trigger | undefined {
  const p = (phrase ?? "manual").trim().toLowerCase();
  if (p === "" || p === "manual") return { kind: "manual" };
  if (p === "on-commit") return { kind: "git" };
  if (p === "after-session") return { kind: "session" };
  let m = /^(daily|weekdays)\s+(\d{1,2}:\d{2})$/.exec(p);
  if (m) {
    const time = m[2]!.padStart(5, "0");
    if (!parseTime(time)) return undefined;
    return m[1] === "weekdays" ? { kind: "daily", time, weekdays: [1, 2, 3, 4, 5] } : { kind: "daily", time };
  }
  m = /^every\s+(\d{1,4})\s+(min(?:ute)?s?|hours?)(?:\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2}))?(\s+weekdays)?$/.exec(p);
  if (m) {
    const minutes = Number(m[1]) * (m[2]!.startsWith("hour") ? 60 : 1);
    const [from, to] = [m[3]?.padStart(5, "0"), m[4]?.padStart(5, "0")];
    if (from !== undefined && (!parseTime(from) || !parseTime(to!) || from === to)) return undefined;
    return { kind: "interval", minutes, ...(from ? { from, to: to! } : {}), ...(m[5] ? { weekdays: [1, 2, 3, 4, 5] } : {}) };
  }
  return undefined;
}

export function schedulePhrase(trigger: Trigger): string {
  switch (trigger.kind) {
    case "manual":
      return "직접 실행";
    case "interval": {
      const every = trigger.minutes % 60 === 0 ? `${trigger.minutes / 60}시간마다` : `${trigger.minutes}분마다`;
      const days = trigger.weekdays?.length ? "정한 요일 " : "";
      return trigger.from ? `${days}${trigger.from}~${trigger.to} 사이 ${every}` : `${days}${every}`;
    }
    case "daily":
      return `${trigger.weekdays?.length ? "평일 등 정한 요일" : "매일"} ${trigger.time}`;
    case "git":
      return "새 커밋이 생기면";
    case "files":
      return "파일이 바뀌면";
    case "poll":
      return `${trigger.minutes}분마다 확인 명령 결과가 바뀌면`;
    case "session":
      return "작업을 마치면";
  }
}
