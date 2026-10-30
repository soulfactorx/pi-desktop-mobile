import type { ChatLine, InboxItem } from "@pi-desktop/mate-kit/shared";
import type { ActivityRecord, ProjectSnapshot } from "./activity-types";
import type { Duty, InboxStatus, MateConfig, MateTrashItem, RunnerState, RunRecord, RunStatus } from "./types";

/**
 * Mate 앱 화면이 실행기에서 받는 모양 (설계 DESIGN-MATE-REMOTE.md §2.2). 앱 렌더러도 쓰므로 타입만 둔다.
 * 실행기의 app-api가 만들고 mate.call로 보낸다.
 */

export interface DutyView extends Duty {
  lastRunAt?: number;
  lastStatus?: RunStatus;
  nextRunAt?: number;
  /** "지금 실행"을 눌러 실행기를 기다리는 중 */
  queued: boolean;
  /** 변화 계기: 감지해서 실행을 기다리는 변화 */
  pendingChange?: { cause: string; since: number };
}

/** 실행 세션을 읽기 전용으로 보여 줄 때의 한 줄 */
export type TranscriptItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; args: string; result?: string; isError?: boolean }
  | { kind: "note"; text: string };

export interface InboxView extends InboxItem {
  /** 없으면 새 제안 */
  status?: InboxStatus;
  dutyName: string;
}

export interface RunnerView {
  alive: boolean;
  pid?: number;
  heartbeatAt?: number;
  current?: RunnerState["current"];
  today: RunnerState["today"];
  /** 휴대폰 연결(텔레그램)이 켜져 있다. 토큰이 있어도 원격 실행기가 다시 뜬 뒤 앱이 붙기 전에는 꺼져 있다 */
  phone?: boolean;
  /** 실행기를 띄우지 못했을 때 이유 */
  error?: string;
}

/** Mate 대화 (설계 DESIGN-MATE.md §13) */
export interface ChatView {
  /** 최근 대화 줄 (오래된 것부터) */
  lines: ChatLine[];
  /** 실행기가 답을 만드는 중 */
  busy?: { since: number; source: "app" | "telegram" };
  /** 대화에서 시작해 결과를 기다리는 실행 수 */
  pending: number;
}

export interface Overview {
  home: string;
  chat: ChatView;
  config: MateConfig;
  duties: DutyView[];
  inbox: InboxView[];
  runs: RunRecord[];
  runner: RunnerView;
  observe: ObserveView;
  /** 휴지통 (지운 임무·실행 기록·대화, 최근 것부터) */
  trash: MateTrashItem[];
}

/** 활동 관찰 화면 (M4) */
export interface ObserveView {
  /** 최근 활동 기록 (새것부터) */
  activity: ActivityRecord[];
  /** 관찰자가 살펴보길 기다리는 후보 수 */
  queue: number;
  today: { date: string; count: number };
  projects: ProjectSnapshot[];
  /** 주제별 사용자 반응 (보여 줌·받아들임·버림) */
  feedback: Record<string, { shown: number; accepted: number; dismissed: number }>;
  since?: number;
}

/** 화면에서 만들거나 고친 임무. id가 없으면 새 임무 */
export type DutyDraft = Omit<Duty, "id" | "createdAt" | "updatedAt"> & { id?: string };
