import { appendFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { UsageRange, UsageRecord, UsageSource, UsageSummary, UsageTotals, UsageBucket } from "./usage-types";

export type { UsageRange, UsageRecord, UsageSource, UsageSummary, UsageTotals, UsageBucket } from "./usage-types";

/**
 * 사용량 (설계 DESIGN-AGENT.md §4 "사용량").
 *
 * 대화의 사용량은 Pi가 세션 파일의 assistant 메시지마다 `usage`로 남긴다. 따로 모으지 않고 그것을 읽는다.
 * 세션에 남지 않는 호출(턴 뒤 기억 추출, 문서 조각 처리, --no-session 워커)만 agent-kit 상태 폴더의
 * `usage.jsonl`에 한 줄씩 적는다. 화면은 두 출처를 합쳐 보인다.
 *
 * 확장은 대상 호스트의 Pi가 jiti로 불러오므로 이 파일은 node 내장 모듈과 같은 폴더의 타입만 import한다.
 */

/** Pi의 Usage 중 여기서 쓰는 부분 */
export interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

export function usageLogFile(dataDir: string): string {
  return join(dataDir, "usage.jsonl");
}

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

export function toRecord(at: number, source: UsageSource, provider: string, model: string, usage: PiUsage | undefined): UsageRecord {
  return {
    at,
    source,
    provider,
    model,
    input: num(usage?.input),
    output: num(usage?.output),
    cacheRead: num(usage?.cacheRead),
    cacheWrite: num(usage?.cacheWrite),
    cost: num(usage?.cost?.total),
  };
}

/** 세션에 남지 않는 호출의 사용량을 적는다. 실패해도 호출한 쪽의 일을 막지 않는다 */
export async function recordUsage(
  dataDir: string,
  source: UsageSource,
  model: { provider: string; id: string },
  usage: PiUsage | undefined,
  now = Date.now(),
): Promise<void> {
  if (!usage) return;
  try {
    await mkdir(dataDir, { recursive: true });
    await appendFile(usageLogFile(dataDir), `${JSON.stringify(toRecord(now, source, model.provider, model.id, usage))}\n`, "utf8");
  } catch {
    // 사용량을 적지 못해도 기억 추출·문서 처리는 계속한다
  }
}

export async function readUsageLog(dataDir: string, since: number): Promise<UsageRecord[]> {
  let text: string;
  try {
    text = await readFile(usageLogFile(dataDir), "utf8");
  } catch {
    return [];
  }
  const records: UsageRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as UsageRecord;
      if (num(record.at) >= since) records.push(record);
    } catch {
      // 반쯤 쓰인 줄은 건너뛴다
    }
  }
  return records;
}

/** 세션 파일 한 개의 assistant 메시지 사용량 */
export function sessionUsage(text: string, source: UsageSource, since: number): UsageRecord[] {
  const records: UsageRecord[] = [];
  for (const line of text.split("\n")) {
    // 대부분의 줄은 사용량이 없다. JSON을 읽기 전에 거른다
    if (!line.includes('"usage"')) continue;
    try {
      const entry = JSON.parse(line) as {
        type?: string;
        timestamp?: string;
        message?: { role?: string; provider?: string; model?: string; usage?: PiUsage; timestamp?: number };
      };
      const message = entry.message;
      if (entry.type !== "message" || message?.role !== "assistant" || !message.usage) continue;
      const at = Date.parse(entry.timestamp ?? "") || num(message.timestamp);
      if (at < since) continue;
      records.push(toRecord(at, source, message.provider ?? "?", message.model ?? "?", message.usage));
    } catch {
      // 깨진 줄은 건너뛴다
    }
  }
  return records;
}

/**
 * Pi 세션 폴더(`<sessions>/<작업 폴더>/<세션>.jsonl`)에서 since 이후의 사용량을 읽는다. 세션 폴더를 직접 정한
 * 실행(--session-dir, PI_CODING_AGENT_SESSION_DIR)은 작업 폴더 없이 바로 아래에 두므로 그것도 읽는다.
 * since 전에 마지막으로 고친 파일은 열지 않는다. 앱의 스케줄러 세션 폴더는 "예약"으로 센다.
 */
export async function readSessionUsage(sessionsDir: string, since: number): Promise<UsageRecord[]> {
  let folders: string[];
  try {
    folders = await readdir(sessionsDir);
  } catch {
    return [];
  }
  const records: UsageRecord[] = [];
  const readSessionFile = async (path: string, source: UsageSource) => {
    try {
      if ((await stat(path)).mtimeMs < since) return;
      records.push(...sessionUsage(await readFile(path, "utf8"), source, since));
    } catch {
      // 읽는 중에 지워진 파일 등은 건너뛴다
    }
  };
  for (const folder of folders) {
    if (folder.endsWith(".jsonl")) {
      await readSessionFile(join(sessionsDir, folder), "chat");
      continue;
    }
    const source: UsageSource = /pi-desktop-agent-scheduler/.test(folder) ? "schedule" : "chat";
    let files: string[];
    try {
      files = await readdir(join(sessionsDir, folder));
    } catch {
      continue;
    }
    for (const name of files.filter((n) => n.endsWith(".jsonl"))) await readSessionFile(join(sessionsDir, folder, name), source);
  }
  return records;
}

const zero = (): UsageTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 0 });

function add(into: UsageTotals, r: UsageRecord): void {
  into.input += r.input;
  into.output += r.output;
  into.cacheRead += r.cacheRead;
  into.cacheWrite += r.cacheWrite;
  into.cost += r.cost;
  into.calls += 1;
}

/** 입력(캐시 포함)과 출력을 더한 토큰 수 */
export function tokensOf(t: UsageTotals): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite;
}

const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 기간의 시작(로컬 시각)과 구간 목록. 오늘은 시간별, 7·30일은 일별, 12개월은 월별 */
export function rangeBuckets(range: UsageRange, now = new Date()): { from: number; keys: Array<{ key: string; label: string }>; keyOf: (at: number) => string } {
  const keys: Array<{ key: string; label: string }> = [];
  if (range === "today") {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    for (let h = 0; h < 24; h++) keys.push({ key: `${dayKey(start)} ${pad(h)}`, label: `${h}시` });
    const keyOf = (at: number) => {
      const d = new Date(at);
      return `${dayKey(d)} ${pad(d.getHours())}`;
    };
    return { from: start.getTime(), keys, keyOf };
  }
  if (range === "12m") {
    const start = new Date(now.getFullYear(), now.getMonth() - 11, 1);
    for (let i = 0; i < 12; i++) {
      const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
      keys.push({ key: `${d.getFullYear()}-${pad(d.getMonth() + 1)}`, label: `${String(d.getFullYear()).slice(2)}.${d.getMonth() + 1}` });
    }
    const keyOf = (at: number) => {
      const d = new Date(at);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    };
    return { from: start.getTime(), keys, keyOf };
  }
  const days = range === "7d" ? 7 : 30;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    keys.push({ key: dayKey(d), label: `${d.getMonth() + 1}/${d.getDate()}` });
  }
  return { from: start.getTime(), keys, keyOf: (at: number) => dayKey(new Date(at)) };
}

export function summarizeUsage(records: UsageRecord[], range: UsageRange, now = new Date()): UsageSummary {
  const { from, keys, keyOf } = rangeBuckets(range, now);
  const total = zero();
  const buckets = new Map(keys.map((k) => [k.key, { ...k, ...zero() }]));
  const models = new Map<string, UsageTotals & { name: string }>();
  const sources = new Map<UsageSource, UsageTotals & { source: UsageSource }>();
  for (const r of records) {
    if (r.at < from || r.at > now.getTime()) continue;
    add(total, r);
    const bucket = buckets.get(keyOf(r.at));
    if (bucket) add(bucket, r);
    const name = `${r.provider}/${r.model}`;
    if (!models.has(name)) models.set(name, { name, ...zero() });
    add(models.get(name)!, r);
    if (!sources.has(r.source)) sources.set(r.source, { source: r.source, ...zero() });
    add(sources.get(r.source)!, r);
  }
  const byTokens = (a: UsageTotals, b: UsageTotals) => tokensOf(b) - tokensOf(a);
  return { range, from, total, buckets: [...buckets.values()], models: [...models.values()].sort(byTokens), sources: [...sources.values()].sort(byTokens) };
}
