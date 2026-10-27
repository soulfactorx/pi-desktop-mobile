import type { ConnectionState } from "../shared/api";

/**
 * 연결이 끊겼을 때 상단 배지의 글. 다시 붙을 때까지 남은 초와 시도 횟수를 보인다.
 * 연달아 실패해 멈췄으면 "연결 실패"(누르면 다시 연결).
 */
export function disconnectedBadgeText(state: Extract<ConnectionState, { status: "disconnected" }>, now: number): string {
  if (state.gaveUp) return "연결 실패 · 다시 연결";
  if (state.retryAt === undefined) return "연결 끊김";
  const seconds = Math.max(0, Math.ceil((state.retryAt - now) / 1000));
  const count = state.failures && state.maxRetries ? ` (${state.failures}/${state.maxRetries})` : "";
  return seconds > 0 ? `연결 끊김 · ${seconds}초 뒤 다시 시도${count}` : `다시 연결하는 중${count}`;
}
