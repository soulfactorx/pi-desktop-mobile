import { bootWebApp } from "@pi-desktop/web-shell/client";

/**
 * Pi Desktop Agent 웹 화면의 시작점 (설계 DESIGN.md §5.11).
 * 연결이 열리면 Agent의 preload(window.piAgent를 둔다)와 화면을 그대로 불러온다. "electron"은 web-shell 대체 모듈로 묶인다.
 */
bootWebApp({
  title: "Pi Agent",
  urlCommand: "pi-web agent url",
  drawer: { panel: ".nav", keepOpen: ".folder-menu > button, .nav-close, .nav-act" },
  loadApp: async () => {
    await import("../../../agent/src/preload/index");
    await import("../../../agent/src/renderer/main");
    // 앱 화면 CSS 뒤에 두어야 같은 선택자를 덮는다
    await import("./web.css");
  },
});
