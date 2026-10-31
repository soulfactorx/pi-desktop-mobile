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

  it("interval에 시간대를 정하면 그 안에서만 돌고, 시간대가 열리면 바로 한 번 돈다 (낮 시간에만)", () => {
    const d = duty({ kind: "interval", minutes: 60, from: "08:00", to: "20:00" }, at(2026, 10, 29, 6));
    // 2026-10-29(목) 밤에 마지막으로 돌았다
    const last = at(2026, 10, 29, 19, 30);
    expect(isDue(d, last, at(2026, 10, 29, 20, 30))).toBe(false);
    expect(isDue(d, last, at(2026, 10, 30, 3))).toBe(false);
    expect(nextRunAt(d, last, at(2026, 10, 29, 20, 30))).toBe(at(2026, 10, 30, 8));
    expect(isDue(d, last, at(2026, 10, 30, 8))).toBe(true);
    expect(isDue(d, at(2026, 10, 30, 8), at(2026, 10, 30, 8, 30))).toBe(false);
    expect(nextRunAt(d, at(2026, 10, 30, 8), at(2026, 10, 30, 8, 30))).toBe(at(2026, 10, 30, 9));
    // 20:00은 시간대 밖 (끝은 들지 않는다)
    expect(isDue(d, at(2026, 10, 30, 19), at(2026, 10, 30, 20))).toBe(false);
  });

  it("interval의 시간대는 자정을 넘을 수 있고, 요일을 정하면 그날만 돈다", () => {
    const night = duty({ kind: "interval", minutes: 30, from: "22:00", to: "02:00" });
    expect(isDue(night, at(2026, 10, 29, 22), at(2026, 10, 29, 23))).toBe(true);
    expect(isDue(night, at(2026, 10, 29, 23), at(2026, 10, 30, 1))).toBe(true);
    expect(isDue(night, at(2026, 10, 30, 1), at(2026, 10, 30, 3))).toBe(false);
    expect(nextRunAt(night, at(2026, 10, 30, 1), at(2026, 10, 30, 3))).toBe(at(2026, 10, 30, 22));
    // 평일 09~18시: 2026-10-31은 토요일 → 다음 월요일(11-02) 09:00
    const work = duty({ kind: "interval", minutes: 60, from: "09:00", to: "18:00", weekdays: [1, 2, 3, 4, 5] });
    expect(isDue(work, at(2026, 10, 30, 17), at(2026, 10, 31, 10))).toBe(false);
    expect(nextRunAt(work, at(2026, 10, 30, 17), at(2026, 10, 31, 10))).toBe(at(2026, 11, 2, 9));
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
