/**
 * 승인 요청의 모양. permissions 확장과 앱이 함께 쓴다 (설계 DESIGN-AGENT.md §4 "승인 게이트").
 *
 * 확장은 `ctx.ui.select(title, options)`로 묻는다. RPC 확장 UI는 제목과 선택지 문자열만 전할 수 있어서,
 * 앱이 승인 화면을 따로 그릴 수 있도록 제목에 정해진 형식으로 정보를 싣는다. 터미널 pi에서는 그대로 읽힌다.
 *
 * 확장은 대상 호스트의 Pi가 jiti로 불러오므로 이 파일은 다른 모듈을 import하지 않는다.
 */

export type Risk = "read" | "write" | "exec" | "network";

export interface ApprovalRequest {
  toolName: string;
  risk: Exclude<Risk, "read">;
  /** 사람이 읽을 한 줄 요약 (예: "명령 실행", "파일 쓰기") */
  summary: string;
  /** 규칙 매칭 대상이자 화면에 크게 보일 값 (명령 또는 경로) */
  target: string;
  /** "항상 허용"을 고를 때 저장할 패턴 */
  pattern: string;
  /** 매번 한 번만 허용할 수 있다 (권한 상승). 세션·항상 허용과 저장된 규칙을 쓰지 않는다 */
  onceOnly?: boolean;
}

/** 제목 첫 줄. 앱은 이 줄로 승인 요청을 알아본다 */
export const APPROVAL_MARKER = "[승인 요청]";

export const ApprovalChoice = {
  once: "이번만 허용",
  session: "이 세션에서 계속 허용",
  always: "항상 허용",
  deny: "거부",
} as const;

export type ApprovalDecision = keyof typeof ApprovalChoice;

const RISK_LABEL: Record<ApprovalRequest["risk"], string> = { write: "쓰기", exec: "실행", network: "네트워크" };

export function formatApprovalTitle(request: ApprovalRequest): string {
  return [
    `${APPROVAL_MARKER} ${request.toolName} · ${RISK_LABEL[request.risk]} · ${request.summary}`,
    request.target,
  ].join("\n");
}

/** 선택지 문자열. 허용 범위가 보이도록 세션·항상 허용에는 패턴을 붙인다 */
export function approvalOptions(request: ApprovalRequest): string[] {
  if (request.onceOnly) return [ApprovalChoice.once, ApprovalChoice.deny];
  return [
    ApprovalChoice.once,
    `${ApprovalChoice.session}: ${request.pattern}`,
    `${ApprovalChoice.always}: ${request.pattern}`,
    ApprovalChoice.deny,
  ];
}

/** 고른 선택지 문자열을 결정으로 바꾼다. 취소·시간 초과(undefined)와 모르는 값은 거부다 */
export function decisionOf(choice: string | undefined): ApprovalDecision {
  if (choice === ApprovalChoice.once) return "once";
  if (choice?.startsWith(`${ApprovalChoice.session}:`)) return "session";
  if (choice?.startsWith(`${ApprovalChoice.always}:`)) return "always";
  return "deny";
}

export interface ParsedApproval {
  toolName: string;
  riskLabel: string;
  summary: string;
  target: string;
}

/** 앱이 승인 화면을 그릴 때 쓴다. 승인 요청이 아니면 undefined */
export function parseApprovalTitle(title: string): ParsedApproval | undefined {
  if (!title.startsWith(`${APPROVAL_MARKER} `)) return undefined;
  const newline = title.indexOf("\n");
  const head = (newline < 0 ? title : title.slice(0, newline)).slice(APPROVAL_MARKER.length + 1);
  const [toolName = "", riskLabel = "", ...rest] = head.split(" · ");
  return { toolName, riskLabel, summary: rest.join(" · "), target: newline < 0 ? "" : title.slice(newline + 1) };
}
