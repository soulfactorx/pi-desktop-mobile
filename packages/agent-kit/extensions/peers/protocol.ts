import type { AgentCard } from "./store";

/**
 * 피어끼리 주고받는 모양. A2A(Agent2Agent) JSON-RPC를 따른다: 카드는 `GET /.well-known/agent-card.json`,
 * 질문은 `POST /a2a`의 `message/send`. 페어링(`/pair`, `/pair/status`)은 이 앱의 확장이다.
 */

export const CARD_PATH = "/.well-known/agent-card.json";
export const A2A_PATH = "/a2a";
export const PAIR_PATH = "/pair";
export const PAIR_STATUS_PATH = "/pair/status";

/** 피어를 거쳐 다시 피어를 부르는 깊이 상한 (A→B→A 같은 순환과 꼬리 물기를 막는다) */
export const MAX_HOPS = 2;

export interface MessageSendMetadata {
  /** 지금까지 거친 에이전트 이름들 (홉 제한) */
  callChain: string[];
  /** question: 바로 답을 받는다, task: 작업을 맡기고 tasks/get으로 결과를 가져간다 */
  taskType: "question" | "task";
  /** task일 때 작업 이름 */
  title?: string;
}

export function messageSendRequest(id: string, text: string, metadata: MessageSendMetadata) {
  return {
    jsonrpc: "2.0",
    id,
    method: "message/send",
    params: {
      message: { kind: "message", role: "user", messageId: id, parts: [{ kind: "text", text }] },
      metadata,
    },
  };
}

/** message/send 요청에서 질문 글과 홉 정보를 꺼낸다. 형식이 틀리면 undefined */
export function parseMessageSend(body: unknown): { id: unknown; text: string; callChain: string[]; taskType: "question" | "task"; title?: string } | undefined {
  const request = body as {
    jsonrpc?: string;
    id?: unknown;
    method?: string;
    params?: { message?: { parts?: Array<{ kind?: string; text?: string }> }; metadata?: { callChain?: unknown; taskType?: unknown; title?: unknown } };
  };
  if (request?.jsonrpc !== "2.0" || request.method !== "message/send") return undefined;
  const text = (request.params?.message?.parts ?? [])
    .filter((p) => p.kind === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
  if (!text) return undefined;
  const metadata = request.params?.metadata;
  const chain = Array.isArray(metadata?.callChain) ? metadata.callChain.map(String) : [];
  const taskType = metadata?.taskType === "task" ? "task" : "question";
  const title = typeof metadata?.title === "string" && metadata.title.trim() ? metadata.title.trim().slice(0, 100) : undefined;
  return { id: request.id, text, callChain: chain, taskType, ...(title ? { title } : {}) };
}

/** A2A 작업 상태 (이 앱의 작업 상태를 옮긴 것) */
export type A2ATaskState = "submitted" | "working" | "completed" | "failed" | "canceled" | "rejected";

export interface A2ATaskView {
  id: string;
  state: A2ATaskState;
  /** 끝났으면 결과 글, 실패·거절이면 이유 */
  text?: string;
}

export function taskResult(id: unknown, task: A2ATaskView) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      kind: "task",
      id: task.id,
      status: { state: task.state, ...(task.text && task.state !== "completed" ? { message: { kind: "message", role: "agent", parts: [{ kind: "text", text: task.text }] } } : {}) },
      ...(task.text && task.state === "completed" ? { artifacts: [{ artifactId: "result", parts: [{ kind: "text", text: task.text }] }] } : {}),
    },
  };
}

/** 응답에서 작업 상태를 꺼낸다. 오류면 그 메시지로 예외 */
export function parseTaskResult(response: unknown): A2ATaskView {
  const r = response as {
    error?: { message?: string };
    result?: { kind?: string; id?: unknown; status?: { state?: unknown; message?: { parts?: Array<{ text?: string }> } }; artifacts?: Array<{ parts?: Array<{ text?: string }> }> };
  };
  if (r?.error) throw new Error(r.error.message ?? "피어가 오류로 답했다");
  if (r?.result?.kind !== "task" || typeof r.result.id !== "string") throw new Error("작업 응답이 아니다");
  const states: A2ATaskState[] = ["submitted", "working", "completed", "failed", "canceled", "rejected"];
  const state = states.includes(r.result.status?.state as A2ATaskState) ? (r.result.status!.state as A2ATaskState) : "working";
  const text = [...(r.result.artifacts ?? []).flatMap((a) => a.parts ?? []), ...(r.result.status?.message?.parts ?? [])]
    .map((p) => p.text ?? "")
    .join("\n")
    .trim();
  return { id: r.result.id, state, ...(text ? { text } : {}) };
}

export function rpcRequest(id: string, method: "tasks/get" | "tasks/cancel", params: { id: string }) {
  return { jsonrpc: "2.0", id, method, params };
}

export function agentReply(id: unknown, text: string) {
  return { jsonrpc: "2.0", id, result: { kind: "message", role: "agent", messageId: `reply-${String(id)}`, parts: [{ kind: "text", text }] } };
}

export function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** 응답 결과에서 글을 꺼낸다. 오류면 그 메시지로 예외 */
export function replyText(response: unknown): string {
  const r = response as { error?: { message?: string }; result?: { parts?: Array<{ kind?: string; text?: string }> } };
  if (r?.error) throw new Error(r.error.message ?? "피어가 오류로 답했다");
  const text = (r?.result?.parts ?? [])
    .filter((p) => p.kind === "text")
    .map((p) => p.text ?? "")
    .join("\n")
    .trim();
  if (!text) throw new Error("피어의 답이 비어 있다");
  return text;
}

/** 카드로 볼 수 있는가 (이름·주소가 있는가) */
export function isCard(value: unknown): value is AgentCard {
  const card = value as AgentCard;
  return typeof card?.name === "string" && card.name.trim().length > 0 && typeof card.url === "string";
}

/** 주소를 http(s)://host:port 꼴로 다듬는다. 포트만 빠지면 기본 포트를 붙인다 */
export function normalizeAddress(input: string, defaultPort: number): string {
  let address = input.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(address)) address = `http://${address}`;
  const url = new URL(address);
  if (!url.port) url.port = String(defaultPort);
  return `${url.protocol}//${url.host}`;
}
