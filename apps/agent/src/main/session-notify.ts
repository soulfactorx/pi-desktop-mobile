import { APPROVAL_MARKER } from "@pi-desktop/agent-kit/approval";

/**
 * 대화의 소식을 OS 알림으로 (설계 DESIGN-AGENT.md "알림"). 창을 보고 있지 않을 때 Pi 이벤트에서 알릴 것을 고른다.
 * - agent_settled: 답이 끝났다 (Pi가 이어서 할 일까지 끝난 때)
 * - extension_ui_request의 대화상자(select·confirm·input·editor): 승인 요청이나 답을 기다린다
 * 알림·상태 표시(notify·setStatus 등)는 알리지 않는다.
 */

export interface SessionNote {
  title: string;
  body: string;
}

const DIALOGS = new Set(["select", "confirm", "input", "editor"]);
const clip = (text: string, n = 160) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
};

/** chat: 그 대화의 이름(없으면 폴더 이름) */
export function sessionNote(event: unknown, chat: string): SessionNote | undefined {
  const e = event as { type?: unknown; method?: unknown; title?: unknown; message?: unknown } | undefined;
  if (!e || typeof e !== "object") return undefined;
  if (e.type === "agent_settled") return { title: `답이 끝났습니다: ${chat}`, body: "대화를 열어 확인하세요." };
  if (e.type !== "extension_ui_request" || typeof e.method !== "string" || !DIALOGS.has(e.method)) return undefined;
  const title = typeof e.title === "string" ? e.title : "";
  if (title.startsWith(APPROVAL_MARKER)) return { title: `승인 요청: ${chat}`, body: clip(title.slice(APPROVAL_MARKER.length)) };
  const message = typeof e.message === "string" ? e.message : "";
  return { title: `답을 기다립니다: ${chat}`, body: clip(title || message || "대화를 열어 답하세요.") };
}
