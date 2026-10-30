import { parseTime } from "../schedule";
import type { Trigger } from "../types";

/**
 * 대화에서 쓰는 실행 시점 표현 (mate_do create_duty의 schedule).
 * "manual", "daily HH:MM", "weekdays HH:MM", "every N minutes", "on-commit", "after-session"
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
  m = /^every\s+(\d{1,4})\s+min(?:ute)?s?$/.exec(p);
  if (m) return { kind: "interval", minutes: Number(m[1]) };
  return undefined;
}

export function schedulePhrase(trigger: Trigger): string {
  switch (trigger.kind) {
    case "manual":
      return "직접 실행";
    case "interval":
      return `${trigger.minutes}분마다`;
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
