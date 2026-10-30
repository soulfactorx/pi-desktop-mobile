/**
 * 지식베이스 항목의 모양. 앱 화면(렌더러)도 쓰므로 아무것도 import하지 않는다 (파일 읽기·쓰기는 store.ts).
 * desktop-agent의 지식베이스(MemoryEntry)를 Pi 방식의 Markdown 파일로 옮겼다.
 */

/** user: 사용자의 역할·환경·선호, requirement: 진행 중인 일·목표·제약·결정, lesson: 실수와 재발 방지, reference: 자료·문서 위치 */
export type MemoryType = "user" | "requirement" | "lesson" | "reference";
export const MEMORY_TYPES: MemoryType[] = ["user", "requirement", "lesson", "reference"];
export const TYPE_LABEL: Record<MemoryType, string> = { user: "사용자", requirement: "요구사항", lesson: "교훈", reference: "참조" };

/** 피어 답변·카드 초안 같은 바깥으로 나가는 곳에 쓰지 않을 항목에 붙이는 태그 */
export const NO_SHARE_TAG = "공유제외";

export interface KnowledgeEntry {
  id: string;
  type: MemoryType;
  /** 한 줄 요약. 회상 목록에 이것만 실린다 */
  title: string;
  /** 본문 (Markdown) */
  content: string;
  tags: string[];
  status: "active" | "archived";
  /** 고정: 요청과 상관없이 본문을 늘 싣는다 */
  pinned: boolean;
  /** agent: 대화에서 자동·도구로 저장, user: 사람이 직접 씀 */
  origin: "agent" | "user";
  /** 도구로 확인한 것이 없는 대화에서 나온 항목. 점검 대기함에 오르고 회상할 때 표시가 붙는다 */
  unverified?: boolean;
  created: string;
  updated: string;
  /** 점검 대기함에서 확인한 때 */
  reviewed?: string;
  /** 어느 대화에서 나왔는지 (세션 파일 경로 등) */
  source?: string;
  /** 실제로 프롬프트에 실린 횟수와 마지막 때 (노후 판정) */
  recallCount?: number;
  lastRecalledAt?: string;
}

export type ReviewKind = "duplicate" | "stale" | "malformed" | "unverified";

export interface ReviewItem {
  kind: ReviewKind;
  id: string;
  title: string;
  type: MemoryType;
  /** 왜 걸렸는지 사람이 읽는 설명 */
  reason: string;
  /** duplicate일 때 짝 */
  pairId?: string;
  pairTitle?: string;
}

export interface KnowledgeStats {
  active: number;
  archived: number;
  pinned: number;
  unverified: number;
  byType: Record<MemoryType, number>;
  /** 많이 쓰인 태그 순 */
  tags: Array<{ tag: string; count: number }>;
}

export type BulkAction = "archive" | "activate" | "delete" | "pin" | "unpin" | "addTag" | "removeTag";

/** 새로 쓰거나 고칠 때 받는 칸 */
export interface EntryInput {
  type: MemoryType;
  title: string;
  content: string;
  tags?: string[];
  pinned?: boolean;
}
