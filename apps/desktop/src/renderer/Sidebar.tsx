import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import type { SessionSummary, StoredSession } from "@pi-desktop/host-protocol/messages";
import { baseName, formatRelative } from "./format";
import { matchesQuery, normalizeSessionName } from "./session-search";
import { visibleHistory, type BinTab } from "./session-bin";

type Scope = "folder" | "all";
const SCOPE_KEY = "pi-desktop.historyScope";

interface Props {
  hostId: string;
  connected: boolean;
  /** 데몬에서 실행 중인(또는 종료된 채 남은) 세션 */
  sessions: SessionSummary[];
  current?: SessionSummary;
  disabled: boolean;
  onSelect: (session: SessionSummary) => void;
  onOpenStored: (stored: StoredSession) => void;
  /** 실행 중인 세션을 닫는다 (Pi 종료). 대화는 기록에 남는다 */
  onClose: (session: SessionSummary) => void;
  /** 세션 파일을 지운다 (화면이 확인을 받은 뒤 백업 폴더로 옮김). 실행 중이면 닫은 뒤 지운다 */
  onDelete: (target: { path: string; title: string; running: boolean }) => void;
  /** 기록에서 숨긴다 (아카이브). 파일은 그대로 */
  onArchive: (path: string, title: string) => void;
  /** 아카이브·휴지통 화면을 연다 */
  onOpenBin: (tab: BinTab) => void;
  /** 보고 있는 세션의 이름 (get_state). 기록을 다시 읽기 전에도 바로 보이게 한다 */
  currentName?: string;
  /** 보고 있는 세션의 이름을 바꾼다. 실행 중인 세션만 바꿀 수 있다 */
  onRename?: (name: string) => Promise<void>;
  /** 값이 바뀌면 기록을 다시 읽는다 (이름 변경 뒤 등) */
  refreshKey?: number;
  /** 이 호스트에 Pi가 없으면(true) 기록 오류 대신 설치 안내를 보인다. 기록은 있다고 확인된 뒤(false)에만 읽는다 (없으면 아직 모름) */
  piMissing?: boolean;
  /** Pi 설치 화면(Pi 관리 → 상태)을 연다 */
  onInstallPi?: () => void;
}

/**
 * 세션 사이드바 (설계 §4.1).
 * - 실행 중: 데몬이 가진 세션. 확장 다이얼로그가 답을 기다리면 "입력 필요" 표시
 * - 기록: Pi가 디스크에 저장한 세션 (데몬이 Pi SDK로 읽음). 이 폴더 / 전체 범위 전환
 * - 검색: 두 목록을 이름·첫 메시지·폴더·파일 경로로 거른다
 * - 이름 변경: 보고 있는 실행 중 세션의 ✎ (set_session_name)
 * - 닫기: 실행 중 세션의 ✕. Pi를 끄고, 다시 쓰려면 기록에서 연다
 * - 삭제: 🗑. 세션 파일을 지운다 (확인을 받고, 데몬의 휴지통으로 옮겨 되살릴 수 있음)
 * - 아카이브: 기록의 📦. 파일은 그대로 두고 기록에서만 숨긴다. 기록 아래 "아카이브·휴지통"에서 되돌린다
 */
export function Sidebar(props: Props) {
  const { hostId, connected, sessions, current, disabled, onSelect, onOpenStored, onClose, onDelete, onArchive, onOpenBin, currentName, onRename, refreshKey, piMissing, onInstallPi } = props;
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | undefined>();
  const [scope, setScope] = useState<Scope>(() => {
    try {
      return localStorage.getItem(SCOPE_KEY) === "all" ? "all" : "folder";
    } catch {
      return "folder";
    }
  });
  const [history, setHistory] = useState<StoredSession[]>([]);
  // 한 번 읽은 기록의 제목(세션 파일 → 이름이나 첫 메시지). 기록은 "이 폴더"로 걸러지므로, 다른 폴더의
  // 실행 중 세션도 제목이 바뀌지 않게 지금 목록과 따로 기억해 둔다.
  const [titles, setTitles] = useState<ReadonlyMap<string, string>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  // 보던 세션이 없으면 폴더를 알 수 없으므로 전체를 보여준다.
  const folder = scope === "folder" ? current?.cwd : undefined;

  const load = useCallback(async () => {
    // Pi가 있다고 확인된 뒤에만 읽는다. 없거나 아직 모르면 데몬이 오류를 낸다. 설치되어 false가 되면 다시 읽는다.
    if (!connected || piMissing !== false) return;
    setLoading(true);
    try {
      const list = await window.piDesktop.listHistory(hostId, folder);
      setHistory(list);
      setTitles((prev) => {
        const next = new Map(prev);
        for (const h of list) {
          const title = h.name ?? h.firstMessage;
          if (title) next.set(h.path, title);
        }
        return next;
      });
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [connected, hostId, folder, piMissing]);

  // 다른 호스트의 기록이 잠깐이라도 보이지 않게 호스트가 바뀔 때만 비운다.
  // 세션을 바꿀 때마다 비우면 목록이 깜박인다.
  useEffect(() => {
    setHistory([]);
    setTitles(new Map());
  }, [hostId]);

  // Pi를 지우면 남아 있던 기록 목록을 치운다 (설치 안내만 보인다).
  useEffect(() => {
    if (piMissing) setHistory([]);
  }, [piMissing]);

  useEffect(() => {
    void load();
  }, [load, current?.sessionFile, refreshKey]);

  // 실행이 끝나면 기록(메시지 수·수정 시각)이 바뀌므로 잠시 모았다가 다시 읽는다.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = window.piDesktop.onSessionEvent((id, n) => {
      if (id !== hostId || (n.event as { type?: string } | null)?.type !== "agent_settled") return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), 800);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [hostId, load]);

  const changeScope = (next: Scope) => {
    setScope(next);
    try {
      localStorage.setItem(SCOPE_KEY, next);
    } catch {
      // 무시
    }
  };

  const liveFiles = new Set(sessions.filter((s) => s.state === "running").map((s) => s.sessionFile));
  // 실행 중 세션은 폴더 이름만으로는 구별이 안 되므로, 같은 세션 파일의 기록에서 이름이나 첫 메시지를 가져온다.
  // 기록에 아직 없으면(첫 메시지 전 등) 데몬이 아는 제목, 그것도 없으면 폴더 이름.
  const liveTitle = (s: SessionSummary) => {
    if (s.sessionId === current?.sessionId && currentName) return currentName;
    return (s.sessionFile ? titles.get(s.sessionFile) : undefined) ?? s.title ?? baseName(s.cwd);
  };
  const ordered = [...sessions]
    .sort((a, b) => b.startedAt - a.startedAt)
    .filter((s) => matchesQuery(query, [liveTitle(s), s.cwd, s.sessionFile]));
  const shownHistory = visibleHistory(history).filter((h) => matchesQuery(query, [h.name, h.firstMessage, h.cwd, h.path]));

  const startRename = (s: SessionSummary) => setEditing(liveTitle(s));
  const commitRename = async (value: string) => {
    setEditing(undefined);
    const name = normalizeSessionName(value);
    if (name && onRename) await onRename(name);
  };
  const onRenameKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter") void commitRename(e.currentTarget.value);
    else if (e.key === "Escape") setEditing(undefined);
  };

  return (
    <aside className="sidebar">
      <input
        className="sidebar-search"
        type="search"
        placeholder="세션 검색 (이름, 첫 메시지, 폴더)"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setQuery("");
        }}
        aria-label="세션 검색"
      />
      <section>
        <h3 className="sidebar-title">실행 중</h3>
        {ordered.length === 0 && (
          <p className="sidebar-empty">{query ? "검색 결과가 없습니다." : "실행 중인 세션이 없습니다."}</p>
        )}
        {ordered.map((s) => {
          const isCurrent = s.sessionId === current?.sessionId;
          const canRename = isCurrent && s.state === "running" && onRename !== undefined;
          if (isCurrent && editing !== undefined) {
            return (
              <div key={s.sessionId} className="session-item current editing">
                <input
                  className="rename-input"
                  defaultValue={editing}
                  autoFocus
                  aria-label="세션 이름"
                  onKeyDown={onRenameKey}
                  onBlur={(e) => void commitRename(e.currentTarget.value)}
                  onFocus={(e) => e.currentTarget.select()}
                />
                <span className="session-meta-line">Enter 저장 · Esc 취소</span>
              </div>
            );
          }
          return (
            <div key={s.sessionId} className="session-row">
              <button
                type="button"
                className={`session-item${isCurrent ? " current" : ""}`}
                disabled={disabled}
                onClick={() => onSelect(s)}
                title={s.sessionFile ?? s.cwd}
              >
                <span className={`dot ${s.state}`} />
                <span className="session-name">{liveTitle(s)}</span>
                <span className="session-meta-line">
                  {baseName(s.cwd)} · {formatRelative(s.startedAt)}
                  {s.state === "exited" && " · 종료됨"}
                </span>
                {s.pendingUi > 0 && <span className="needs-input">입력 필요</span>}
              </button>
              {canRename && (
                <button
                  type="button"
                  className="rename-button"
                  disabled={disabled}
                  onClick={() => startRename(s)}
                  title="세션 이름 바꾸기 (기록과 터미널 pi의 /resume에도 보입니다)"
                  aria-label="세션 이름 바꾸기"
                >
                  ✎
                </button>
              )}
              {s.sessionFile && (
                <button
                  type="button"
                  className="delete-session-button"
                  disabled={disabled}
                  onClick={() => onDelete({ path: s.sessionFile!, title: liveTitle(s), running: s.state === "running" })}
                  title="세션 삭제 (Pi를 닫고 대화 기록 파일을 휴지통으로 옮깁니다. 휴지통에서 되살릴 수 있습니다)"
                  aria-label="세션 삭제"
                >
                  🗑
                </button>
              )}
              <button
                type="button"
                className="close-session-button"
                disabled={disabled}
                onClick={() => onClose(s)}
                title={s.state === "running" ? "세션 닫기 (Pi를 끕니다. 대화는 기록에 남아 다시 열 수 있습니다)" : "목록에서 지우기"}
                aria-label="세션 닫기"
              >
                ✕
              </button>
            </div>
          );
        })}
      </section>

      <section className="history">
        <div className="sidebar-title-row">
          <h3 className="sidebar-title">기록</h3>
          <div className="segmented" role="tablist">
            <button
              type="button"
              className={scope === "folder" ? "on" : ""}
              disabled={!current}
              title={current ? current.cwd : "세션을 열면 그 폴더의 기록을 볼 수 있습니다"}
              onClick={() => changeScope("folder")}
            >
              이 폴더
            </button>
            <button type="button" className={scope === "all" || !current ? "on" : ""} onClick={() => changeScope("all")}>
              전체
            </button>
          </div>
        </div>
        {piMissing ? (
          <div className="sidebar-notice">
            <p>이 호스트에 Pi가 설치되어 있지 않아 세션을 열거나 기록을 볼 수 없습니다.</p>
            {onInstallPi && (
              <button type="button" className="primary" onClick={onInstallPi}>
                Pi 설치하기
              </button>
            )}
          </div>
        ) : (
          error && <p className="sidebar-error">{error}</p>
        )}
        {piMissing === false && !error && !loading && shownHistory.length === 0 && history.length === 0 && (
          <p className="sidebar-empty">저장된 세션이 없습니다.</p>
        )}
        {piMissing === false && !error && !loading && shownHistory.length === 0 && history.length > 0 && (
          <p className="sidebar-empty">{query ? "검색 결과가 없습니다." : "보이는 세션이 없습니다 (모두 아카이브함)."}</p>
        )}
        {shownHistory.map((h) => {
          const open = liveFiles.has(h.path);
          const title = h.name ?? (h.firstMessage || "(빈 세션)");
          return (
            <div key={h.path} className="session-row history-row">
              <button
                type="button"
                className={`session-item${h.path === current?.sessionFile ? " current" : ""}`}
                disabled={disabled}
                onClick={() => onOpenStored(h)}
                title={h.cwdMissing ? `${h.path}\n작업 폴더가 없습니다: ${h.cwd}` : h.path}
              >
                <span className="session-name">{title}</span>
                <span className="session-meta-line">
                  {formatRelative(h.modified)} · 메시지 {h.messageCount}
                  {!folder && ` · ${baseName(h.cwd)}`}
                  {h.parentSessionPath && " · 분기"}
                  {open && " · 열려 있음"}
                  {h.cwdMissing && <span className="session-missing"> · 폴더 없음</span>}
                </span>
              </button>
              <button
                type="button"
                className="archive-session-button"
                disabled={disabled}
                onClick={() => onArchive(h.path, title)}
                title="아카이브 (기록에서 숨깁니다. 파일은 그대로이고 아카이브에서 되돌릴 수 있습니다)"
                aria-label="세션 아카이브"
              >
                📦
              </button>
              <button
                type="button"
                className="delete-session-button"
                disabled={disabled}
                onClick={() => onDelete({ path: h.path, title, running: open })}
                title="세션 삭제 (대화 기록 파일을 휴지통으로 옮깁니다. 휴지통에서 되살릴 수 있습니다)"
                aria-label="세션 삭제"
              >
                🗑
              </button>
            </div>
          );
        })}
        {piMissing === false && (
          <div className="sidebar-bin-links">
            <button type="button" className="link-button" disabled={!connected} onClick={() => onOpenBin("archive")}>
              아카이브
            </button>
            <button type="button" className="link-button" disabled={!connected} onClick={() => onOpenBin("trash")}>
              휴지통
            </button>
          </div>
        )}
      </section>
    </aside>
  );
}
