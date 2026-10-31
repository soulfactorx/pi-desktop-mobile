import { useEffect, useState } from "react";
import { inputDebugEnabled, inputMode, setInputDebug, setInputMode } from "./terminal-input-settings";
import { OPEN_SESSION_COMMAND, WEB_MENU, type WebSetting } from "./web-menu";
import { FileManager } from "./FileManager";

function settingOn(id: WebSetting): boolean {
  if (id === "input-live") return inputMode() === "live";
  if (id === "input-xterm") return inputMode() === "xterm";
  return inputDebugEnabled();
}

function applySetting(id: WebSetting): void {
  if (id === "input-live") setInputMode("live");
  else if (id === "input-xterm") setInputMode("xterm");
  else setInputDebug(!inputDebugEnabled());
}

/**
 * 웹(pi-web)에서 메뉴바 대신 쓰는 "⋮ 메뉴" 버튼과 펼침 메뉴 (web-menu.ts).
 * 넓은 화면에서는 오른쪽 위에 떨어지는 메뉴, 휴대폰 폭에서는 화면 폭 전체를 쓰는 판으로 연다 (styles.css).
 */
export function WebMenu({ onCommand }: { onCommand: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  /** 파일 관리자 (웹에만 있다, window.piWeb) */
  const [filesOpen, setFilesOpen] = useState(false);
  const files = window.piWeb?.files;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="web-menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        title="메뉴 (데스크톱 앱의 메뉴바와 같은 명령)"
        onClick={() => setOpen((v) => !v)}
      >
        ⋮ 메뉴
      </button>
      {open && (
        <div className="web-menu-backdrop" onClick={() => setOpen(false)}>
          <div className="web-menu" role="menu" aria-label="메뉴" onClick={(e) => e.stopPropagation()}>
            {files && (
              <section className="web-menu-group">
                <h3>휴대폰</h3>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    setFilesOpen(true);
                  }}
                >
                  <span>파일 관리자</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    void window.piWeb?.checkNotifications();
                  }}
                >
                  <span>알림 켜기·시험</span>
                </button>
              </section>
            )}
            {WEB_MENU.map((group) => (
              <section key={group.label} className="web-menu-group">
                <h3>{group.label}</h3>
                {group.items.map((item) =>
                  item.kind === "setting" ? (
                    <button
                      key={item.id}
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={settingOn(item.id)}
                      onClick={() => {
                        setOpen(false);
                        applySetting(item.id);
                      }}
                    >
                      <span>{item.label}</span>
                      <span className="web-menu-check">{settingOn(item.id) ? "✓" : ""}</span>
                    </button>
                  ) : item.kind === "command" ? (
                    <button
                      key={item.id}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setOpen(false);
                        onCommand(item.id);
                      }}
                    >
                      <span>{item.label}</span>
                      {item.shortcut && <kbd>{item.shortcut}</kbd>}
                    </button>
                  ) : (
                    <a key={item.url} role="menuitem" href={item.url} target="_blank" rel="noreferrer" onClick={() => setOpen(false)}>
                      {item.label} ↗
                    </a>
                  ),
                )}
              </section>
            ))}
          </div>
        </div>
      )}
      {filesOpen && files && (
        <FileManager
          api={files}
          onClose={() => setFilesOpen(false)}
          onOpenSession={(path) => {
            setFilesOpen(false);
            onCommand(`${OPEN_SESSION_COMMAND}${path}`);
          }}
        />
      )}
    </>
  );
}
