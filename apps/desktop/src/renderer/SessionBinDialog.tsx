import { useCallback, useEffect, useState } from "react";
import type { StoredSession, TrashItem } from "@pi-desktop/host-protocol/messages";
import { baseName, formatRelative } from "./format";
import { archivedHistory, sessionTitle, trashMeta, type BinTab } from "./session-bin";

interface Props {
  hostId: string;
  initialTab: BinTab;
  onClose: () => void;
  /** 되돌리기·되살리기로 사이드바 기록이 바뀌었다 */
  onChanged: () => void;
  /** 아카이브한 세션을 연다 (아카이브는 그대로) */
  onOpenStored: (stored: StoredSession) => void;
}

/**
 * 아카이브·휴지통 (설계 DESIGN-APPS.md §3.2). 이 호스트의 데몬 홈(~/.pi-desktop)에 있는 것만 다룬다.
 * - 아카이브: 사이드바에서 숨긴 세션. 되돌리거나 연다. 터미널 pi의 /resume에는 계속 보인다
 * - 휴지통: 지운 세션. 원래 자리로 되살리거나, 고른 것·전부를 정말 지운다
 */
export function SessionBinDialog({ hostId, initialTab, onClose, onChanged, onOpenStored }: Props) {
  const [tab, setTab] = useState<BinTab>(initialTab);
  const [archived, setArchived] = useState<StoredSession[]>();
  const [trash, setTrash] = useState<TrashItem[]>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [confirmEmpty, setConfirmEmpty] = useState(false);

  const load = useCallback(async () => {
    try {
      const [history, items] = await Promise.all([window.piDesktop.listHistory(hostId), window.piDesktop.listTrash(hostId)]);
      setArchived(archivedHistory(history));
      setTrash(items);
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [hostId]);

  useEffect(() => void load(), [load]);

  const run = async (action: () => Promise<string | undefined>) => {
    try {
      const message = await action();
      setNotice(message);
      setError(undefined);
      onChanged();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e));
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className="modal session-bin" role="dialog" aria-modal="true" aria-labelledby="bin-title">
        <div className="session-bin-head">
          <h2 id="bin-title" className="modal-title">
            {tab === "archive" ? "아카이브" : "휴지통"}
          </h2>
          <div className="segmented" role="tablist">
            <button type="button" className={tab === "archive" ? "on" : ""} onClick={() => setTab("archive")}>
              아카이브 {archived ? archived.length : ""}
            </button>
            <button type="button" className={tab === "trash" ? "on" : ""} onClick={() => setTab("trash")}>
              휴지통 {trash ? trash.length : ""}
            </button>
          </div>
        </div>
        <p className="modal-message muted">
          {tab === "archive"
            ? "사이드바에서 숨긴 세션입니다. 파일은 그대로라 터미널 pi의 /resume에는 계속 보입니다."
            : "지운 세션입니다. 되살리면 원래 자리로 돌아갑니다. 비우면 정말 지웁니다."}
        </p>
        {error && <p className="sidebar-error">{error}</p>}
        {notice && <p className="session-bin-notice">{notice}</p>}

        <div className="session-bin-list">
          {tab === "archive" &&
            (!archived ? (
              <p className="sidebar-empty">읽는 중…</p>
            ) : archived.length === 0 ? (
              <p className="sidebar-empty">아카이브한 세션이 없습니다. 기록의 📦로 숨길 수 있습니다.</p>
            ) : (
              archived.map((h) => (
                <div key={h.path} className="session-bin-row">
                  <div className="session-bin-text" title={h.path}>
                    <span className="session-name">{sessionTitle(h)}</span>
                    <span className="session-meta-line">
                      {formatRelative(h.modified)} · 메시지 {h.messageCount} · {baseName(h.cwd)}
                    </span>
                  </div>
                  <button type="button" onClick={() => onOpenStored(h)}>
                    열기
                  </button>
                  <button
                    type="button"
                    className="primary"
                    onClick={() =>
                      void run(async () => {
                        await window.piDesktop.setArchived(hostId, h.path, false);
                        return `"${sessionTitle(h)}"을(를) 기록으로 되돌렸습니다.`;
                      })
                    }
                  >
                    되돌리기
                  </button>
                </div>
              ))
            ))}

          {tab === "trash" &&
            (!trash ? (
              <p className="sidebar-empty">읽는 중…</p>
            ) : trash.length === 0 ? (
              <p className="sidebar-empty">휴지통이 비어 있습니다.</p>
            ) : (
              trash.map((t) => (
                <div key={t.id} className="session-bin-row">
                  <div className="session-bin-text" title={`원래 자리: ${t.originalPath}`}>
                    <span className="session-name">{sessionTitle(t)}</span>
                    <span className="session-meta-line">{trashMeta(t, formatRelative)}</span>
                  </div>
                  <button
                    type="button"
                    className="primary"
                    onClick={() =>
                      void run(async () => {
                        const path = await window.piDesktop.restoreTrash(hostId, t.id);
                        return `"${sessionTitle(t)}"을(를) 되살렸습니다: ${path}`;
                      })
                    }
                  >
                    되살리기
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() =>
                      void run(async () => {
                        if (!confirm(`"${sessionTitle(t)}"을(를) 정말 지울까요? 되돌릴 수 없습니다.`)) return undefined;
                        await window.piDesktop.emptyTrash(hostId, [t.id]);
                        return `"${sessionTitle(t)}"을(를) 정말 지웠습니다.`;
                      })
                    }
                  >
                    영구 삭제
                  </button>
                </div>
              ))
            ))}
        </div>

        <div className="modal-actions">
          {tab === "trash" && trash && trash.length > 0 && !confirmEmpty && (
            <button type="button" className="danger" onClick={() => setConfirmEmpty(true)}>
              휴지통 비우기
            </button>
          )}
          {confirmEmpty && (
            <>
              <span className="muted">{trash?.length ?? 0}개를 정말 지울까요? 되돌릴 수 없습니다.</span>
              <button
                type="button"
                className="danger"
                onClick={() =>
                  void run(async () => {
                    setConfirmEmpty(false);
                    const removed = await window.piDesktop.emptyTrash(hostId);
                    return `${removed}개를 정말 지웠습니다.`;
                  })
                }
              >
                비우기
              </button>
              <button type="button" onClick={() => setConfirmEmpty(false)}>
                그만두기
              </button>
            </>
          )}
          <button type="button" onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
