import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { readInbox, type InboxItem } from "@pi-desktop/mate-kit";
import type { MatePaths } from "./paths";
import { setInboxStatus } from "./store";
import { execCommand, type Exec } from "./watchers";
import { applyChange, isInside, removeWorkspace } from "./workspace";

/**
 * 인박스의 act 변경을 적용하거나 버린다 (앱이 부른다, 설계 DESIGN-MATE.md §4).
 * Mate 홈 worktrees/ 안의 작업 공간만 다룬다. 인박스 줄이 바뀌어 다른 폴더를 가리켜도 지우거나 읽지 않는다.
 */
async function changeItem(paths: MatePaths, itemId: string): Promise<InboxItem & { change: NonNullable<InboxItem["change"]> }> {
  const item = (await readInbox(paths.inbox)).find((i) => i.id === itemId);
  if (!item?.change) throw new Error("적용할 변경을 찾지 못했습니다");
  if (!isInside(item.change.worktree, paths.worktrees)) throw new Error("Mate 작업 공간이 아닌 폴더라 다루지 않습니다");
  return item as InboxItem & { change: NonNullable<InboxItem["change"]> };
}

export async function applyInboxChange(paths: MatePaths, itemId: string, exec: Exec = execCommand): Promise<void> {
  const { change } = await changeItem(paths, itemId);
  if (!existsSync(change.worktree)) throw new Error("작업 공간이 이미 지워져 적용할 수 없습니다");
  const patchFile = join(paths.worktrees, `${basename(change.worktree)}.patch`);
  try {
    await applyChange(exec, change, patchFile);
  } finally {
    await rm(patchFile, { force: true });
  }
  await removeWorkspace(exec, change.repo, change.worktree);
  await setInboxStatus(paths, [itemId], "applied");
}

export async function discardInboxChange(paths: MatePaths, itemId: string, exec: Exec = execCommand): Promise<void> {
  const { change } = await changeItem(paths, itemId);
  if (existsSync(change.worktree)) await removeWorkspace(exec, change.repo, change.worktree);
  await setInboxStatus(paths, [itemId], "dismissed");
}
