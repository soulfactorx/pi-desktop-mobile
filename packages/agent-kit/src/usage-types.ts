/**
 * 사용량 집계 결과의 모양. 화면(렌더러)도 쓰므로 node 모듈을 import하지 않는다 (집계는 usage.ts).
 */

export type UsageSource = "chat" | "schedule" | "memory" | "document" | "worker" | "peer";

export interface UsageRecord {
  /** 호출이 끝난 때 (ms) */
  at: number;
  source: UsageSource;
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** 달러. Pi가 모르는 모델(로컬 등)은 0 */
  cost: number;
}

export type UsageRange = "today" | "7d" | "30d" | "12m";

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  calls: number;
}

export interface UsageBucket extends UsageTotals {
  key: string;
  label: string;
}

export interface UsageSummary {
  range: UsageRange;
  from: number;
  total: UsageTotals;
  buckets: UsageBucket[];
  /** 많이 쓴 순 */
  models: Array<UsageTotals & { name: string }>;
  sources: Array<UsageTotals & { source: UsageSource }>;
}
