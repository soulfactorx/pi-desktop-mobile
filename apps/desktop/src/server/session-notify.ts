/**
 * Pi Web의 휴대폰 알림 (설계 §5.10 "알림"). 보는 탭이 없을 때 세션 이벤트에서 알릴 것을 고른다.
 * 데스크톱 앱은 화면(App.tsx)이 OS 알림을 띄우지만, 휴대폰 브라우저는 백그라운드에서 연결이 끊겨 서버가 웹 푸시로 보낸다.
 * - agent_settled: 작업이 끝났다
 * - extension_ui_request의 대화상자(select·confirm·input·editor): 답을 기다린다
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

/** folder: 그 세션의 폴더 이름 */
export function sessionNote(event: unknown, folder: string): SessionNote | undefined {
  const e = event as { type?: unknown; method?: unknown; title?: unknown; message?: unknown } | undefined;
  if (!e || typeof e !== "object") return undefined;
  if (e.type === "agent_settled") return { title: `작업이 끝났습니다: ${folder}`, body: "세션을 열어 확인하세요." };
  if (e.type !== "extension_ui_request" || typeof e.method !== "string" || !DIALOGS.has(e.method)) return undefined;
  const title = typeof e.title === "string" ? e.title : "";
  const message = typeof e.message === "string" ? e.message : "";
  return { title: `답을 기다립니다: ${folder}`, body: clip(title || message || "세션을 열어 답하세요.") };
}
