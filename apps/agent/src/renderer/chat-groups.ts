import { folderName, isSameFolder } from "./recent-folders";

/**
 * 사이드바의 대화를 작업 폴더별로 묶는다 (설계 DESIGN-AGENT.md §4 "작업 폴더").
 * 대화는 최근 것부터 들어오고, 묶음 순서도 그 폴더의 가장 최근 대화 순서를 따른다.
 */
export interface ChatGroup<T> {
  folder: string;
  name: string;
  chats: T[];
}

export function groupByFolder<T extends { cwd: string }>(chats: T[]): Array<ChatGroup<T>> {
  const groups: Array<ChatGroup<T>> = [];
  for (const chat of chats) {
    const group = groups.find((g) => isSameFolder(g.folder, chat.cwd));
    if (group) group.chats.push(chat);
    else groups.push({ folder: chat.cwd, name: folderName(chat.cwd), chats: [chat] });
  }
  return groups;
}
