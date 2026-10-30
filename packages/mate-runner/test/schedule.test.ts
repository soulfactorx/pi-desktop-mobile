import { describe, expect, it } from "vitest";
import { isDue, nextRunAt } from "../src/schedule";
import type { Duty, Trigger } from "../src/types";

/** 로컬 시각 */
const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

function duty(trigger: Trigger, createdAt = at(2026, 10, 1, 0)): Duty {
  return { id: "d", name: "d", enabled: true, cwd: ".", prompt: "p", profile: "observe", trigger, createdAt };
}

describe("isDue", () => {
  it("manual은 시간표로 돌지 않고, 꺼진 임무도 돌지 않는다", () => {
    expect(isDue(duty({ kind: "manual" }), undefined, at(2026, 10, 29, 9))).toBe(false);
    expect(isDue({ ...duty({ kind: "interval", minutes: 15 }), enabled: false }, undefined, at(2026, 10, 29, 9))).toBe(false);
  });

  it("interval은 마지막 실행(없으면 만든 시각)에서 N분 뒤", () => {
    const d = duty({ kind: "interval", minutes: 60 }, at(2026, 10, 29, 8));
    expect(isDue(d, undefined, at(2026, 10, 29, 8, 59))).toBe(false);
    expect(isDue(d, undefined, at(2026, 10, 29, 9))).toBe(true);
    expect(isDue(d, at(2026, 10, 29, 9), at(2026, 10, 29, 9, 30))).toBe(false);
    expect(nextRunAt(d, at(2026, 10, 29, 9), at(2026, 10, 29, 9, 30))).toBe(at(2026, 10, 29, 10));
  });

  it("daily는 시각이 지나면 한 번, 놓친 여러 날은 한 번만 따라잡는다", () => {
    const d = duty({ kind: "daily", time: "09:00" });
    expect(isDue(d, at(2026, 10, 28, 9, 1), at(2026, 10, 29, 8, 59))).toBe(false);
    expect(isDue(d, at(2026, 10, 28, 9, 1), at(2026, 10, 29, 9, 0))).toBe(true);
    // 사흘 꺼져 있었어도 오늘 한 번 돌면 끝
    expect(isDue(d, at(2026, 10, 25, 9), at(2026, 10, 29, 12))).toBe(true);
    expect(isDue(d, at(2026, 10, 29, 12), at(2026, 10, 29, 13))).toBe(false);
    expect(nextRunAt(d, at(2026, 10, 29, 12), at(2026, 10, 29, 13))).toBe(at(2026, 10, 30, 9));
  });

  it("만든 시각 이전의 시간표는 따라잡지 않는다", () => {
    const d = duty({ kind: "daily", time: "09:00" }, at(2026, 10, 29, 10));
    expect(isDue(d, undefined, at(2026, 10, 29, 11))).toBe(false);
    expect(isDue(d, undefined, at(2026, 10, 30, 9))).toBe(true);
  });

  it("요일을 정하면 그 요일에만 (2026-10-31은 토요일)", () => {
    const weekdays = duty({ kind: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] });
    expect(isDue(weekdays, at(2026, 10, 30, 9), at(2026, 10, 31, 10))).toBe(false);
    expect(nextRunAt(weekdays, at(2026, 10, 30, 9), at(2026, 10, 31, 10))).toBe(at(2026, 11, 2, 9));
  });
});
