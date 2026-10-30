import { DaemonEvents } from "@pi-desktop/host-protocol/messages";
import { formatTokens } from "./format";

/**
 * Pi RPC 이벤트를 채팅 화면 상태로 바꾸는 순수 함수 (설계 §4.1).
 *
 * 규칙 (Pi json.md):
 * - `message_update`는 델타만 담는다. 블록별로 이어 붙이고 `*_end`, `message_end`가 오면 확정본으로 교체한다.
 * - 실행 완료 판정은 `agent_end`가 아니라 `agent_settled`다.
 * - 모르는 이벤트는 무시한다 (Event Inspector에서 raw로 볼 예정).
 * - `!` 셸 명령은 데몬이 남긴 시작·끝 이벤트와 Pi의 출력 조각으로 툴 카드를 만든다 (DaemonEvents).
 *
 * 저널 재생으로 같은 이벤트가 다시 올 수 있으므로 seq가 이미 처리한 값 이하면 버린다.
 */

export type AssistantBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "toolCall"; toolName: string; argsText: string };

export type ChatItem =
  | {
      kind: "user";
      key: string;
      text: string;
      /** 함께 보낸 이미지 (Pi ImageContent: base64와 MIME 형식) */
      images?: Array<{ mimeType: string; data: string }>;
    }
  | {
      kind: "assistant";
      key: string;
      blocks: AssistantBlock[];
      done: boolean;
      stopReason?: string;
      errorMessage?: string;
    }
  | {
      kind: "tool";
      key: string;
      toolCallId: string;
      toolName: string;
      args: unknown;
      status: "running" | "done" | "error";
      output: string;
      durationMs?: number;
      /** 셸 명령(`!` 또는 bash 툴)의 종료 코드 */
      exitCode?: number;
      /** 툴별 부가 정보 (예: edit의 diff·patch). 툴 카드가 해석한다 */
      details?: unknown;
    }
  | { kind: "notice"; key: string; level: "info" | "error"; text: string };

/** Steer·Follow-up으로 보내 두고 아직 Pi가 처리하지 않은 메시지 (queue_update) */
export interface PendingQueue {
  steering: string[];
  followUp: string[];
}

/** 응답 오류로 자동 재시도를 기다리는 중 (auto_retry_start ~ auto_retry_end) */
export interface RetryState {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  errorMessage: string;
}

export interface ChatState {
  items: ChatItem[];
  /** Pi가 자동으로 이어서 할 작업이 남아 있는지 (agent_start ~ agent_settled) */
  running: boolean;
  /** 마지막으로 반영한 저널 순번 */
  lastSeq: number;
  queue: PendingQueue;
  retry?: RetryState;
}

const EMPTY_QUEUE: PendingQueue = { steering: [], followUp: [] };

export const initialChatState: ChatState = { items: [], running: false, lastSeq: 0, queue: EMPTY_QUEUE };

type AnyEvent = Record<string, unknown> & { type?: string };

export function applyEvent(state: ChatState, seq: number, raw: unknown): ChatState {
  if (seq <= state.lastSeq) return state;
  const next: ChatState = { ...state, lastSeq: seq };
  if (typeof raw !== "object" || raw === null) return next;
  const event = raw as AnyEvent;

  switch (event.type) {
    case "agent_start":
      return { ...next, running: true };
    case "agent_settled": {
      // 더 이어서 할 일이 없으므로 대기 큐와 재시도 상태도 끝난 것으로 본다.
      const { retry: _retry, ...rest } = next;
      return { ...rest, running: false, queue: EMPTY_QUEUE, items: finishOpenAssistant(next.items) };
    }

    case "queue_update":
      return { ...next, queue: { steering: queueTexts(event.steering), followUp: queueTexts(event.followUp) } };

    case "message_start": {
      const message = event.message as AnyEvent | undefined;
      if (message?.role === "user") {
        return { ...next, items: [...next.items, { kind: "user", key: `u${seq}`, ...userContent(message.content) }] };
      }
      if (message?.role === "assistant") {
        return { ...next, items: [...next.items, { kind: "assistant", key: `a${seq}`, blocks: [], done: false }] };
      }
      return next;
    }

    case "message_update":
      return updateLastAssistant(next, (item) => ({
        ...item,
        blocks: applyDelta(item.blocks, event.assistantMessageEvent as AnyEvent | undefined),
      }));

    case "message_end": {
      const message = event.message as AnyEvent | undefined;
      if (message?.role !== "assistant") return next;
      return updateLastAssistant(next, (item) => {
        const updated = { ...item, blocks: blocksFromContent(message.content), done: true };
        if (typeof message.stopReason === "string") updated.stopReason = message.stopReason;
        if (typeof message.errorMessage === "string") updated.errorMessage = message.errorMessage;
        return updated;
      });
    }

    case "tool_execution_start":
      return {
        ...next,
        items: [
          ...next.items,
          {
            kind: "tool",
            key: `t${seq}`,
            toolCallId: String(event.toolCallId),
            toolName: String(event.toolName),
            args: event.args,
            status: "running",
            output: "",
          },
        ],
      };

    case "tool_execution_update":
      return updateTool(next, String(event.toolCallId), (item) => ({
        ...item,
        output: resultText(event.partialResult),
      }));

    case "tool_execution_end":
      return updateTool(next, String(event.toolCallId), (item) => {
        const updated = {
          ...item,
          status: event.isError === true ? ("error" as const) : ("done" as const),
          output: resultText(event.result),
        };
        if (typeof event.durationMs === "number") updated.durationMs = event.durationMs;
        const result = event.result as AnyEvent | undefined;
        if (result?.details !== undefined) updated.details = result.details;
        const exitCode = (result?.structuredContent as AnyEvent | undefined)?.exit_code;
        if (typeof exitCode === "number") updated.exitCode = exitCode;
        return updated;
      });

    case DaemonEvents.bashStart:
      return {
        ...next,
        items: [
          ...next.items,
          {
            kind: "tool",
            key: `b${seq}`,
            toolCallId: bashKey(event.id),
            toolName: event.excludeFromContext === true ? "!!bash" : "!bash",
            args: { command: event.command },
            status: "running",
            output: "",
          },
        ],
      };

    case "bash_execution_update":
      return updateTool(next, bashKey(event.id), (item) => ({
        ...item,
        output: keepTail(item.output + String(event.delta ?? "")),
      }));

    case DaemonEvents.bashEnd:
      return updateTool(next, bashKey(event.id), (item) => {
        const failed = typeof event.error === "string" || event.cancelled === true || event.exitCode !== 0;
        const updated = { ...item, status: failed ? ("error" as const) : ("done" as const) };
        if (typeof event.exitCode === "number") updated.exitCode = event.exitCode;
        const notes = [
          event.cancelled === true ? "[중단됨]" : "",
          typeof event.error === "string" ? `[오류] ${event.error}` : "",
          event.truncated === true && typeof event.fullOutputPath === "string" ? `[전체 출력] ${event.fullOutputPath}` : "",
        ].filter(Boolean);
        if (notes.length > 0) updated.output = [item.output.replace(/\n$/, ""), ...notes].filter(Boolean).join("\n");
        return updated;
      });

    case "compaction_start":
      return withNotice(next, `c${seq}`, "info", `컨텍스트를 요약(컴팩션)하는 중… (${COMPACTION_REASONS[String(event.reason)] ?? "요청"})`);

    case "compaction_end": {
      const result = event.result as { tokensBefore?: number; estimatedTokensAfter?: number } | undefined;
      if (result) {
        return withNotice(
          next,
          `c${seq}`,
          "info",
          `요약 완료: ${formatTokens(result.tokensBefore)} → 약 ${formatTokens(result.estimatedTokensAfter)} 토큰`,
        );
      }
      if (event.aborted === true) return withNotice(next, `c${seq}`, "info", "요약을 중단했습니다.");
      return withNotice(next, `c${seq}`, "error", `요약 실패: ${String(event.errorMessage ?? "알 수 없는 오류")}`);
    }

    case "auto_retry_start":
      return withNotice(
        {
          ...next,
          // 재시도할 실패 응답(내용 없는 오류)은 재시도 안내로 대신하고 화면에서 뺀다.
          items: dropFailedAttempt(next.items),
          retry: {
            attempt: Number(event.attempt ?? 0),
            maxAttempts: Number(event.maxAttempts ?? 0),
            delayMs: Number(event.delayMs ?? 0),
            errorMessage: String(event.errorMessage ?? ""),
          },
        },
        `r${seq}`,
        "info",
        `응답 오류로 ${Math.round(Number(event.delayMs ?? 0) / 1000)}초 뒤 다시 시도합니다 ` +
          `(${String(event.attempt)}/${String(event.maxAttempts)}): ${String(event.errorMessage ?? "")}`,
      );

    case "auto_retry_end": {
      const { retry: _retry, ...rest } = next;
      return event.success === false
        ? withNotice(rest, `r${seq}`, "error", `재시도 실패: ${String(event.finalError ?? "알 수 없는 오류")}`)
        : rest;
    }

    default:
      return next;
  }
}

function dropFailedAttempt(items: ChatItem[]): ChatItem[] {
  const last = items.at(-1);
  const failedEmpty =
    last?.kind === "assistant" && last.stopReason === "error" && last.blocks.every((b) => b.type === "text" && !b.text.trim());
  return failedEmpty ? items.slice(0, -1) : items;
}

/** queue_update의 큐 항목은 문자열이다. 다른 모양이 와도 글자만 뽑는다. */
function queueTexts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => (typeof v === "string" ? v : contentText((v as AnyEvent | null)?.content ?? (v as AnyEvent | null)?.text)));
}

/** 셸 명령 카드의 toolCallId. Pi 툴 호출 id와 겹치지 않게 접두사를 붙인다. */
function bashKey(id: unknown): string {
  return `bash:${String(id)}`;
}

/** 셸 출력이 아주 길면 화면에는 뒷부분만 남긴다 (전체는 Pi가 세션에 저장). */
const BASH_OUTPUT_LIMIT = 200_000;
function keepTail(text: string): string {
  return text.length > BASH_OUTPUT_LIMIT ? `…${text.slice(-BASH_OUTPUT_LIMIT)}` : text;
}

const COMPACTION_REASONS: Record<string, string> = {
  manual: "수동",
  threshold: "컨텍스트 임계치 도달",
  overflow: "컨텍스트 초과",
};

function withNotice(state: ChatState, key: string, level: "info" | "error", text: string): ChatState {
  return { ...state, items: [...state.items, { kind: "notice", key, level, text }] };
}

/**
 * Pi의 `get_messages` 결과(확정된 대화 전체)로 화면 상태를 다시 만든다 (설계 §3.4 스냅샷 복구).
 *
 * 저널 앞부분이 잘렸거나, 데몬이 재시작되어 세션 파일로 다시 연 경우에 쓴다.
 * - 응답 속 toolCall 블록마다 툴 카드를 만들고, 뒤따르는 toolResult로 결과를 채운다
 * - `!` 셸 명령(bashExecution)도 툴 카드로 보여준다
 * - 실행 중(running)인데 마지막이 응답이 아니면, 진행 중인 응답의 델타를 받을 빈 응답을 하나 둔다
 *   (get_messages에는 아직 끝나지 않은 메시지가 없으므로)
 *
 * @param lastSeq 스냅샷 시점까지 반영한 저널 순번. 이후 실시간 이벤트만 이어서 적용된다.
 */
export function snapshotState(messages: unknown[], lastSeq: number, running: boolean): ChatState {
  const items: ChatItem[] = [];
  messages.forEach((raw, index) => {
    if (typeof raw !== "object" || raw === null) return;
    const message = raw as AnyEvent;
    const key = `s${index}`;
    switch (message.role) {
      case "user":
        items.push({ kind: "user", key, ...userContent(message.content) });
        break;
      case "assistant": {
        const item: Extract<ChatItem, { kind: "assistant" }> = {
          kind: "assistant",
          key,
          blocks: blocksFromContent(message.content),
          done: true,
        };
        if (typeof message.stopReason === "string") item.stopReason = message.stopReason;
        if (typeof message.errorMessage === "string") item.errorMessage = message.errorMessage;
        items.push(item);
        // 툴 호출은 결과가 올 때까지 실행 중으로 둔다.
        const calls = Array.isArray(message.content) ? (message.content as AnyEvent[]) : [];
        calls
          .filter((part) => part.type === "toolCall")
          .forEach((part, i) =>
            items.push({
              kind: "tool",
              key: `${key}-t${i}`,
              toolCallId: String(part.id),
              toolName: String(part.name ?? ""),
              args: part.arguments ?? {},
              status: running ? "running" : "done",
              output: "",
            }),
          );
        break;
      }
      case "toolResult": {
        const index = items.findLastIndex((item) => item.kind === "tool" && item.toolCallId === String(message.toolCallId));
        const tool = items[index];
        if (tool?.kind === "tool") {
          items[index] = {
            ...tool,
            status: message.isError === true ? "error" : "done",
            output: contentText(message.content),
            ...(message.details !== undefined ? { details: message.details } : {}),
          };
        }
        break;
      }
      case "bashExecution":
        items.push({
          kind: "tool",
          key,
          toolCallId: key,
          toolName: message.excludeFromContext === true ? "!!bash" : "!bash",
          args: { command: message.command },
          status: message.exitCode === 0 ? "done" : "error",
          output: String(message.output ?? ""),
          ...(typeof message.exitCode === "number" ? { exitCode: message.exitCode } : {}),
        });
        break;
      case "compactionSummary":
        items.push({ kind: "notice", key, level: "info", text: "이전 대화가 요약(컴팩션)되었습니다." });
        break;
      default:
        // custom, branchSummary 등은 M1 후반에 표시 방법을 정한다.
        break;
    }
  });

  // 툴이 아직 실행 중이면 다음 응답은 실시간 message_start로 새로 생기므로 자리를 만들지 않는다.
  const last = items.at(-1);
  const toolStillRunning = last?.kind === "tool" && last.status === "running";
  if (running && last?.kind !== "assistant" && !toolStillRunning) {
    items.push({ kind: "assistant", key: "s-live", blocks: [], done: false });
  }
  return { items, running, lastSeq, queue: EMPTY_QUEUE };
}

/** 프롬프트를 보냈는데 Pi가 거부했을 때처럼, 이벤트가 아닌 안내를 끼워 넣는다. */
export function addNotice(state: ChatState, level: "info" | "error", text: string): ChatState {
  return { ...state, items: [...state.items, { kind: "notice", key: `n${Date.now()}-${state.items.length}`, level, text }] };
}

function applyDelta(blocks: AssistantBlock[], update: AnyEvent | undefined): AssistantBlock[] {
  if (!update || typeof update.contentIndex !== "number") return blocks;
  const index = update.contentIndex;
  const copy = [...blocks];
  const current = copy[index];
  switch (update.type) {
    case "text_start":
      copy[index] = { type: "text", text: "" };
      break;
    case "text_delta":
      copy[index] = { type: "text", text: (current?.type === "text" ? current.text : "") + String(update.delta ?? "") };
      break;
    case "text_end":
      if (typeof update.content === "string") copy[index] = { type: "text", text: update.content };
      break;
    case "thinking_start":
      copy[index] = { type: "thinking", text: "" };
      break;
    case "thinking_delta":
      copy[index] = {
        type: "thinking",
        text: (current?.type === "thinking" ? current.text : "") + String(update.delta ?? ""),
      };
      break;
    case "thinking_end":
      if (typeof update.content === "string") copy[index] = { type: "thinking", text: update.content };
      break;
    case "toolcall_start":
      copy[index] = { type: "toolCall", toolName: String(update.toolName ?? ""), argsText: "" };
      break;
    case "toolcall_delta":
      if (current?.type === "toolCall") copy[index] = { ...current, argsText: current.argsText + String(update.delta ?? "") };
      break;
    default:
      return blocks;
  }
  // 중간 인덱스가 비어 있으면(이벤트 일부를 못 받은 경우) 빈 텍스트로 채워 렌더링이 깨지지 않게 한다.
  for (let i = 0; i < copy.length; i++) copy[i] ??= { type: "text", text: "" };
  return copy;
}

function blocksFromContent(content: unknown): AssistantBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  const blocks: AssistantBlock[] = [];
  for (const part of content as AnyEvent[]) {
    if (part.type === "text") blocks.push({ type: "text", text: String(part.text ?? "") });
    else if (part.type === "thinking") blocks.push({ type: "thinking", text: String(part.thinking ?? "") });
    else if (part.type === "toolCall") {
      blocks.push({ type: "toolCall", toolName: String(part.name ?? ""), argsText: JSON.stringify(part.arguments ?? {}) });
    }
  }
  return blocks;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as AnyEvent[])
    .map((part) => (part.type === "text" ? String(part.text ?? "") : part.type === "image" ? "[이미지]" : ""))
    .join("");
}

/** 사용자 메시지 내용을 글과 이미지로 나눈다 (이미지는 썸네일로 따로 보여준다) */
function userContent(content: unknown): { text: string; images?: Array<{ mimeType: string; data: string }> } {
  if (!Array.isArray(content)) return { text: contentText(content) };
  const parts = content as AnyEvent[];
  const text = parts.map((part) => (part.type === "text" ? String(part.text ?? "") : "")).join("");
  const images = parts
    .filter((part) => part.type === "image" && typeof part.data === "string")
    .map((part) => ({ mimeType: String(part.mimeType ?? "image/png"), data: String(part.data) }));
  return images.length > 0 ? { text, images } : { text };
}

/** 툴 결과 `{ content: [{type:"text", text}] }`에서 텍스트만 뽑는다. */
function resultText(result: unknown): string {
  if (typeof result !== "object" || result === null) return "";
  return contentText((result as AnyEvent).content);
}

function updateLastAssistant(
  state: ChatState,
  update: (item: Extract<ChatItem, { kind: "assistant" }>) => ChatItem,
): ChatState {
  for (let i = state.items.length - 1; i >= 0; i--) {
    const item = state.items[i];
    if (item?.kind === "assistant") {
      const items = [...state.items];
      items[i] = update(item);
      return { ...state, items };
    }
  }
  return state;
}

function updateTool(
  state: ChatState,
  toolCallId: string,
  update: (item: Extract<ChatItem, { kind: "tool" }>) => ChatItem,
): ChatState {
  // 툴 호출 id를 턴마다 다시 쓰는 모델 서버도 있어서(예: 매번 call_1) 가장 최근 카드를 고친다.
  const index = state.items.findLastIndex((item) => item.kind === "tool" && item.toolCallId === toolCallId);
  if (index === -1) return state;
  const items = [...state.items];
  items[index] = update(items[index] as Extract<ChatItem, { kind: "tool" }>);
  return { ...state, items };
}

/** 중단 등으로 message_end 없이 끝난 응답을 완료 상태로 바꾼다. */
function finishOpenAssistant(items: ChatItem[]): ChatItem[] {
  return items.map((item) => (item.kind === "assistant" && !item.done ? { ...item, done: true } : item));
}
