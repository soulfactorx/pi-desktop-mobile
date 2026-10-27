import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addTab,
  attentionFor,
  closeTab,
  cycleTab,
  loadTabs,
  saveTabs,
  type Attention,
  type TabsState,
} from "./tabs-state";
import { tabShowing, type ActivityEntry } from "./activity-view";
import type { PaletteCommand } from "./palette";
import { ActivityButton, useActivity } from "./ActivityPanel";
import { sharedEventLog } from "./event-log";
import { UpdateBadge, useUpdateState } from "./UpdateBadge";
import { forgetTab, MAIN_TAB, setTabHost, setTabSession } from "./use-session";
import { MENU_EVENT, Workspace, type WorkspaceStatus } from "./Workspace";
import { WebMenu } from "./WebMenu";

/**
 * 워크스페이스 탭 (설계 §3.3). 탭마다 호스트와 세션을 따로 가지고, 숨긴 탭도 연결과 상태를 유지한다.
 * 숨긴 탭에서 작업이 끝나거나 입력이 필요해지면 탭에 표시하고 OS 알림을 띄운다.
 */
export function App() {
  const [tabs, setTabs] = useState<TabsState>(() => loadTabs(MAIN_TAB));
  const [statuses, setStatuses] = useState<Record<string, WorkspaceStatus>>({});
  const [attention, setAttention] = useState<Record<string, Attention | undefined>>({});
  const activeRef = useRef(tabs.active);
  activeRef.current = tabs.active;
  const statusesRef = useRef(statuses);
  statusesRef.current = statuses;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  useEffect(() => saveTabs(tabs), [tabs]);
  const update = useUpdateState();
  const [activityOpen, setActivityOpen] = useState(0);

  // Event Inspector가 열기 전에 온 이벤트도 보이도록 앱이 켜질 때부터 세션 이벤트를 모은다.
  useEffect(() => {
    sharedEventLog();
  }, []);

  // 탭을 열면 그 탭의 알림 표시를 지운다.
  useEffect(() => {
    setAttention((prev) => (prev[tabs.active] ? { ...prev, [tabs.active]: undefined } : prev));
  }, [tabs.active]);

  const activate = useCallback((id: string) => setTabs((prev) => ({ ...prev, active: id })), []);

  const onStatus = useCallback((id: string, status: WorkspaceStatus) => {
    const before = statusesRef.current[id];
    setStatuses((prev) => ({ ...prev, [id]: status }));
    if (id === activeRef.current) return;
    const kind = attentionFor(before, status);
    if (!kind) return;
    setAttention((prev) => ({ ...prev, [id]: kind }));
    notify(status.title, kind, () => activate(id));
  }, [activate]);

  const newTab = useCallback(() => {
    const id = `t${Date.now().toString(36)}`;
    // 지금 보던 탭과 같은 호스트로 시작한다.
    const host = statusesRef.current[activeRef.current]?.hostId;
    if (host) setTabHost(id, host);
    setTabs((prev) => addTab(prev, id));
  }, []);

  const close = useCallback((id: string) => {
    setTabs((prev) => {
      const next = closeTab(prev, id);
      if (next !== prev) forgetTab(id);
      return next;
    });
    setStatuses((prev) => {
      const { [id]: _closed, ...rest } = prev;
      return rest;
    });
  }, []);

  // 활동 패널: 탭들이 연결해 쓰는 호스트의 세션을 모은다.
  const activityHosts = useMemo(() => {
    const map = new Map<string, string>();
    for (const status of Object.values(statuses)) {
      if (status && !status.disconnected) map.set(status.hostId, status.hostLabel);
    }
    return [...map].map(([hostId, hostLabel]) => ({ hostId, hostLabel }));
  }, [statuses]);
  const activity = useActivity(activityHosts);

  /** 활동 패널에서 고른 세션: 보는 탭이 있으면 그 탭으로, 없으면 그 호스트·세션으로 새 탭을 연다 */
  const openActivity = useCallback(
    (entry: ActivityEntry) => {
      const shown = tabShowing(statusesRef.current, entry.hostId, entry.session.sessionId);
      if (shown) {
        activate(shown);
        return;
      }
      const id = `t${Date.now().toString(36)}`;
      setTabHost(id, entry.hostId);
      setTabSession(id, entry.hostId, entry.session);
      setTabs((prev) => addTab(prev, id));
    },
    [activate],
  );

  // 명령 팔레트의 탭 명령
  const appCommands = useMemo((): PaletteCommand[] => {
    const list: PaletteCommand[] = [
      { id: "tab-new", group: "탭", title: "새 탭", hint: "Ctrl+T", keywords: "new tab", run: newTab },
      {
        id: "tab-close",
        group: "탭",
        title: "탭 닫기",
        hint: "Ctrl+W",
        keywords: "close tab",
        disabled: tabs.ids.length <= 1,
        run: () => close(tabs.active),
      },
    ];
    tabs.ids.forEach((id, index) => {
      if (id === tabs.active) return;
      const status = statuses[id];
      list.push({
        id: `tab-${id}`,
        group: "탭",
        title: `탭으로: ${status?.title ?? "새 탭"}`,
        hint: index < 9 ? `Ctrl+${index + 1}` : (status?.hostLabel ?? ""),
        run: () => activate(id),
      });
    });
    list.push({
      id: "app-update",
      group: "앱",
      title:
        update?.status === "downloaded"
          ? `다시 시작해 ${update.version} 설치`
          : update?.status === "available"
            ? `새 버전 ${update.version} 업데이트…`
            : "업데이트 확인",
      hint: update ? `지금 ${update.current}` : "",
      keywords: "update upgrade version release 업데이트 버전",
      disabled: !update || update.status === "disabled",
      // 직접 확인하면 결과를 알리고, 새 버전이 있으면 업데이트할지 묻는다 (내려받았으면 다시 시작할지 묻는다).
      run: () => void window.piDesktop.checkForUpdates(true),
    });
    return list;
  }, [tabs, statuses, newTab, close, activate, update]);

  // 단축키: Ctrl+T 새 탭, Ctrl+W 탭 닫기, Ctrl+Tab·Ctrl+Shift+Tab 탭 이동, Ctrl+1~9 탭 고르기
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "t") newTab();
      else if (key === "w") close(activeRef.current);
      else if (key === "tab") setTabs((prev) => cycleTab(prev, e.shiftKey ? -1 : 1));
      else if (/^[1-9]$/.test(key)) {
        const target = tabsRef.current.ids[Number(key) - 1];
        if (target) activate(target);
        else return;
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [newTab, close, activate]);

  // 메뉴바 명령: 앱 수준(탭·업데이트·활동)은 여기서, 나머지는 지금 탭의 Workspace가 처리한다 (MENU_EVENT).
  const appCommandsRef = useRef(appCommands);
  appCommandsRef.current = appCommands;
  // 웹(pi-web)에는 메뉴바가 없어 화면 안의 메뉴(WebMenu)가 같은 처리를 부른다.
  const runMenuCommand = useCallback((id: string) => {
    if (id === "activity") {
      setActivityOpen((n) => n + 1);
      return;
    }
    const own = appCommandsRef.current.find((c) => c.id === id);
    if (own) {
      if (!own.disabled) own.run();
      return;
    }
    window.dispatchEvent(new CustomEvent(MENU_EVENT, { detail: id }));
  }, []);
  useEffect(() => window.piDesktop.onMenuCommand(runMenuCommand), [runMenuCommand]);

  return (
    <div className="app-shell">
      <nav className="tabbar" role="tablist" aria-label="워크스페이스">
        {tabs.ids.map((id, index) => {
          const status = statuses[id];
          const mark = attention[id];
          return (
            <div
              key={id}
              role="tab"
              aria-selected={id === tabs.active}
              tabIndex={0}
              className={`tab${id === tabs.active ? " active" : ""}`}
              title={status ? `${status.title} · ${status.hostLabel} (Ctrl+${index + 1})` : undefined}
              onClick={() => activate(id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") activate(id);
              }}
              onAuxClick={(e) => {
                // 가운데 버튼으로 닫기
                if (e.button === 1) close(id);
              }}
            >
              <span className={`tab-dot${status?.running ? " running" : ""}${status?.disconnected ? " offline" : ""}`} />
              <span className="tab-title">{status?.title ?? "새 탭"}</span>
              {status && status.hostId !== "local" && <span className="tab-host">{status.hostLabel}</span>}
              {mark && <span className={`tab-mark ${mark}`}>{mark === "input" ? "입력 필요" : "완료"}</span>}
              {tabs.ids.length > 1 && (
                <button
                  type="button"
                  className="tab-close"
                  aria-label="탭 닫기"
                  title="탭 닫기 (Ctrl+W). 이 탭의 Pi 세션은 계속 돌고, 사이드바의 실행 중에서 다시 열 수 있습니다"
                  onClick={(e) => {
                    e.stopPropagation();
                    close(id);
                  }}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
        <button type="button" className="tab-new" onClick={newTab} title="새 탭 (Ctrl+T)" aria-label="새 탭">
          +
        </button>
        <div className="tabbar-spacer" />
        <UpdateBadge state={update} />
        <ActivityButton entries={activity} onOpen={openActivity} openSignal={activityOpen} />
        {window.piDesktop.shell === "web" && <WebMenu onCommand={runMenuCommand} />}
      </nav>
      <div className="workspaces">
        {tabs.ids.map((id) => (
          <Workspace key={id} tabId={id} active={id === tabs.active} onStatus={onStatus} appCommands={appCommands} />
        ))}
      </div>
    </div>
  );
}

/** 숨긴 탭의 소식을 OS 알림으로 띄운다. 누르면 그 탭을 연다. 알림 권한이 없으면 탭 표시만 남는다. */
function notify(title: string, kind: Attention, onClick: () => void): void {
  try {
    if (typeof Notification === "undefined" || Notification.permission === "denied") return;
    const body = kind === "input" ? "답을 기다리고 있습니다." : "작업이 끝났습니다.";
    const notification = new Notification(`Pi Desktop — ${title}`, { body, silent: kind === "done" });
    notification.onclick = () => {
      window.focus();
      onClick();
    };
  } catch {
    // 알림을 띄울 수 없는 환경이면 무시
  }
}
