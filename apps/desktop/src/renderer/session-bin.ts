import type { StoredSession, TrashItem } from "@pi-desktop/host-protocol/messages";

/**
 * 아카이브·휴지통 화면이 쓰는 순수 함수 (설계 DESIGN-APPS.md §3.2).
 * 아카이브는 파일을 그대로 두고 앱 목록에서만 숨긴다. 휴지통은 지운 세션을 되살리거나 정말 지운다.
 */

export type BinTab = "archive" | "trash";

/** 사이드바 기록에 보일 세션 (아카이브한 것은 뺀다) */
export function visibleHistory(list: StoredSession[]): StoredSession[] {
  return list.filter((h) => !h.archived);
}

/** 아카이브 화면의 세션 (최근에 고친 것부터) */
export function archivedHistory(list: StoredSession[]): StoredSession[] {
  return list.filter((h) => h.archived).sort((a, b) => b.modified - a.modified);
}

export function sessionTitle(item: { name?: string; firstMessage: string }): string {
  return item.name ?? (item.firstMessage || "(빈 세션)");
}

/** 휴지통 항목의 한 줄 설명 */
export function trashMeta(item: TrashItem, formatTime: (ms: number) => string): string {
  const parts = [`${formatTime(item.deletedAt)} 삭제`, item.cwd || "(폴더 모름)"];
  if (item.legacy) parts.push("예전 백업");
  return parts.join(" · ");
}
