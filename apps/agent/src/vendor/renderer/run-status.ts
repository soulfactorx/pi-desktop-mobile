/**
 * 실행 상태(대기 큐, 재시도, 오류) 화면 규칙. 화면과 분리한 순수 함수.
 */
import type { ChatItem, PendingQueue } from "./chat-state";

/**
 * clear_queue로 꺼낸 메시지를 입력창에 되돌린다 (TUI의 Esc와 같은 동작).
 * Steer를 먼저, Follow-up을 다음에 두고, 쓰던 초안이 있으면 맨 뒤에 붙인다.
 */
export function restoreQueueToDraft(cleared: Partial<PendingQueue> | undefined, draft: string): string {
  const texts = [...(cleared?.steering ?? []), ...(cleared?.followUp ?? [])].filter((t) => t.trim());
  if (draft.trim()) texts.push(draft);
  return texts.join("\n\n");
}

/**
 * 마지막 질문이 성공한 응답 없이 오류로 끝났으면 "다시 보내기"를 붙일 곳과 그 질문을 돌려준다.
 * 오류는 오류 응답(stopReason error)이거나 오류 안내(재시도 실패 등)다. 버튼은 그중 마지막 것에 붙인다.
 */
export function resendCandidate(items: readonly ChatItem[]): { anchorKey: string; text: string } | undefined {
  const lastUser = items.findLastIndex((item) => item.kind === "user");
  const question = items[lastUser];
  if (question?.kind !== "user") return undefined;
  const after = items.slice(lastUser + 1);
  if (after.some((item) => item.kind === "assistant" && item.stopReason !== "error")) return undefined;
  const failure = after.findLast(
    (item) => (item.kind === "assistant" && item.stopReason === "error") || (item.kind === "notice" && item.level === "error"),
  );
  return failure ? { anchorKey: failure.key, text: question.text } : undefined;
}

/** 재시도까지 남은 초 (0 미만이면 0) */
export function secondsLeft(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}
