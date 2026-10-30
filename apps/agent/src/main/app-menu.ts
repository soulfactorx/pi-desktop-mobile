import type { MenuItemConstructorOptions } from "electron";

/**
 * 앱 메뉴바 (파일·편집·보기·도움말). 기능 화면(작업·예약·지식베이스·승인·사용량·설정)은 왼쪽 사이드바가 아니라 여기서 연다.
 * 메뉴 항목은 화면에 명령 id를 보내고, 화면(App.tsx)이 처리한다. electron 없이 모양만 만드는 함수라 테스트한다.
 */
export type MenuCommand =
  | "new-chat"
  | "new-chat-folder"
  | "rename-chat"
  | "close-chat"
  | "page:chat"
  | "page:tasks"
  | "page:memory"
  | "page:rules"
  | "page:usage"
  | "page:history"
  | "page:mcp"
  | "page:network"
  | "page:skills"
  | "page:settings";

export interface MenuHandlers {
  command: (id: MenuCommand) => void;
  checkForUpdates: () => void;
  openReleases: () => void;
  about: () => void;
}

export function appMenuTemplate(platform: NodeJS.Platform, isPackaged: boolean, h: MenuHandlers): MenuItemConstructorOptions[] {
  const cmd = (label: string, id: MenuCommand, accelerator?: string): MenuItemConstructorOptions => ({
    label,
    ...(accelerator ? { accelerator } : {}),
    click: () => h.command(id),
  });
  const mac = platform === "darwin";
  return [
    ...(mac ? [{ role: "appMenu" as const }] : []),
    {
      label: "파일",
      submenu: [
        cmd("새 대화", "new-chat", "CmdOrCtrl+N"),
        cmd("폴더를 골라 새 대화…", "new-chat-folder", "CmdOrCtrl+O"),
        cmd("지난 대화 열기…", "page:history", "CmdOrCtrl+Shift+O"),
        { type: "separator" },
        cmd("대화 이름 바꾸기…", "rename-chat", "F2"),
        cmd("대화 닫기", "close-chat"),
        { type: "separator" },
        mac ? { role: "close", label: "창 닫기" } : { role: "quit", label: "끝내기" },
      ],
    },
    { role: "editMenu", label: "편집" },
    {
      label: "보기",
      submenu: [
        cmd("대화", "page:chat", "CmdOrCtrl+1"),
        cmd("작업·예약", "page:tasks", "CmdOrCtrl+2"),
        cmd("지식베이스", "page:memory", "CmdOrCtrl+3"),
        cmd("스킬", "page:skills", "CmdOrCtrl+9"),
        cmd("승인", "page:rules", "CmdOrCtrl+4"),
        cmd("사용량", "page:usage", "CmdOrCtrl+5"),
        cmd("지난 대화", "page:history", "CmdOrCtrl+6"),
        cmd("웹 검색·MCP", "page:mcp", "CmdOrCtrl+7"),
        cmd("네트워크", "page:network", "CmdOrCtrl+8"),
        cmd("설정", "page:settings", "CmdOrCtrl+,"),
        { type: "separator" },
        { role: "resetZoom", label: "기본 크기" },
        { role: "zoomIn", label: "크게" },
        { role: "zoomOut", label: "작게" },
        ...(isPackaged ? [] : [{ type: "separator" as const }, { role: "reload" as const }, { role: "toggleDevTools" as const }]),
      ],
    },
    {
      label: "도움말",
      submenu: [
        { label: "업데이트 확인…", click: h.checkForUpdates },
        { label: "릴리스 페이지", click: h.openReleases },
        { type: "separator" },
        { label: "Pi Desktop Agent 정보", click: h.about },
      ],
    },
  ];
}
