import { bootWebApp } from "@pi-desktop/web-shell/client";
import { setupCompactHeader } from "@pi-desktop/web-shell/compact-header";

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
    // 휴대폰: 대화 위 정보 줄(대화 이름·폴더·모델)을 접었다 편다. 키보드가 뜨면 저절로 접는다
    setupCompactHeader({
      hide: [".chat-page .page-head"],
      anchor: ".chat-page",
      key: "pi-agent-compact-header",
      // 대화가 열린 화면에서만, 대화상자·메뉴·서랍이 덮으면 숨긴다
      when: ".chat-page .composer textarea:not(:disabled)",
      blockers: ".modal-backdrop, .ws-backdrop, body.ws-drawer-open",
    });
  },
});
