/**
 * mate-kit 확장·실행기·앱이 함께 쓰는 이름과 형식 (설계 DESIGN-MATE.md §2.2, §5).
 * 실행기는 이 환경 변수로 실행마다의 권한 단계와 인박스 위치를 확장에 넘긴다.
 */
export const MATE_ENV = {
  /** 권한 단계. 없으면 확장은 아무것도 막지 않는다 (터미널 pi에 설치한 경우) */
  profile: "PI_DESKTOP_MATE_PROFILE",
  /** 제안을 쌓을 inbox.jsonl 경로 */
  inbox: "PI_DESKTOP_MATE_INBOX",
  dutyId: "PI_DESKTOP_MATE_DUTY",
  runId: "PI_DESKTOP_MATE_RUN",
  /** act: write·edit를 허용하는 작업 공간(git worktree) 루트 */
  writeRoot: "PI_DESKTOP_MATE_WRITE_ROOT",
  /** 관찰자 실행: 제안에 붙일 주제 */
  topic: "PI_DESKTOP_MATE_TOPIC",
  /** Mate 대화 기록(chat.jsonl). mate_ask가 질문을 여기에 남긴다 */
  chat: "PI_DESKTOP_MATE_CHAT",
  /** 대화 한 차례에서 mate_do가 남기는 할 일 목록 (실행기가 대화가 끝난 뒤 처리) */
  actions: "PI_DESKTOP_MATE_ACTIONS",
  /** 사용자가 이 임무에 허용한 명령 이름과 MCP 도구 이름 (쉼표로 구분, 예: curl,mcp__github__list_prs). mate-guard가 통과시킨다 */
  grants: "PI_DESKTOP_MATE_GRANTS",
  /** 허용 목록에 없어 막힌 명령을 남기는 파일(JSONL). 실행이 끝나면 실행기가 읽어 사용자에게 허용을 묻는다 */
  blocked: "PI_DESKTOP_MATE_BLOCKED",
} as const;

/**
 * MCP 도구 이름인지 (`mcp__<서버>__<도구>`, Pi가 서버 이름의 `-`를 `_`로 바꾼 것).
 * Mate는 MCP 도구가 읽기인지 쓰기인지 알 수 없어 도구마다 허용을 받는다 (설계 DESIGN-MATE.md §4 "권한 요청" 5)
 */
export function isMcpToolName(name: string): boolean {
  return /^mcp__[A-Za-z0-9_]{1,64}__[A-Za-z0-9_.-]{1,128}$/.test(name);
}

/** 막힌 명령의 허용을 묻는 질문의 선택지. 첫째가 허용이다 */
export const PERMISSION_OPTIONS = ["허용하고 다시 실행", "허용하지 않음"] as const;

/** mate-guard가 막힌 명령마다 남기는 한 줄 */
export interface BlockedCommand {
  /** 허용을 물을 명령 이름 (예: curl) 또는 MCP 도구 이름 (mcp__<서버>__<도구>) */
  name: string;
  /** 실제로 실행하려던 명령, MCP 도구면 도구 설명 (질문에 보여 준다) */
  command: string;
  at: number;
}

export const PROPOSE_TOOL = "mate_propose";
export const ASK_TOOL = "mate_ask";
export const DO_TOOL = "mate_do";

/** observe: 읽기만, propose: 읽기 + 제안, act: 별도 작업 공간에서 고치고 승인을 기다림 (M3) */
export type MateProfile = "observe" | "propose" | "act";

export const PROFILES: readonly MateProfile[] = ["observe", "propose", "act"];

export function isProfile(value: unknown): value is MateProfile {
  return typeof value === "string" && (PROFILES as readonly string[]).includes(value);
}

/** 임무 단계 + Mate 대화(chat). 대화는 임무로 만들 수 없어 PROFILES에는 없다 */
export type GuardProfile = MateProfile | "chat";

export function isGuardProfile(value: unknown): value is GuardProfile {
  return value === "chat" || isProfile(value);
}

/**
 * 권한 단계마다 모델에 선언하는 도구. 실행기는 이 목록으로 `--tools`를 만든다.
 * - 제안·고치기 실행은 mate_ask로 사용자에게 대화로 물을 수 있다
 * - 대화(chat)는 읽기와 mate_do(실행기에 할 일 맡기기)만. 파일을 직접 바꾸지 않는다
 */
export function profileTools(profile: GuardProfile): string[] {
  const read = ["read", "grep", "find", "ls", "bash"];
  switch (profile) {
    case "observe":
      return read;
    case "propose":
      return [...read, PROPOSE_TOOL, ASK_TOOL];
    case "act":
      return [...read, "edit", "write", PROPOSE_TOOL, ASK_TOOL];
    case "chat":
      return [...read, DO_TOOL];
  }
}

/** Mate 대화 한 줄 (chat.jsonl, 추가만 한다) */
export interface ChatLine {
  id: string;
  at: number;
  /** user: 사용자, mate: Mate 답·알림·질문 */
  role: "user" | "mate";
  text: string;
  /** reply: 대화 답, question: Mate가 먼저 묻는 질문, notice: 할 일 처리 알림, result: 실행 결과, divider: 새 대화 */
  kind?: "reply" | "question" | "notice" | "result" | "divider";
  /** 어디서 온 말인지 / 답을 어디로 보낼지 */
  source?: "app" | "telegram";
  /** 질문의 선택지 (버튼) */
  options?: string[];
  /** 이 말이 답하는 질문 */
  answerTo?: string;
  /** 질문을 남긴 실행·임무 (맥락) */
  runId?: string;
  dutyId?: string;
  /** 질문을 남긴 폴더 (답에 따라 그 폴더에서 일을 맡길 수 있게) */
  cwd?: string;
  /**
   * 막힌 명령의 허용을 묻는 질문이면 그 임무와 명령 이름. 답(PERMISSION_OPTIONS)은 모델을 거치지 않고
   * 실행기가 바로 처리한다: 허용하면 임무에 저장하고 다시 실행한다
   */
  permission?: { dutyId: string; commands: string[] };
}

export type Severity = "info" | "warn" | "action";

/** act 실행이 작업 공간에 남긴 변경 (인박스에서 적용·버리기) */
export interface ChangeInfo {
  /** 사용자 저장소 루트 */
  repo: string;
  /** git worktree 폴더 (Mate 홈 worktrees/ 안, 브랜치 없이 분리된 HEAD). 변경은 커밋하지 않고 여기 남는다 */
  worktree: string;
  /** 작업 공간을 만든 커밋 */
  base: string;
  /** 바뀐 파일 (저장소 기준 경로) */
  files: string[];
}

/**
 * Mate가 제안하는 설치 (설계 DESIGN-APPS.md §3.4 "Mate가 제안해서 만들기·추가하기").
 * 모델은 제안만 남기고, 사용자가 적용하면 실행기 코드가 Mate 홈에 넣는다.
 * - skill: 새 스킬 초안. content는 SKILL.md 전체 (지침 파일만, 스크립트 없음)
 * - mcp: 정해 둔 목록(pi-isolation mcp-presets)의 서버 id
 * - copy: Pi Desktop(`~/.pi/agent/skills`)이나 Agent(`~/.pi-desktop-agent/skills`)의 스킬을 Mate 홈으로 복사
 */
export type InstallProposal =
  | { kind: "skill"; name: string; content: string }
  | { kind: "mcp"; preset: string }
  | { kind: "copy"; from: "pi-desktop" | "agent"; name: string };

/** inbox.jsonl 한 줄. 한 번 쓰면 바꾸지 않는다 (상태는 inbox-state.json) */
export interface InboxItem {
  id: string;
  /** 중복 제거용: 임무 + 제목 + 요약 (act 변경은 임무 + 패치) */
  hash: string;
  dutyId: string;
  runId: string;
  title: string;
  summary: string;
  /** 근거·파일·명령 출력 (Markdown) */
  detail?: string;
  severity: Severity;
  createdAt: number;
  /** act 실행의 변경. 있으면 인박스에서 "적용"할 수 있다 */
  change?: ChangeInfo;
  /** 활동 관찰이 남긴 제안의 주제 (사용자가 계속 버리는 주제는 덜 알린다) */
  topic?: string;
  /** 사용자가 "Mate에게 맡기기"를 누르면 이 지시로 고치기를 실행한다 (cwd 폴더에서) */
  followUp?: { prompt: string; cwd: string };
  /** 설치 제안. 있으면 받아들이기가 "적용"이 된다 */
  install?: InstallProposal;
}
