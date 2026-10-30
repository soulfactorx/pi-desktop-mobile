import { describe, expect, it } from "vitest";
import type { DutyView, InboxView } from "../../src/shared/api";
import { costLabel, nextRunLabel, piSetupIssues, relativeTime, splitInbox, triggerLabel } from "../../src/renderer/mate-view";

const at = (d: number, h: number, mi = 0) => new Date(2026, 9, d, h, mi).getTime();

describe("mate-view", () => {
  it("실행 시점을 사람이 읽는 말로", () => {
    expect(triggerLabel({ kind: "manual" })).toBe("직접 실행");
    expect(triggerLabel({ kind: "interval", minutes: 120 })).toBe("2시간마다");
    expect(triggerLabel({ kind: "interval", minutes: 45 })).toBe("45분마다");
    expect(triggerLabel({ kind: "daily", time: "09:00", weekdays: [1, 3, 5] })).toBe("월·수·금 09:00");
    expect(triggerLabel({ kind: "daily", time: "09:00" })).toBe("매일 09:00");
  });

  it("상대 시각", () => {
    const now = at(29, 12);
    expect(relativeTime(now - 30_000, now)).toBe("방금");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5분 전");
    expect(relativeTime(now + 10 * 60_000, now)).toBe("10분 뒤");
    expect(relativeTime(at(28, 9), now)).toBe("어제 09:00");
    expect(relativeTime(at(30, 9), now)).toBe("내일 09:00");
    expect(relativeTime(at(20, 9, 5), now)).toBe("10/20 09:05");
  });

  it("다음 실행 안내는 꺼짐·대기·일시 정지를 먼저 보인다", () => {
    const now = at(29, 12);
    const duty = {
      id: "d", name: "d", enabled: true, cwd: ".", prompt: "p", profile: "observe", createdAt: 0,
      trigger: { kind: "daily", time: "09:00" }, nextRunAt: at(30, 9), queued: false,
    } as DutyView;
    expect(nextRunLabel(duty, now, false)).toBe("다음: 내일 09:00");
    expect(nextRunLabel(duty, now, true)).toBe("일시 정지됨");
    expect(nextRunLabel({ ...duty, queued: true }, now, true)).toBe("실행 대기 중");
    expect(nextRunLabel({ ...duty, enabled: false }, now, false)).toBe("꺼짐");
  });

  it("변화 계기: 지켜보는 중 / 감지한 변화와 실행 시각", () => {
    const now = at(29, 12);
    const git = {
      id: "g", name: "g", enabled: true, cwd: ".", prompt: "p", profile: "propose", createdAt: 0,
      trigger: { kind: "git", cooldownMinutes: 15 }, queued: false,
    } as DutyView;
    expect(triggerLabel(git.trigger)).toBe("새 커밋이 생기면");
    expect(triggerLabel({ kind: "poll", command: "gh run list", minutes: 30 })).toBe('"gh run list" 결과가 바뀌면 (30분마다 확인)');
    expect(nextRunLabel(git, now, false)).toBe("변화를 지켜보는 중");
    const pending = { ...git, pendingChange: { cause: "커밋 b2 (main)", since: now }, nextRunAt: now + 10 * 60_000 };
    expect(nextRunLabel(pending, now, false)).toBe("커밋 b2 (main) · 10분 뒤 실행");
    expect(nextRunLabel({ ...pending, nextRunAt: now }, now, false)).toBe("커밋 b2 (main) · 곧 실행");
    expect(nextRunLabel(pending, now, true)).toBe("변화 감지됨 · 일시 정지됨");
  });

  it("새 제안과 처리한 제안을 나누고 비용을 짧게", () => {
    const item = (id: string, status?: InboxView["status"]) => ({ id, status }) as InboxView;
    const { fresh, handled } = splitInbox([item("a"), item("b", "accepted"), item("c", "dismissed")]);
    expect(fresh.map((i) => i.id)).toEqual(["a"]);
    expect(handled.map((i) => i.id)).toEqual(["b", "c"]);
    expect(costLabel(0.0031)).toBe("$0.0031");
    expect(costLabel(0.42)).toBe("$0.42");
    expect(costLabel(0)).toBe("");
  });
});

describe("piSetupIssues", () => {
  const base = { node: { path: "node", ok: true }, authProviders: [], models: [], checkedAt: 0 };
  it("Pi가 없으면 그것만, 모델이 없으면 로그인 안내", () => {
    expect(piSetupIssues({ ...base, stage: "no-pi" }, "a/b").map((i) => i.kind)).toEqual(["no-pi"]);
    expect(piSetupIssues({ ...base, stage: "no-models", pi: { version: "1.4.0", cliPath: "x", source: "npm-global" } }, "a/b")[0]).toMatchObject({
      kind: "no-models",
      level: "bad",
    });
  });

  it("준비됐으면 기본 모델이 목록에 있는지와 Git Bash를 본다", () => {
    const ready = { ...base, stage: "ready" as const, models: [{ provider: "anthropic", id: "claude-haiku-5-5" }] };
    expect(piSetupIssues(ready, "anthropic/claude-haiku-5-5")).toEqual([]);
    expect(piSetupIssues(ready, "openai/gpt-x").map((i) => i.kind)).toEqual(["model"]);
    expect(piSetupIssues({ ...ready, gitBash: { found: false } }, "anthropic/claude-haiku-5-5").map((i) => i.kind)).toEqual(["git-bash"]);
  });
});
