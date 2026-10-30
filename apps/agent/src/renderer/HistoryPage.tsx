import { useEffect, useMemo, useState } from "react";
import type { TrashItem } from "@pi-desktop/host-protocol/messages";
import type { HistoryHit, StoredChat } from "../shared/api";
import { folderName } from "./recent-folders";

export type HistoryView = "history" | "archive" | "trash";
type View = HistoryView;

const VIEWS: Array<{ id: View; label: string }> = [
  { id: "history", label: "지난 대화" },
  { id: "archive", label: "아카이브" },
  { id: "trash", label: "휴지통" },
];

const when = (ms: number) => new Date(ms).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
const titleOf = (c: { name?: string; firstMessage: string }) => c.name?.trim() || c.firstMessage || "빈 대화";

/**
 * 지난 대화 (설계 DESIGN-AGENT.md §4 "지난 대화", DESIGN-APPS.md §3.2). 이 앱의 세션 폴더(~/.pi-desktop-agent/sessions)에
 * 남은 대화를 최근 순으로 보이고, 이름·첫 메시지는 바로 거르고 본문은 Enter로 찾는다. 누르면 그 세션 파일을 이어서 연다.
 * - 📦 아카이브: 파일은 그대로 두고 목록에서만 숨긴다. "아카이브"에서 되돌린다
 * - 🗑 삭제: 휴지통으로 옮긴다. "휴지통"에서 되살리거나 정말 지운다
 */
export function HistoryPage({
  initialView = "history",
  openFiles,
  onOpen,
  onError,
}: {
  /** 처음 보일 보기 (왼쪽 목록의 지난 대화·아카이브·휴지통) */
  initialView?: View;
  /** 지금 열려 있는 대화의 세션 파일 (열림 표시) */
  openFiles: Set<string>;
  onOpen: (chat: StoredChat) => void;
  onError: (message: string) => void;
}) {
  const [view, setView] = useState<View>(initialView);
  const [chats, setChats] = useState<StoredChat[]>();
  const [trash, setTrash] = useState<TrashItem[]>();
  const [query, setQuery] = useState("");
  /** 본문 검색 결과 (path → 앞뒤 글). 없으면 이름·첫 메시지로만 거른다 */
  const [hits, setHits] = useState<Map<string, string>>();
  const [searching, setSearching] = useState(false);
  const [notice, setNotice] = useState<string>();

  const fail = (error: unknown) => onError(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(error));
  const load = () => Promise.all([window.piAgent.listHistory().then(setChats), window.piAgent.listTrash().then(setTrash)]).catch(fail);
  const act = (action: () => Promise<string | undefined>) =>
    action()
      .then(async (message) => {
        setNotice(message);
        await load();
      })
      .catch(fail);

  useEffect(() => void load(), []);

  // 검색어를 바꾸면 본문 검색 결과는 버린다 (다시 Enter)
  useEffect(() => setHits(undefined), [query]);

  const searchBody = () => {
    if (!query.trim()) return;
    setSearching(true);
    window.piAgent
      .searchHistory(query)
      .then((found) => setHits(new Map(found.map((h: HistoryHit) => [h.path, h.snippet]))), fail)
      .finally(() => setSearching(false));
  };

  const shown = useMemo(() => {
    if (!chats) return [];
    const inView = chats.filter((c) => (view === "archive" ? c.archived : !c.archived));
    if (hits && view === "history") return inView.filter((c) => hits.has(c.path));
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return inView;
    return inView.filter((c) => {
      const text = `${c.name ?? ""} ${c.firstMessage} ${c.cwd}`.toLowerCase();
      return terms.every((t) => text.includes(t));
    });
  }, [chats, query, hits, view]);

  const archivedCount = chats?.filter((c) => c.archived).length ?? 0;

  const chatRow = (c: StoredChat) => {
    const open = openFiles.has(c.path);
    return (
      <li key={c.path} className="history-row">
        <button className="history-item" title={`${c.path}\n메시지 ${c.messageCount}개`} onClick={() => onOpen(c)}>
          <span className="history-title">
            <strong className={c.name ? "" : "muted"}>{titleOf(c)}</strong>
            {open && <span className="badge">열림</span>}
          </span>
          {hits?.get(c.path) ? (
            <span className="small-text history-snippet">{hits.get(c.path)}</span>
          ) : (
            c.name && c.firstMessage && <span className="muted small-text history-snippet">{c.firstMessage}</span>
          )}
          <span className="muted small-text">
            📁 {folderName(c.cwd)} · {when(c.modified)} · 메시지 {c.messageCount}
          </span>
        </button>
        <div className="history-actions">
          {c.archived ? (
            <button
              className="small"
              title="지난 대화 목록으로 되돌립니다"
              onClick={() =>
                act(async () => {
                  await window.piAgent.setArchived(c.path, false);
                  return `"${titleOf(c)}"을(를) 지난 대화로 되돌렸습니다.`;
                })
              }
            >
              되돌리기
            </button>
          ) : (
            <button
              className="small"
              title="아카이브 (목록에서 숨깁니다. 파일은 그대로이고 아카이브에서 되돌릴 수 있습니다)"
              onClick={() =>
                act(async () => {
                  await window.piAgent.setArchived(c.path, true);
                  return `"${titleOf(c)}"을(를) 아카이브했습니다.`;
                })
              }
            >
              📦
            </button>
          )}
          <button
            className="small"
            disabled={open}
            title={open ? "열려 있는 대화는 닫은 뒤 지울 수 있습니다" : "휴지통으로 옮깁니다 (휴지통에서 되살릴 수 있습니다)"}
            onClick={() =>
              act(async () => {
                if (!confirm(`"${titleOf(c)}" 대화를 지울까요? 휴지통으로 옮겨져 되살릴 수 있습니다.`)) return undefined;
                await window.piAgent.deleteChat(c.path);
                return `"${titleOf(c)}"을(를) 휴지통으로 옮겼습니다.`;
              })
            }
          >
            🗑
          </button>
        </div>
      </li>
    );
  };

  const trashRow = (t: TrashItem) => (
    <li key={t.id} className="history-row">
      <div className="history-item static" title={`원래 자리: ${t.originalPath}`}>
        <span className="history-title">
          <strong className={t.name ? "" : "muted"}>{titleOf(t)}</strong>
        </span>
        <span className="muted small-text">
          📁 {folderName(t.cwd)} · {when(t.deletedAt)} 삭제
        </span>
      </div>
      <div className="history-actions">
        <button
          className="small primary"
          onClick={() =>
            act(async () => {
              await window.piAgent.restoreTrash(t.id);
              return `"${titleOf(t)}"을(를) 되살렸습니다.`;
            })
          }
        >
          되살리기
        </button>
        <button
          className="small danger"
          onClick={() =>
            act(async () => {
              if (!confirm(`"${titleOf(t)}"을(를) 정말 지울까요? 되돌릴 수 없습니다.`)) return undefined;
              await window.piAgent.emptyTrash([t.id]);
              return `"${titleOf(t)}"을(를) 정말 지웠습니다.`;
            })
          }
        >
          영구 삭제
        </button>
      </div>
    </li>
  );

  return (
    <div className="page">
      <header className="page-head">
        <h2>지난 대화</h2>
        <span className="muted">이 앱에서 나눈 대화. 누르면 이어서 엽니다</span>
      </header>
      <div className="page-body">
        <div className="row" role="tablist">
          {VIEWS.map((v) => (
            <button key={v.id} role="tab" aria-selected={view === v.id} className={view === v.id ? "primary small" : "small"} onClick={() => setView(v.id)}>
              {v.label}
              {v.id === "archive" && archivedCount > 0 ? ` ${archivedCount}` : ""}
              {v.id === "trash" && trash && trash.length > 0 ? ` ${trash.length}` : ""}
            </button>
          ))}
        </div>
        {notice && <p className="muted small-text">{notice}</p>}

        {view !== "trash" && (
          <div className="form-row">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing && view === "history") searchBody();
              }}
              placeholder={view === "history" ? "이름·첫 메시지·폴더로 거르기, Enter를 누르면 대화 내용까지 찾기" : "이름·첫 메시지·폴더로 거르기"}
            />
            {view === "history" && (
              <button disabled={!query.trim() || searching} onClick={searchBody}>
                {searching ? "찾는 중…" : "내용까지 찾기"}
              </button>
            )}
          </div>
        )}
        {view === "history" && hits && <p className="muted small-text">대화 내용에서 {hits.size}개를 찾았습니다.</p>}

        {view === "trash" ? (
          !trash ? (
            <p className="muted">읽는 중…</p>
          ) : trash.length === 0 ? (
            <p className="muted">휴지통이 비어 있습니다.</p>
          ) : (
            <>
              <p className="muted small-text">
                지운 대화입니다. 되살리면 원래 자리로 돌아갑니다.{" "}
                <button
                  className="small danger"
                  onClick={() =>
                    act(async () => {
                      if (!confirm(`휴지통의 ${trash.length}개를 정말 지울까요? 되돌릴 수 없습니다.`)) return undefined;
                      const removed = await window.piAgent.emptyTrash();
                      return `${removed}개를 정말 지웠습니다.`;
                    })
                  }
                >
                  휴지통 비우기
                </button>
              </p>
              <ul className="list history-list">{trash.map(trashRow)}</ul>
            </>
          )
        ) : !chats ? (
          <p className="muted">읽는 중…</p>
        ) : shown.length === 0 ? (
          <p className="muted">
            {view === "archive"
              ? "아카이브한 대화가 없습니다. 지난 대화의 📦로 숨길 수 있습니다."
              : chats.length === 0
                ? "남은 대화가 없습니다."
                : "맞는 대화가 없습니다. Enter로 내용까지 찾아 보세요."}
          </p>
        ) : (
          <ul className="list history-list">{shown.map(chatRow)}</ul>
        )}
      </div>
    </div>
  );
}
