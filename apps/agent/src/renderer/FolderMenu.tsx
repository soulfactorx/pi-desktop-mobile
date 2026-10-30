import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { folderName, isSameFolder } from "./recent-folders";

/**
 * 폴더를 고르는 작은 메뉴: 최근 폴더, 홈, 다른 폴더… (대화 머리의 "폴더 옮기기"와 사이드바 "새 대화"가 같이 쓴다)
 */
export function FolderMenu({
  label,
  title,
  className,
  disabled,
  heading,
  recent,
  home,
  exclude,
  onPick,
  onBrowse,
}: {
  label: ReactNode;
  title?: string;
  className?: string;
  disabled?: boolean;
  /** 메뉴 위에 보일 한 줄 설명 */
  heading: string;
  recent: string[];
  home?: string;
  /** 목록에서 뺄 폴더 (지금 대화의 폴더) */
  exclude?: string;
  onPick: (folder: string) => void;
  /** "다른 폴더…": 폴더 고르기 창을 띄운다 */
  onBrowse: () => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<CSSProperties>({ visibility: "hidden" });

  // 메뉴는 화면 기준(fixed)으로 띄운다. 사이드바처럼 넘침을 자르는 부모 안에 있어도 잘리지 않게,
  // 버튼 아래에 두되 창 오른쪽·아래 끝을 넘으면 안쪽으로 당긴다
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = box.current?.getBoundingClientRect();
    const menu = list.current?.getBoundingClientRect();
    if (!anchor || !menu) return;
    const margin = 8;
    const left = Math.max(margin, Math.min(anchor.left, window.innerWidth - menu.width - margin));
    const below = anchor.bottom + 4;
    const top = below + menu.height > window.innerHeight - margin ? Math.max(margin, anchor.top - menu.height - 4) : below;
    setPlace({ left, top });
  }, [open]);

  // 바깥을 누르거나 Esc를 누르면 닫는다
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    // 자리를 화면 기준으로 잡았으므로 창 크기가 바뀌면 닫는다
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("resize", close);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const folders = [...recent];
  if (home && !folders.some((f) => isSameFolder(f, home))) folders.push(home);
  const choices = folders.filter((f) => !exclude || !isSameFolder(f, exclude));
  const pick = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <div className="folder-menu" ref={box}>
      <button
        className={className}
        title={title}
        disabled={disabled}
        onClick={() => {
          setPlace({ visibility: "hidden" });
          setOpen((v) => !v);
        }}
      >
        {label}
      </button>
      {open && (
        <div className="folder-menu-list" role="menu" ref={list} style={place}>
          <div className="folder-menu-heading muted small-text">{heading}</div>
          {choices.map((folder) => (
            <button key={folder} role="menuitem" className="folder-menu-item" title={folder} onClick={() => pick(() => onPick(folder))}>
              <span>📁 {home && isSameFolder(folder, home) ? `홈 (${folderName(folder)})` : folderName(folder)}</span>
              <span className="muted small-text">{folder}</span>
            </button>
          ))}
          <button role="menuitem" className="folder-menu-item" onClick={() => pick(onBrowse)}>
            <span>다른 폴더…</span>
          </button>
        </div>
      )}
    </div>
  );
}
