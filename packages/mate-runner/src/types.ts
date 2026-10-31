import type { MateProfile } from "@pi-desktop/mate-kit/shared";
import type { ObserverState } from "./activity-types";

export * from "./activity-types";

/** 언제 돌릴지 (설계 DESIGN-MATE.md §3) */
export type Trigger =
  | { kind: "manual" }
  /**
   * N분마다. from·to("HH:MM", 로컬 시각)를 주면 그 시간대에만 돈다 (from이 to보다 늦으면 자정을 넘는 시간대).
   * weekdays: 0(일)~6(토), 없으면 매일
   */
  | { kind: "interval"; minutes: number; from?: string; to?: string; weekdays?: number[] }
  /** time: "HH:MM"(로컬 시각), weekdays: 0(일)~6(토), 없으면 매일 */
  | { kind: "daily"; time: string; weekdays?: number[] }
  /** 저장소 변화: 새 커밋이나 브랜치 바뀜 (M2) */
  | { kind: "git"; cooldownMinutes?: number }
  /** 작업 폴더 파일 변화: 저장이 잠잠해진 뒤 한 번 (M2) */
  | { kind: "files"; quietSeconds?: number; cooldownMinutes?: number }
  /** 읽기 명령을 주기적으로 돌려 결과가 바뀌면 (M2). 명령은 mate-guard의 읽기 허용 목록을 통과해야 한다 */
  | { kind: "poll"; command: string; minutes: number }
  /** 작업을 마치면: 이 폴더에서 사용자의 Pi 세션이 끝났을 때 (M4, 활동 관찰이 켜져 있어야 함) */
  | { kind: "session"; cooldownMinutes?: number };

export type ChangeTrigger = Extract<Trigger, { kind: "git" | "files" | "poll" | "session" }>;

export function isChangeTrigger(trigger: Trigger): trigger is ChangeTrigger {
  return trigger.kind === "git" || trigger.kind === "files" || trigger.kind === "poll" || trigger.kind === "session";
}

export interface Duty {
  id: string;
  name: string;
  enabled: boolean;
  /** 작업 폴더 */
  cwd: string;
  /** 모델에 주는 지시 */
  prompt: string;
  profile: MateProfile;
  trigger: Trigger;
  /** 없으면 Mate 설정의 기본 모델 */
  model?: string;
  timeoutSec?: number;
  /** 없으면 Mate 설정의 실행당 비용 상한 */
  maxCostUsd?: number;
  /**
   * 사용자가 이 임무에 허용한 명령 이름 (예: curl). 읽기 전용 허용 목록에 더해 bash로 쓸 수 있다.
   * 막힌 명령의 허용 질문에 "허용"으로 답하면 더해진다 (설계 DESIGN-MATE.md §4 "권한 요청")
   */
  grants?: string[];
  /** 이 임무가 쓸 스킬 이름 (Mate 홈 skills/ 아래 폴더). 없으면 전부, 빈 배열이면 없음 (DESIGN-APPS.md §3.4) */
  skills?: string[];
  /** 이 임무가 쓸 MCP 서버 이름 (Mate 홈 mcp.json). 없거나 비면 MCP를 쓰지 않는다. 도구는 처음 쓸 때 허용을 묻는다 */
  mcpServers?: string[];
  createdAt: number;
  updatedAt?: number;
}

export interface MateConfig {
  /** provider/id 형식. 빈 문자열이면 Pi 기본 모델을 따른다 (--model을 넘기지 않음) */
  model: string;
  /** 켜면 시간표·변화 실행을 하지 않는다 ("지금 실행"은 함) */
  paused: boolean;
  /** 하루 자동 실행 상한 (모든 임무 합계) */
  dailyRunLimit: number;
  /** 실행당 비용 상한(USD). 넘으면 그 실행을 멈춘다. 0이면 없음 */
  maxCostUsd: number;
  /** 활동 관찰 (M4) */
  observe: ObserveConfig;
  /** 휴대폰 연결 (텔레그램) */
  telegram: TelegramConfig;
  /** Mate 대화에서 쓸 MCP 서버 (DESIGN-APPS.md §3.4). 비면 대화는 MCP를 쓰지 않는다 */
  chatMcpServers: string[];
  /** Mate 대화에서 허용한 MCP 도구 이름 (mcp__<서버>__<도구>) */
  chatGrants: string[];
}

/**
 * 휴대폰 연결 설정 (설계 DESIGN-MATE.md §12). 앱이 쓰고 실행기가 읽는다.
 * 봇 토큰은 여기에 두지 않는다: 앱이 OS 키체인으로 암호화한 값(tokenEnc)만 두고, 실행기를 띄울 때 풀어서 환경 변수로 넘긴다.
 */
export interface TelegramConfig {
  enabled: boolean;
  /** 앱이 safeStorage로 암호화한 봇 토큰 (base64). 실행기는 풀 수 없다 */
  tokenEnc?: string;
  /** 화면 표시용: 봇 이름(@...)과 토큰 끝 4자리 */
  botName?: string;
  tokenHint?: string;
  /** 짝짓기 코드와 만료 시각. 봇에게 "/start 코드"를 보내면 그 채팅을 연결한다 */
  pairingCode?: string;
  pairingExpires?: number;
  /** 연결 해제할 때 올린다. 실행기의 연결 상태(remote.json)가 이 값과 다르면 연결이 없는 것으로 본다 */
  pairEpoch: number;
  /** 알릴 것: action = 할 일·확인 필요·고친 변경만, all = 전부 */
  notify: "action" | "all";
  /** 조용한 시간 (로컬 "HH:MM"). 이 동안 생긴 알림은 끝나면 보낸다 */
  quiet?: { start: string; end: string };
  /** diff·근거 내용을 휴대폰으로 보내도 되는지 */
  sendDetail: boolean;
  /** 휴대폰에서 고치기(/fix, 맡기기)를 허용하는지 */
  allowFix: boolean;
  /** 앱에서 나눈 대화도 휴대폰으로 보내는지. 조용한 시간에는 보내지 않고 건너뛴다 (나중에 /history로 본다) */
  mirrorApp: boolean;
  /** mirrorApp을 켠 시각. 그 뒤의 앱 대화만 보낸다 (켜자마자 지난 대화가 쏟아지지 않게) */
  mirrorAppSince?: number;
}

/**
 * 활동 관찰 설정 (설계 DESIGN-MATE.md §10). 기본은 꺼짐: 사용자가 켜야 Pi 세션 기록을 읽는다.
 */
export interface ObserveConfig {
  enabled: boolean;
  /** Pi 세션이 이만큼 조용하면 "작업이 끝남"으로 본다 */
  quietMinutes: number;
  /** 하루 관찰 제안 상한 (규칙·분석 합계) */
  dailySuggestionLimit: number;
  /** 관찰하지 않을 폴더 (이 안의 세션·저장소는 보지 않음) */
  excluded: string[];
}

export const DEFAULT_CONFIG: MateConfig = {
  model: "anthropic/claude-haiku-5-5",
  paused: false,
  dailyRunLimit: 20,
  maxCostUsd: 0.5,
  observe: { enabled: false, quietMinutes: 5, dailySuggestionLimit: 5, excluded: [] },
  telegram: { enabled: false, pairEpoch: 0, notify: "action", sendDetail: true, allowFix: false, mirrorApp: false },
  chatMcpServers: [],
  chatGrants: [],
};

export const DEFAULT_TIMEOUT_SEC = 300;

/** Mate 대화 한 차례를 실행할 때 쓰는 임무 id (파일로 저장되지 않는다). 대화의 허용 질문도 이 id로 묻는다 */
export const CHAT_DUTY_ID = "mate-chat";
/** interval·poll 계기의 최소 간격 (비용·소음 방지) */
export const MIN_INTERVAL_MINUTES = 15;
/** 변화 계기: 한 번 돈 뒤 다음 실행까지 기본 쉬는 시간 */
export const DEFAULT_COOLDOWN_MINUTES = 15;
export const MIN_COOLDOWN_MINUTES = 5;
/** 파일 계기: 마지막 변경 뒤 이만큼 잠잠해야 실행 (저장이 몰릴 때 한 번만) */
export const DEFAULT_QUIET_SECONDS = 60;

export type RunStatus = "running" | "done" | "failed" | "timeout" | "budget";

export interface RunRecord {
  id: string;
  dutyId: string;
  dutyName: string;
  /** schedule: 시간표, change: 변화 감지, manual: 지금 실행, observe: 활동 관찰자 */
  reason: "schedule" | "change" | "manual" | "observe";
  /** 휴대폰에서 시작한 실행 */
  remote?: boolean;
  /** 변화 감지로 돌았을 때 무엇이 바뀌었는지 */
  cause?: string;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  model: string;
  profile: MateProfile;
  /** 마지막 답변 (길면 자름) */
  summary?: string;
  error?: string;
  costUsd?: number;
  tokens?: number;
  /** 이 실행에서 인박스에 새로 남긴 제안 수 */
  proposals?: number;
  sessionId?: string;
  /** act: 인박스에 올린 변경의 파일 수 */
  changeFiles?: number;
  /** Mate 홈 sessions/ 안의 Pi 세션 파일 */
  sessionFile?: string;
}

/** 변화 계기가 본 것과, 실행을 기다리는 변화 */
export interface WatchState {
  /** 무엇을 지켜보는지 (계기 종류·폴더·명령). 바뀌면 기준을 다시 잡는다 */
  key: string;
  /** git: "브랜치@커밋", poll: 출력 해시. 처음 본 값은 기준으로만 삼고 실행하지 않는다 */
  signature?: string;
  /** poll: 마지막으로 명령을 돌린 시각 */
  polledAt?: number;
  /** 실행을 기다리는 변화 */
  pending?: {
    since: number;
    lastAt: number;
    cause: string;
    count: number;
    /** files: 바뀐 파일 (중복 없이, 앞의 20개까지). 저장 한 번에 이벤트가 여러 번 와도 한 번으로 센다 */
    files?: string[];
  };
}

export interface RunnerState {
  pid?: number;
  /** 실행기 번들의 해시. 앱이 자기 번들과 다르면 실행기를 바꾼다 */
  build?: string;
  startedAt?: number;
  heartbeatAt?: number;
  duties: Record<string, { lastRunAt?: number; lastStatus?: RunStatus; watch?: WatchState }>;
  /** 오늘(로컬 날짜) 자동 실행 수와 비용 (지금 실행 포함한 비용) */
  today: { date: string; count: number; costUsd?: number };
  current?: { runId: string; dutyId: string; startedAt: number };
  /** 활동 관찰 (M4) */
  observer?: ObserverState;
}

/** "지금 실행" 요청 (requests/<시각>-<id>.json) */
export interface RunRequest {
  dutyId: string;
  requestedAt: number;
}

/** accepted: 확인함, dismissed: 버림, applied: act 변경을 적용함 */
export type InboxStatus = "accepted" | "dismissed" | "applied";

/** inbox-state.json: 제안별 사용자 처리 상태. 없으면 "새 제안" */
export type InboxState = Record<string, { status: InboxStatus; at: number }>;

/** 휴지통 항목의 종류: 임무·실행 기록·대화 기록·스킬 (DESIGN-APPS.md §3.2) */
export type TrashKind = "duty" | "run" | "chat" | "skill";

/** 휴지통 항목 하나 (trash.ts) */
export interface MateTrashItem {
  id: string;
  kind: TrashKind;
  /** 목록에 보일 이름 (임무 이름, "오래된 실행 기록 3개 정리" 등) */
  title: string;
  /** 한 줄 설명 (기간·폴더 등) */
  detail?: string;
  deletedAt: number;
  /** 함께 옮긴 파일 수 */
  files: number;
}
