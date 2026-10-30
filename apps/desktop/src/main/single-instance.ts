// 단일 인스턴스: 설치본을 다시 열면(바탕화면 아이콘을 또 누름, 다른 앱이 실행 파일을 엶) 새 창을 띄우지 않고
// 이미 떠 있는 창을 앞으로 가져온다. 잠금은 Electron이 userData 폴더마다 잡는다.

/** 앞으로 가져올 창 (BrowserWindow의 일부). 테스트에서 가짜 창을 넣을 수 있게 좁혀 둔다. */
export interface RevealableWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isVisible(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

/**
 * 단일 인스턴스 잠금을 쓸지. 설치본만 쓴다.
 * 개발 실행은 설치본과 userData가 같아서(둘 다 "Pi Desktop") 잠그면 설치본이 떠 있을 때 개발 실행이 바로 끝나고,
 * 여러 worktree의 dev:mock을 함께 띄울 수도 없다. 개발 실행의 userData를 옮기면 기존 SSH 호스트·가져오기 기록을
 * 잃으므로, 개발 실행은 지금처럼 잠그지 않는다.
 */
export function usesSingleInstanceLock(isPackaged: boolean): boolean {
  return isPackaged;
}

/** 기존 창을 앞으로 가져온다. 창이 없거나 닫혔으면 false (호출한 쪽이 새로 만든다). */
export function revealWindow(win: RevealableWindow | undefined): boolean {
  if (!win || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
  return true;
}
