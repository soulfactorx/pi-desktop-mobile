import type { ChatLine, InboxItem } from "@pi-desktop/mate-kit";
import { redact } from "../activity";
import { parseTime } from "../schedule";
import type { TelegramConfig } from "../types";

/**
 * 휴대폰(텔레그램)으로 보내는 글과 버튼, 받은 명령 해석 (설계 DESIGN-MATE.md §12). 모두 순수 함수다.
 * 글은 텔레그램 HTML 형식이다. 보내는 글은 비밀값처럼 보이는 것을 가리고 길이를 줄인다.
 */

const SEVERITY: Record<InboxItem["severity"], string> = { info: "참고", warn: "확인 필요", action: "할 일" };

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** 보내도 되는 글로: 비밀값 가리기 + HTML 이스케이프 + 길이 제한 */
export function safe(text: string, limit = 800): string {
  return escapeHtml(clip(redact(text), limit));
}

/** 알릴 항목인지: action이면 할 일·확인 필요·고친 변경만 */
export function shouldNotify(item: InboxItem, notify: TelegramConfig["notify"]): boolean {
  if (notify === "all") return true;
  return item.severity !== "info" || !!item.change || !!item.followUp || !!item.install;
}

/** 조용한 시간 안인지 (자정을 넘는 구간도: 23:00~08:00) */
export function inQuietHours(quiet: TelegramConfig["quiet"], now: number): boolean {
  if (!quiet) return false;
  const s = parseTime(quiet.start);
  const e = parseTime(quiet.end);
  if (!s || !e) return false;
  const d = new Date(now);
  const m = d.getHours() * 60 + d.getMinutes();
  const start = s.hour * 60 + s.minute;
  const end = e.hour * 60 + e.minute;
  if (start === end) return false;
  return start < end ? m >= start && m < end : m >= start || m < end;
}

export interface Button {
  text: string;
  callback_data: string;
}

/** 인박스 항목 알림 글 */
export function itemText(item: InboxItem, dutyName: string): string {
  const lines = [`<b>[${SEVERITY[item.severity]}] ${safe(item.title, 200)}</b>`, `<i>${safe(dutyName, 80)}</i>`, "", safe(item.summary, 900)];
  if (item.change) {
    const files = item.change.files;
    lines.push("", `바뀐 파일 ${files.length}개: ${safe(files.slice(0, 6).join(", "), 300)}${files.length > 6 ? " …" : ""}`);
    lines.push("적용 전까지 PC의 작업 폴더는 그대로입니다.");
  }
  if (item.followUp) lines.push("", `맡길 일: ${safe(item.followUp.prompt, 300)}`);
  if (item.install) {
    const what = item.install.kind === "skill" ? `새 스킬 ${item.install.name}` : item.install.kind === "mcp" ? `MCP 서버 ${item.install.preset}` : `${item.install.from === "agent" ? "Agent" : "Pi Desktop"} 스킬 ${item.install.name} 복사`;
    lines.push("", `설치 제안: ${safe(what, 120)}. 적용하면 Mate에 넣습니다 ("자세히"로 내용 확인)`);
  }
  return lines.join("\n");
}

/** 항목에 붙일 버튼 (callback_data는 64바이트 이하: 한 글자 동작 + ":" + 항목 id) */
export function itemButtons(item: InboxItem, opts: { sendDetail: boolean; allowFix: boolean }): Button[][] {
  const detail = opts.sendDetail && (item.detail || item.change || item.install) ? [{ text: item.change ? "diff 보기" : "자세히", callback_data: `v:${item.id}` }] : [];
  if (item.change || item.install) {
    return [[{ text: "적용", callback_data: `a:${item.id}` }, { text: "버리기", callback_data: `x:${item.id}` }], detail].filter((r) => r.length > 0);
  }
  const first: Button[] = [];
  if (item.followUp && opts.allowFix) first.push({ text: "Mate에게 맡기기", callback_data: `g:${item.id}` });
  first.push({ text: "확인함", callback_data: `k:${item.id}` }, { text: "버리기", callback_data: `d:${item.id}` });
  return [first, detail].filter((r) => r.length > 0);
}

/** 적용 전 한 번 더 묻는 버튼 */
export function confirmApplyButtons(itemId: string): Button[][] {
  return [[{ text: "예, 적용", callback_data: `A:${itemId}` }, { text: "취소", callback_data: `c:${itemId}` }]];
}

export type Callback = { action: "apply" | "confirmApply" | "cancel" | "discard" | "accept" | "dismiss" | "delegate" | "view"; itemId: string };

const CALLBACKS: Record<string, Callback["action"]> = {
  a: "confirmApply",
  A: "apply",
  c: "cancel",
  x: "discard",
  k: "accept",
  d: "dismiss",
  g: "delegate",
  v: "view",
};

export function parseCallback(data: string | undefined): Callback | undefined {
  const m = /^([aAcxkdgv]):([\w-]{1,60})$/.exec(data ?? "");
  return m ? { action: CALLBACKS[m[1]!]!, itemId: m[2]! } : undefined;
}

/** 대화 질문의 선택지 버튼: "o:<대화 줄 id>:<번호>" */
export function optionButtons(lineId: string, options: string[]): Button[][] {
  return options.slice(0, 4).map((text, i) => [{ text: text.slice(0, 40), callback_data: `o:${lineId}:${i}` }]);
}

export function parseOptionCallback(data: string | undefined): { lineId: string; index: number } | undefined {
  const m = /^o:([\w-]{1,60}):([0-3])$/.exec(data ?? "");
  return m ? { lineId: m[1]!, index: Number(m[2]) } : undefined;
}

export type Command =
  | { kind: "start"; code?: string }
  | { kind: "help" }
  | { kind: "status" }
  | { kind: "inbox" }
  | { kind: "duties" }
  | { kind: "folders" }
  | { kind: "run"; query: string }
  | { kind: "ask" | "fix"; text: string }
  | { kind: "new" }
  /** 지금 대화의 최근 줄을 앱·휴대폰 구분 없이 다시 보기 */
  | { kind: "history"; count: number }
  /** 빗금 없는 글: Mate와 대화 (설계 §13) */
  | { kind: "chat"; text: string };

/** 받은 글을 명령으로. 빗금 없이 보낸 글은 대화로 본다 */
export function parseCommand(text: string): Command | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const m = /^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(t);
  if (!m) return { kind: "chat", text: t };
  const arg = (m[2] ?? "").trim();
  switch (m[1]!.toLowerCase()) {
    case "start":
      return arg ? { kind: "start", code: arg } : { kind: "start" };
    case "help":
      return { kind: "help" };
    case "status":
      return { kind: "status" };
    case "inbox":
      return { kind: "inbox" };
    case "duties":
      return { kind: "duties" };
    case "folders":
      return { kind: "folders" };
    case "run":
      return { kind: "run", query: arg };
    case "ask":
      return { kind: "ask", text: arg };
    case "fix":
      return { kind: "fix", text: arg };
    case "new":
      return { kind: "new" };
    case "history": {
      const n = Number.parseInt(arg, 10);
      return { kind: "history", count: Number.isFinite(n) ? Math.min(Math.max(n, 1), HISTORY_MAX) : HISTORY_DEFAULT };
    }
    default:
      return { kind: "help" };
  }
}

/** /history가 기본으로 보여 주는 줄 수와 최대 */
export const HISTORY_DEFAULT = 10;
export const HISTORY_MAX = 30;

function hhmm(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * /history의 답: 지금 대화(마지막 "새 대화" 뒤)의 최근 줄을 앱(🖥)·휴대폰(📱) 표시와 함께 보여 준다.
 * 텔레그램 한 메시지 한도를 넘지 않게 줄 단위로 나눈 메시지들을 돌려준다 (HTML 태그가 잘리지 않게).
 */
export function historyMessages(lines: ChatLine[], count: number, limit = 3500): string[] {
  const lastDivider = lines.findLastIndex((l) => l.kind === "divider");
  const shown = lines.slice(lastDivider + 1).filter((l) => l.kind !== "divider").slice(-count);
  if (shown.length === 0) return ["아직 이 대화에서 나눈 말이 없어요."];
  const entries = shown.map((l) => {
    const where = l.source === "telegram" ? "📱" : "🖥";
    const who = l.role === "user" ? `${where} <b>나</b>` : `🤖 <b>Mate</b>${l.kind === "question" ? " (질문)" : ""}`;
    return `<i>${hhmm(l.at)}</i> ${who}\n${safe(l.text, l.role === "user" ? 500 : 800)}`;
  });
  const messages: string[] = [];
  let current = `<b>최근 대화 ${shown.length}줄</b> (🖥 앱 · 📱 휴대폰)`;
  for (const entry of entries) {
    if (current.length + entry.length + 2 > limit) {
      messages.push(current);
      current = entry;
    } else current += `\n\n${entry}`;
  }
  messages.push(current);
  return messages;
}

/** 앱 대화를 휴대폰으로 보낼 때의 글 (설정 "앱 대화도 휴대폰으로 보내기") */
export function mirrorText(line: ChatLine): string {
  if (line.role === "user") return `🖥 <b>앱에서</b>\n${safe(line.text, 1500)}`;
  return `🖥 ${line.kind === "question" ? "❓ " : ""}${safe(line.text, 3500)}`;
}

/** 폴더 이름(마지막 폴더명, 대소문자 무시) */
export function folderAlias(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).at(-1)?.toLowerCase() ?? path.toLowerCase();
}

/**
 * 지시의 첫 낱말이 아는 폴더 이름이면 그 폴더, 아는 폴더가 하나뿐이면 그 폴더.
 * 고르지 못하면 folder 없이 돌려준다 (사용자에게 폴더를 물음).
 */
export function resolveFolder(text: string, folders: string[]): { folder?: string; rest: string } {
  const [first = "", ...rest] = text.trim().split(/\s+/);
  const hit = folders.find((f) => folderAlias(f) === first.toLowerCase());
  if (hit) return { folder: hit, rest: rest.join(" ").trim() };
  if (folders.length === 1) return { folder: folders[0]!, rest: text.trim() };
  return { rest: text.trim() };
}

/** 긴 글(diff)을 텔레그램 한 메시지 한도(4096자) 아래로 나눈다. 최대 parts개 */
export function chunks(text: string, size = 3500, parts = 3): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length && out.length < parts; i += size) out.push(text.slice(i, i + size));
  if (text.length > size * parts) out[out.length - 1] += "\n… (나머지는 PC의 Mate에서 보세요)";
  return out;
}

export const HELP_TEXT = [
  "<b>Pi Desktop Mate</b>",
  "알림의 버튼으로 적용·버리기·맡기기를 할 수 있어요.",
  "",
  "그냥 말로 물어보거나 시켜도 됩니다 (예: 오늘 뭐 했어? / pi-desktop 테스트 깨진 거 살펴봐 줘).",
  "",
  "/ask [폴더] 지시 — 읽기만 하며 살펴보고 결과·제안을 보냅니다",
  "/fix [폴더] 지시 — 별도 작업 공간에서 고치고, 적용은 다시 묻습니다 (설정에서 허용해야 함)",
  "/run 임무 — 임무를 지금 실행",
  "/inbox — 새 제안 다시 보기",
  "/duties — 임무 목록",
  "/folders — 지시할 수 있는 폴더",
  "/status — 실행기 상태",
  "/history [줄 수] — 앱·휴대폰에서 나눈 최근 대화 보기 (기본 10줄)",
  "/new — 새 대화 시작",
].join("\n");
