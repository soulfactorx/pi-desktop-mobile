import type { MenuItemConstructorOptions } from "electron";

/**
 * 앱 메뉴바. Electron 기본 메뉴 대신 앱 기능 메뉴를 둔다.
 *
 * 앱 기능 항목은 화면에 "메뉴 명령 id"를 보내고, 지금 탭이 같은 id의 명령 팔레트 명령을 실행한다
 * (그래서 메뉴와 팔레트가 같은 동작을 한다). 단축키(Ctrl+K·T·W 등)는 화면이 이미 처리하므로
 * 메뉴에는 표시만 하고 등록하지 않는다(registerAccelerator: false). 편집·확대 같은 OS 동작은 Electron role을 쓴다.
 */

export interface MenuActions {
  /** 화면(지금 탭)에 메뉴 명령을 보낸다 */
  command: (id: string) => void;
  openUrl: (url: string) => void;
  about: () => void;
}

const REPO = "https://github.com/skax-soulfactor/pi-desktop";

export function appMenuTemplate(platform: NodeJS.Platform, actions: MenuActions): MenuItemConstructorOptions[] {
  const mac = platform === "darwin";
  const mod = mac ? "Cmd" : "Ctrl";
  const item = (id: string, label: string, accelerator?: string): MenuItemConstructorOptions => ({
    id,
    label,
    click: () => actions.command(id),
    ...(accelerator ? { accelerator, registerAccelerator: false } : {}),
  });

  const template: MenuItemConstructorOptions[] = [];
  if (mac) {
    template.push({
      label: "Pi Desktop",
      submenu: [
        { label: "Pi Desktop 정보", click: actions.about },
        item("app-update", "업데이트 확인…"),
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide", label: "Pi Desktop 가리기" },
        { role: "hideOthers", label: "기타 가리기" },
        { role: "unhide", label: "모두 보기" },
        { type: "separator" },
        { role: "quit", label: "Pi Desktop 종료" },
      ],
    });
  }
  template.push(
    {
      label: "파일",
      submenu: [
        item("tab-new", "새 탭", `${mod}+T`),
        item("session-new-here", "같은 폴더에서 새 세션"),
        { type: "separator" },
        item("folder-pick", "폴더 선택…"),
        item("new-folder", "새 폴더…"),
        { type: "separator" },
        item("export", "HTML로 내보내기"),
        item("tui", "터미널 pi(TUI)에서 열기…"),
        { type: "separator" },
        item("tab-close", "탭 닫기", `${mod}+W`),
        ...(mac ? [] : [{ type: "separator" as const }, { role: "quit" as const, label: "종료" }]),
      ],
    },
    {
      label: "편집",
      submenu: [
        { role: "undo", label: "실행 취소" },
        { role: "redo", label: "다시 실행" },
        { type: "separator" },
        { role: "cut", label: "잘라내기" },
        { role: "copy", label: "복사" },
        { role: "paste", label: "붙여넣기" },
        { role: "selectAll", label: "모두 선택" },
      ],
    },
    {
      label: "보기",
      submenu: [
        item("palette", "명령 팔레트", `${mod}+K`),
        item("resources", "리소스"),
        item("tree", "세션 트리"),
        item("activity", "활동·작업 기록"),
        { type: "separator" },
        { role: "zoomIn", label: "크게" },
        { role: "zoomOut", label: "작게" },
        { role: "resetZoom", label: "원래 크기" },
        { type: "separator" },
        { role: "togglefullscreen", label: "전체 화면" },
      ],
    },
    {
      label: "세션",
      submenu: [
        item("compact", "대화 요약 (Compact)"),
        item("auto-compact", "자동 컴팩션 켜기·끄기"),
        { type: "separator" },
        item("abort", "중단"),
        item("clear-queue", "대기 중인 메시지를 입력창으로"),
        item("session-restart", "세션 새로고침 (로그인 뒤 모델 다시 읽기)"),
        { type: "separator" },
        item("model", "모델 고르기…"),
        item("thinking", "Thinking 수준…"),
      ],
    },
    {
      label: "Pi",
      submenu: [
        item("pi-manager", "Pi 관리"),
        item("pi-providers", "프로바이더·로그인"),
        item("pi-settings", "설정"),
        { type: "separator" },
        item("marketplace", "Marketplace"),
        item("usage", "사용량"),
        { type: "separator" },
        item("terminal-pi", "터미널: pi 열기"),
        item("terminal-shell", "터미널: 셸 열기"),
      ],
    },
    {
      label: "개발자 도구",
      submenu: [
        item("event-inspector", "Event Inspector"),
        item("sdk-playground", "SDK Playground"),
        item("extension-dev-mode", "Extension Dev Mode 켜기·끄기"),
        { type: "separator" },
        { role: "toggleDevTools", label: "앱 개발자 도구 (Chromium)" },
      ],
    },
    {
      label: "도움말",
      submenu: [
        ...(mac ? [] : [item("app-update", "업데이트 확인…"), { type: "separator" as const }]),
        { label: "릴리스 노트", click: () => actions.openUrl(`${REPO}/releases`) },
        { label: "사용 설명 (README)", click: () => actions.openUrl(`${REPO}#readme`) },
        { label: "문제 알리기", click: () => actions.openUrl(`${REPO}/issues`) },
        { label: "Pi 문서", click: () => actions.openUrl("https://pi.dev") },
        ...(mac ? [] : [{ type: "separator" as const }, { label: "Pi Desktop 정보", click: actions.about }]),
      ],
    },
  );
  return template;
}

/** 메뉴에 있는 앱 명령 id들 (테스트·화면 쪽 처리 확인용) */
export function menuCommandIds(template: readonly MenuItemConstructorOptions[]): string[] {
  const ids: string[] = [];
  const walk = (items: readonly MenuItemConstructorOptions[]) => {
    for (const i of items) {
      if (i.id && i.click) ids.push(i.id);
      if (Array.isArray(i.submenu)) walk(i.submenu);
    }
  };
  walk(template);
  return [...new Set(ids)];
}
