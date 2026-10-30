/**
 * 활동 관찰의 기록 형식 (설계 DESIGN-MATE.md §10). 화면도 쓰므로 Node 코드 없이 타입만 둔다.
 *
 * 저장하는 것은 요약뿐이다: 요청·명령은 앞부분만, 비밀값처럼 보이는 것은 가린다. 파일 내용·모델 답변은 저장하지 않는다.
 */

/** 세션 하나를 읽으며 모으는 요약 */
export interface SessionAggregate {
  sessionId: string;
  cwd: string;
  startedAt: number;
  lastAt: number;
  prompts: number;
  /** 첫 요청 (앞부분, 가림 처리) */
  firstPrompt?: string;
  /** write·edit로 고친 파일 (최대 30개) */
  editedFiles: string[];
  /** bash 명령 수와, 테스트로 보이는 명령을 돌렸는지 */
  commands: number;
  ranTests: boolean;
  /** 실패한 명령 (앞부분, 최대 10개) */
  failures: string[];
  /** 모델 오류 (예: Connection error) */
  modelErrors: string[];
}

/** activity.jsonl 한 줄 */
export type ActivityRecord =
  | { at: number; kind: "session-ended"; session: SessionAggregate }
  | { at: number; kind: "project"; project: ProjectSnapshot }
  | { at: number; kind: "suggested"; topic: string; key: string; cwd: string; title: string; via: "rule" | "observer" };

/** 저장소 상태 (최근 작업한 폴더만 주기적으로) */
export interface ProjectSnapshot {
  cwd: string;
  branch: string;
  /** upstream보다 앞선 커밋 수 (upstream이 없으면 undefined) */
  ahead?: number;
  /** 커밋하지 않은 파일 수 */
  dirty: number;
  /** 처음 본 시각: 앞선 커밋·커밋 안 한 변경이 언제부터 있었는지 */
  aheadSince?: number;
  dirtySince?: number;
  checkedAt: number;
}

/** 제안 후보의 주제. 사용자가 버린 주제는 덜 알린다 */
export type InsightTopic = "untested-edit" | "repeated-failure" | "unpushed" | "uncommitted" | "session-error";

export interface Candidate {
  topic: InsightTopic;
  /** 같은 일을 두 번 알리지 않기 위한 열쇠 */
  key: string;
  cwd: string;
  title: string;
  /** 모델 없이 바로 알릴 때의 내용, 또는 관찰자에게 줄 근거 */
  detail: string;
  /** rule: 규칙만으로 바로 알림, observer: 모델이 살펴보고 제안 */
  via: "rule" | "observer";
  /** 관찰자가 맡길 수 있는 일의 지시 (사용자가 "Mate에게 맡기기"를 누르면 고치기로 실행) */
  followUp?: string;
}

/** 실행기 상태에 남기는 관찰 상태 */
export interface ObserverState {
  /** 세션 파일별로 어디까지 읽었는지 */
  files: Record<string, { offset: number; aggregate?: SessionAggregate; endedAt?: number }>;
  projects: Record<string, ProjectSnapshot>;
  /** 오늘 관찰 제안 수 */
  today: { date: string; count: number };
  /** 이미 알린 열쇠 (시각) */
  suggested: Record<string, number>;
  /** 관찰자에게 넘길 후보 (사용자가 쉬는 때를 기다림) */
  queue: Candidate[];
  /** 최근 끝난 세션 요약 (같은 실패 반복을 세션을 넘어 세기 위해, 최대 50개) */
  recent: SessionAggregate[];
  /** 관찰을 켠 시각. 그 전에 조용해진 세션은 읽지 않는다 (켜자마자 지난 기록으로 알림이 쏟아지지 않게) */
  since: number;
  /** 저장소 상태를 마지막으로 읽은 시각 */
  projectsAt?: number;
}

export const TOPIC_LABELS: Record<InsightTopic, string> = {
  "untested-edit": "고치고 테스트 안 함",
  "repeated-failure": "같은 실패 반복",
  unpushed: "push 안 한 커밋",
  uncommitted: "오래 커밋 안 한 변경",
  "session-error": "오류로 끝난 세션",
};
