/**
 * 웹(pi-web) 화면의 메뉴 (설계 §5.10). 브라우저에는 Electron 메뉴바가 없으므로 같은 앱 명령을 화면 안의 메뉴로 보여 준다.
 *
 * 항목 id는 데스크톱 메뉴바(main/app-menu.ts)의 명령 id와 같고, 고르면 메뉴바와 같은 길로 처리한다(App.tsx의 runMenuCommand).
 * 실행 취소·확대·전체 화면·종료처럼 브라우저가 직접 하는 OS 동작과, 웹에서 쓸 수 없는 앱 업데이트는 뺀다.
 */

export type WebMenuItem =
  | { kind: "command"; id: string; label: string; shortcut?: string }
  | { kind: "link"; label: string; url: string }
  /** 웹에만 있는 설정 (terminal-input-settings.ts). 메뉴에서 바로 바꾸고 켜짐 표시를 한다 */
  | { kind: "setting"; id: WebSetting; label: string };

export type WebSetting = "input-live" | "input-xterm" | "input-debug";

export interface WebMenuGroup {
  label: string;
  items: WebMenuItem[];
}

const command = (id: string, label: string, shortcut?: string): WebMenuItem => ({ kind: "command", id, label, ...(shortcut ? { shortcut } : {}) });
const link = (label: string, url: string): WebMenuItem => ({ kind: "link", label, url });

const REPO = "https://github.com/soulfactorx/pi-desktop-mobile";

export const WEB_MENU: WebMenuGroup[] = [
  {
    label: "파일",
    items: [
      command("tab-new", "새 탭", "Ctrl+T"),
      command("session-new-here", "같은 폴더에서 새 세션"),
      command("folder-pick", "폴더 선택…"),
      command("new-folder", "새 폴더…"),
      command("export", "HTML로 내보내기"),
      command("tui", "터미널 pi(TUI)에서 열기…"),
      command("tab-close", "탭 닫기", "Ctrl+W"),
    ],
  },
  {
    label: "보기",
    items: [
      command("palette", "명령 팔레트", "Ctrl+K"),
      command("resources", "리소스"),
      command("tree", "세션 트리"),
      command("activity", "활동·작업 기록"),
    ],
  },
  {
    label: "세션",
    items: [
      command("compact", "대화 요약 (Compact)"),
      command("auto-compact", "자동 컴팩션 켜기·끄기"),
      command("abort", "중단"),
      command("clear-queue", "대기 중인 메시지를 입력창으로"),
      command("session-restart", "세션 새로고침 (로그인 뒤 모델 다시 읽기)"),
      command("model", "모델 고르기…"),
      command("thinking", "Thinking 수준…"),
    ],
  },
  {
    label: "Pi",
    items: [
      command("pi-manager", "Pi 관리"),
      command("pi-providers", "프로바이더·로그인"),
      command("pi-settings", "설정"),
      command("marketplace", "Marketplace"),
      command("usage", "사용량"),
      command("terminal-pi", "터미널: pi 열기"),
      command("terminal-shell", "터미널: 셸 열기"),
    ],
  },
  {
    label: "터미널 입력 (휴대폰)",
    items: [
      { kind: "setting", id: "input-live", label: "바로 입력 (글자마다 바로 보냄)" },
      { kind: "setting", id: "input-xterm", label: "단어 단위 (키보드가 확정할 때 보냄)" },
      { kind: "setting", id: "input-debug", label: "입력 진단 보기" },
    ],
  },
  {
    label: "개발자 도구",
    items: [
      command("event-inspector", "Event Inspector"),
      command("sdk-playground", "SDK Playground"),
      command("extension-dev-mode", "Extension Dev Mode 켜기·끄기"),
    ],
  },
  {
    label: "도움말",
    items: [
      link("릴리스 노트", `${REPO}/releases`),
      link("사용 설명 (README)", `${REPO}#readme`),
      link("문제 알리기", `${REPO}/issues`),
      link("Pi 문서", "https://pi.dev"),
    ],
  },
];

/** 파일 관리자의 "이 폴더에서 새 세션": 지금 탭에 보내는 명령 (뒤에 폴더 경로를 붙인다, Workspace.tsx) */
export const OPEN_SESSION_COMMAND = "open-session:";

/** 웹 메뉴의 명령 id들 */
export function webMenuCommandIds(groups: readonly WebMenuGroup[] = WEB_MENU): string[] {
  return groups.flatMap((g) => g.items.flatMap((i) => (i.kind === "command" ? [i.id] : [])));
}
