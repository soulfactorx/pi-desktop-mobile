import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { FsListDirResult } from "@pi-desktop/host-protocol/messages";
import { childPath, emptyText, errorText, pathCrumbs, visibleDirs } from "./folder-browser";

interface Props {
  hostId: string;
  hostLabel: string;
  /** 처음 열 폴더. 비었으면 홈 */
  initialPath: string;
  onPick: (path: string) => void;
  onClose: () => void;
}

/**
 * 호스트의 폴더를 데몬으로 훑는 폴더 선택 창 (설계 §5.5, M3).
 * Windows 폴더 선택 대화상자로는 볼 수 없는 WSL(나중에 SSH) 안의 폴더를 고른다.
 * - 글자를 치면 이 폴더의 하위 폴더를 거르고, ↑·↓로 고르고 Enter로 들어간다
 * - 거르기 칸이 빈 채 Backspace를 누르면 상위 폴더로, Ctrl+Enter는 지금 폴더를 고른다
 */
export function FolderBrowser({ hostId, hostLabel, initialPath, onPick, onClose }: Props) {
  const [listing, setListing] = useState<FsListDirResult | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [selected, setSelected] = useState(0);
  const [typedPath, setTypedPath] = useState("");
  /** 지금 폴더 안에 새 폴더를 만드는 중이면 그 이름 */
  const [newName, setNewName] = useState<string | undefined>();
  const list = useRef<HTMLUListElement>(null);
  const filterInput = useRef<HTMLInputElement>(null);

  const dirs = useMemo(() => (listing ? visibleDirs(listing.dirs, filter, showHidden) : []), [listing, filter, showHidden]);

  async function open(path: string | undefined, fallbackHome = false) {
    setLoading(true);
    try {
      // agent: Agent의 preload API
      const result = await window.piAgent.listDir(hostId, path);
      setListing(result);
      setTypedPath(result.path);
      setFilter("");
      setSelected(0);
      setError(undefined);
    } catch (e) {
      // 처음 연 폴더(예: 입력창에 쓰다 만 경로)가 없으면 홈으로 연다.
      if (fallbackHome) return void open(undefined);
      setError(errorText(e));
    } finally {
      setLoading(false);
      filterInput.current?.focus();
    }
  }

  useEffect(() => {
    void open(initialPath.trim() || undefined, Boolean(initialPath.trim()));
  }, [hostId]);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  function enter(name: string | undefined) {
    if (listing && name !== undefined) void open(childPath(listing.path, name));
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setSelected((at) => Math.max(0, Math.min(dirs.length - 1, at + step)));
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (listing) onPick(listing.path);
    } else if (e.key === "Enter") {
      e.preventDefault();
      enter(dirs[selected]);
    } else if (e.key === "Backspace" && !filter && listing?.parent) {
      e.preventDefault();
      void open(listing.parent);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal folder-browser" role="dialog" aria-label="폴더 선택">
        <div className="modal-head">
          <span className="modal-badge">{hostLabel}</span>
        </div>
        <h2 className="modal-title">작업 폴더 선택</h2>
        <form
          className="folder-path"
          onSubmit={(e) => {
            e.preventDefault();
            void open(typedPath);
          }}
        >
          <input value={typedPath} onChange={(e) => setTypedPath(e.target.value)} aria-label="폴더 경로" spellCheck={false} />
          <button type="submit" disabled={loading}>
            이동
          </button>
          <button type="button" disabled={loading || !listing} onClick={() => void open(listing?.home)} title="홈 폴더">
            홈
          </button>
        </form>
        {listing && (
          <div className="folder-crumbs">
            {pathCrumbs(listing.path).map((crumb) => (
              <button key={crumb.path} type="button" onClick={() => void open(crumb.path)}>
                {crumb.label}
              </button>
            ))}
          </div>
        )}
        <div className="folder-filter">
          <input
            ref={filterInput}
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setSelected(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="하위 폴더 거르기 (Enter 들어가기 · Backspace 위로 · Ctrl+Enter 선택)"
            aria-label="하위 폴더 거르기"
            autoFocus
          />
          <label className="muted">
            <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> 숨김 폴더
          </label>
        </div>
        {error && <div className="banner error">{error}</div>}
        <ul className="folder-list" ref={list}>
          {listing?.parent && !filter && (
            <li className="folder-item" onDoubleClick={() => void open(listing.parent)} onClick={() => void open(listing.parent)}>
              ..
            </li>
          )}
          {dirs.map((name, i) => (
            <li
              key={name}
              data-index={i}
              className={`folder-item${i === selected ? " selected" : ""}`}
              onClick={() => setSelected(i)}
              onDoubleClick={() => enter(name)}
            >
              {name}/
            </li>
          ))}
          {listing && dirs.length === 0 && <li className="palette-empty">{emptyText(listing.dirs, filter, showHidden)}</li>}
          {listing?.truncated && <li className="palette-empty">폴더가 너무 많아 일부만 보여 줍니다. 거르기로 찾으세요.</li>}
        </ul>
        {newName !== undefined && listing && (
          <form
            className="folder-new"
            onSubmit={(e) => {
              e.preventDefault();
              void (async () => {
                try {
                  // agent: Agent의 preload API
                  const made = await window.piAgent.makeDir(hostId, listing.path, newName);
                  setNewName(undefined);
                  await open(made);
                } catch (err) {
                  setError(errorText(err));
                }
              })();
            }}
          >
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="새 폴더 이름" spellCheck={false} autoFocus />
            <button type="submit" className="primary" disabled={!newName.trim()}>
              만들고 들어가기
            </button>
            <button type="button" onClick={() => setNewName(undefined)}>
              취소
            </button>
          </form>
        )}
        <div className="modal-actions">
          <span className="folder-current muted" title={listing?.path}>
            {listing?.path}
          </span>
          <button type="button" disabled={!listing || loading || newName !== undefined} onClick={() => setNewName("")}>
            새 폴더
          </button>
          <button type="button" onClick={onClose}>
            취소
          </button>
          <button type="button" className="primary" disabled={!listing || loading} onClick={() => listing && onPick(listing.path)}>
            이 폴더 선택
          </button>
        </div>
      </div>
    </div>
  );
}
