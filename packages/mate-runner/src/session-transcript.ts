import type { TranscriptItem } from "./view-types";

const TEXT_LIMIT = 4000;

function clip(text: string): string {
  return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}\n… (${text.length - TEXT_LIMIT}자 생략)` : text;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: string; text?: string } => !!c && typeof c === "object")
    .filter((c) => c.type === "text")
    .map((c) => String(c.text ?? ""))
    .join("");
}

/**
 * 실행 세션(Pi 세션 JSONL, docs/session-format.md)을 읽기 전용 대화로 바꾼다.
 * 시스템 메시지(프롬프트)는 빼고, 도구 호출에는 결과를 짝지어 붙인다. 깨진 줄은 건너뛴다.
 */
export function parseTranscript(jsonl: string): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const tools = new Map<string, Extract<TranscriptItem, { kind: "tool" }>>();
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, any>;
    try {
      entry = JSON.parse(line) as Record<string, any>;
    } catch {
      continue;
    }
    if (entry.type === "model_change") {
      items.push({ kind: "note", text: `모델: ${entry.provider}/${entry.modelId}` });
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message as Record<string, any> | undefined;
    switch (message?.role) {
      case "user":
        items.push({ kind: "user", text: clip(textOf(message.content)) });
        break;
      case "assistant": {
        const text = textOf(message.content).trim();
        if (text) items.push({ kind: "assistant", text: clip(text) });
        for (const part of Array.isArray(message.content) ? message.content : []) {
          if (part?.type !== "toolCall") continue;
          const tool: Extract<TranscriptItem, { kind: "tool" }> = {
            kind: "tool",
            name: String(part.name ?? "?"),
            args: clip(JSON.stringify(part.arguments ?? {}, null, 2)),
          };
          if (typeof part.id === "string") tools.set(part.id, tool);
          items.push(tool);
        }
        if (message.stopReason === "error") items.push({ kind: "note", text: `오류: ${message.errorMessage ?? "모델 오류"}` });
        break;
      }
      case "toolResult": {
        const tool = tools.get(String(message.toolCallId));
        const result = clip(textOf(message.content));
        if (tool) {
          tool.result = result;
          tool.isError = message.isError === true;
        } else {
          items.push({ kind: "tool", name: String(message.toolName ?? "?"), args: "", result, isError: message.isError === true });
        }
        break;
      }
    }
  }
  return items;
}
