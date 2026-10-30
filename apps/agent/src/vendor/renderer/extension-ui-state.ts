/**
 * 확장 UI 요청(extension_ui_request)을 화면 상태로 바꾸는 순수 함수 (rpc-extension-ui.md, 설계 §4.1).
 *
 * - 다이얼로그(select·confirm·input·editor): 사용자가 답할 때까지 띄운다
 * - notify: 잠깐 보이는 토스트
 * - setStatus / setWidget: 키별로 덮어쓰거나 지운다 (재생으로 상태를 다시 만들 수 있음)
 * - setTitle: 창 제목, set_editor_text: 입력창 내용 바꾸기
 *
 * 저널 재생으로 오래된 요청이 다시 들어온다. 그래서
 * - 다이얼로그는 데몬이 알려 준 대기 목록(pendingUi)에 있는 것만 남기고 (prunePending)
 * - 토스트·입력창 바꾸기처럼 "지금 일어난 일"은 재생 중에 들어왔거나 받은 시각이 오래되었으면 무시한다.
 */

export type DialogMethod = "select" | "confirm" | "input" | "editor";

export interface DialogRequest {
  id: string;
  method: DialogMethod;
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  /** Pi가 기본값으로 자동 처리하기까지 남은 시간의 기준 (ms). 없으면 무제한 */
  timeout?: number;
  /** 데몬이 요청을 받은 시각 (ms) */
  at: number;
}

export interface Toast {
  key: string;
  message: string;
  level: "info" | "warning" | "error";
  at: number;
}

export interface Widget {
  lines: string[];
  placement: "aboveEditor" | "belowEditor";
}

export interface ExtensionUiState {
  dialogs: DialogRequest[];
  toasts: Toast[];
  statuses: Record<string, string>;
  widgets: Record<string, Widget>;
  title?: string;
  /** 확장이 입력창에 넣으라고 한 글. seq로 같은 요청을 한 번만 적용한다 */
  editorText?: { text: string; seq: number };
  lastSeq: number;
}

export const initialExtensionUiState: ExtensionUiState = {
  dialogs: [],
  toasts: [],
  statuses: {},
  widgets: {},
  lastSeq: 0,
};

/** 이보다 오래된 notify·set_editor_text는 재생된 것으로 보고 무시한다 */
export const FRESH_MS = 10_000;

const DIALOGS = new Set<string>(["select", "confirm", "input", "editor"]);

type AnyRecord = Record<string, unknown>;

export function applyUiEvent(
  state: ExtensionUiState,
  seq: number,
  at: number,
  raw: unknown,
  now: number = Date.now(),
  /** attach로 저널을 재생하는 중에 들어온 이벤트인지. 재생된 알림은 "지금 일어난 일"이 아니다 */
  replay = false,
): ExtensionUiState {
  if (seq <= state.lastSeq) return state;
  const next: ExtensionUiState = { ...state, lastSeq: seq };
  if (typeof raw !== "object" || raw === null) return next;
  const event = raw as AnyRecord;
  if (event.type !== "extension_ui_request" || typeof event.id !== "string" || typeof event.method !== "string") {
    return next;
  }
  const fresh = !replay && now - at < FRESH_MS;

  if (DIALOGS.has(event.method)) {
    const timeout = typeof event.timeout === "number" ? event.timeout : undefined;
    if (timeout !== undefined && at + timeout <= now) return next; // 이미 Pi가 자동 처리함
    const dialog: DialogRequest = {
      id: event.id,
      method: event.method as DialogMethod,
      title: String(event.title ?? ""),
      at,
    };
    if (typeof event.message === "string") dialog.message = event.message;
    if (Array.isArray(event.options)) dialog.options = event.options.map(String);
    if (typeof event.placeholder === "string") dialog.placeholder = event.placeholder;
    if (typeof event.prefill === "string") dialog.prefill = event.prefill;
    if (timeout !== undefined) dialog.timeout = timeout;
    return { ...next, dialogs: [...next.dialogs.filter((d) => d.id !== dialog.id), dialog] };
  }

  switch (event.method) {
    case "notify": {
      if (!fresh) return next;
      const level = event.notifyType === "warning" || event.notifyType === "error" ? event.notifyType : "info";
      const toast: Toast = { key: event.id, message: String(event.message ?? ""), level, at };
      return { ...next, toasts: [...next.toasts, toast] };
    }
    case "setStatus": {
      const key = String(event.statusKey ?? "");
      const statuses = { ...next.statuses };
      if (typeof event.statusText === "string" && event.statusText.length > 0) statuses[key] = event.statusText;
      else delete statuses[key];
      return { ...next, statuses };
    }
    case "setWidget": {
      const key = String(event.widgetKey ?? "");
      const widgets = { ...next.widgets };
      if (Array.isArray(event.widgetLines)) {
        widgets[key] = {
          lines: event.widgetLines.map(String),
          placement: event.widgetPlacement === "belowEditor" ? "belowEditor" : "aboveEditor",
        };
      } else {
        delete widgets[key];
      }
      return { ...next, widgets };
    }
    case "setTitle":
      return typeof event.title === "string" ? { ...next, title: event.title } : next;
    case "set_editor_text":
      return fresh && typeof event.text === "string" ? { ...next, editorText: { text: event.text, seq } } : next;
    default:
      return next;
  }
}

/** 다이얼로그가 처리되었다 (이 앱이 답했거나, 다른 앱이 답했거나, 제한 시간). */
export function resolveDialog(state: ExtensionUiState, id: string): ExtensionUiState {
  return state.dialogs.some((d) => d.id === id) ? { ...state, dialogs: state.dialogs.filter((d) => d.id !== id) } : state;
}

/** 데몬이 알려 준 대기 목록에 없는 다이얼로그는 이미 처리된 것이므로 뺀다 (재생 직후 호출). */
export function prunePending(state: ExtensionUiState, pendingIds: string[]): ExtensionUiState {
  const pending = new Set(pendingIds);
  const dialogs = state.dialogs.filter((d) => pending.has(d.id));
  return dialogs.length === state.dialogs.length ? state : { ...state, dialogs };
}

export function dismissToast(state: ExtensionUiState, key: string): ExtensionUiState {
  return { ...state, toasts: state.toasts.filter((t) => t.key !== key) };
}

/** 다이얼로그 응답으로 Pi에 보낼 레코드 */
export function dialogResponse(
  dialog: DialogRequest,
  answer: { value?: string; confirmed?: boolean; cancelled?: boolean },
): Record<string, unknown> {
  if (answer.cancelled) return { type: "extension_ui_response", id: dialog.id, cancelled: true };
  if (dialog.method === "confirm") return { type: "extension_ui_response", id: dialog.id, confirmed: answer.confirmed === true };
  return { type: "extension_ui_response", id: dialog.id, value: answer.value ?? "" };
}
