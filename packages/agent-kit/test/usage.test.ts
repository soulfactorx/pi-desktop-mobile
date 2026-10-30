import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rangeBuckets, readSessionUsage, readUsageLog, recordUsage, sessionUsage, summarizeUsage, tokensOf, type UsageRecord } from "../src/usage";

const line = (timestamp: string, usage: Record<string, unknown>, role = "assistant") =>
  JSON.stringify({ type: "message", timestamp, message: { role, provider: "anthropic", model: "claude-haiku-5-5", usage } });

const rec = (at: Date, source: UsageRecord["source"], model: string, input: number, output: number, cost = 0): UsageRecord => ({
  at: at.getTime(),
  source,
  provider: "p",
  model,
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  cost,
});

describe("세션 파일 읽기", () => {
  it("assistant 메시지의 usage만, since 이후만 읽는다", () => {
    const text = [
      JSON.stringify({ type: "session", id: "s" }),
      line("2026-10-29T01:00:00.000Z", { input: 4, output: 127, cacheRead: 10, cacheWrite: 5464, cost: { total: 0.0007 } }),
      line("2026-10-28T01:00:00.000Z", { input: 1, output: 1 }),
      line("2026-10-29T02:00:00.000Z", { input: 9 }, "user"),
      "깨진 줄 \"usage\"",
    ].join("\n");
    const records = sessionUsage(text, "chat", Date.parse("2026-10-29T00:00:00Z"));
    expect(records).toEqual([
      {
        at: Date.parse("2026-10-29T01:00:00Z"),
        source: "chat",
        provider: "anthropic",
        model: "claude-haiku-5-5",
        input: 4,
        output: 127,
        cacheRead: 10,
        cacheWrite: 5464,
        cost: 0.0007,
      },
    ]);
  });

  it("폴더를 돌며 읽고, 오래된 파일은 열지 않고, 스케줄러 폴더는 예약으로 센다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sessions-"));
    const chat = join(dir, "--C--work--");
    const scheduler = join(dir, "--C--Users-me-.pi-desktop-agent-scheduler--");
    mkdirSync(chat);
    mkdirSync(scheduler);
    writeFileSync(join(chat, "a.jsonl"), line("2026-10-29T01:00:00.000Z", { input: 1, output: 2 }));
    writeFileSync(join(scheduler, "b.jsonl"), line("2026-10-29T03:00:00.000Z", { input: 3, output: 4 }));
    const old = join(chat, "old.jsonl");
    writeFileSync(old, line("2026-10-29T05:00:00.000Z", { input: 100, output: 100 }));
    // 고친 때가 since보다 이르면 내용과 상관없이 건너뛴다
    utimesSync(old, new Date("2026-01-01"), new Date("2026-01-01"));
    // 세션 폴더를 직접 정한 실행은 작업 폴더 없이 바로 아래에 둔다
    writeFileSync(join(dir, "flat.jsonl"), line("2026-10-29T04:00:00.000Z", { input: 5, output: 6 }));
    const records = await readSessionUsage(dir, Date.parse("2026-10-01T00:00:00Z"));
    expect(records.map((r) => `${r.source}:${r.input}`).sort()).toEqual(["chat:1", "chat:5", "schedule:3"]);
    expect(await readSessionUsage(join(dir, "없음"), 0)).toEqual([]);
  });
});

describe("세션 밖 사용량 기록", () => {
  it("usage.jsonl에 적고 since 이후만 읽는다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "usage-"));
    await recordUsage(dir, "memory", { provider: "ollama", id: "qwen3.5:9b" }, { input: 10, output: 5 }, 1000);
    await recordUsage(dir, "document", { provider: "ollama", id: "qwen3.5:9b" }, { input: 20, output: 7, cost: { total: 0.01 } }, 2000);
    await recordUsage(dir, "worker", { provider: "x", id: "y" }, undefined, 3000);
    expect((await readUsageLog(dir, 1500)).map((r) => [r.source, r.input, r.cost])).toEqual([["document", 20, 0.01]]);
    expect(await readUsageLog(join(dir, "없음"), 0)).toEqual([]);
  });
});

describe("집계", () => {
  const now = new Date(2026, 9, 29, 15, 30);

  it("오늘은 24시간, 7·30일은 일별, 12개월은 월별 구간", () => {
    expect(rangeBuckets("today", now).keys).toHaveLength(24);
    expect(rangeBuckets("7d", now).keys.map((k) => k.label)).toEqual(["10/23", "10/24", "10/25", "10/26", "10/27", "10/28", "10/29"]);
    expect(rangeBuckets("30d", now).keys).toHaveLength(30);
    const months = rangeBuckets("12m", now).keys;
    expect([months[0]!.label, months.at(-1)!.label]).toEqual(["25.11", "26.10"]);
  });

  it("기간 안의 것만 합치고 구간·모델·출처별로 나눈다 (많이 쓴 순)", () => {
    const summary = summarizeUsage(
      [
        rec(new Date(2026, 9, 29, 9), "chat", "big", 100, 50, 0.5),
        rec(new Date(2026, 9, 29, 9, 40), "memory", "small", 10, 5),
        rec(new Date(2026, 9, 28, 23), "chat", "big", 999, 999),
        rec(new Date(2026, 9, 29, 16), "chat", "big", 999, 999),
      ],
      "today",
      now,
    );
    expect(summary.total).toMatchObject({ input: 110, output: 55, cost: 0.5, calls: 2 });
    expect(tokensOf(summary.total)).toBe(165);
    expect(summary.buckets.find((b) => b.label === "9시")).toMatchObject({ input: 110, calls: 2 });
    expect(summary.models.map((m) => m.name)).toEqual(["p/big", "p/small"]);
    expect(summary.sources.map((s) => s.source)).toEqual(["chat", "memory"]);
  });
});
