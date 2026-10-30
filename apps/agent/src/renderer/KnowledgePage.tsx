import { useEffect, useMemo, useState } from "react";
import { MEMORY_TYPES, TYPE_LABEL, type BulkAction, type KnowledgeEntry, type KnowledgeStats, type MemoryType, type ReviewItem } from "@pi-desktop/agent-kit/memory-types";

type Tab = "list" | "review" | "stats";

const REVIEW_LABEL: Record<ReviewItem["kind"], string> = { duplicate: "중복 의심", stale: "안 쓰임", malformed: "형식", unverified: "확인 안 됨" };

/** 편집 중인 항목. id가 없으면 새 항목 */
interface Draft {
  id?: string;
  type: MemoryType;
  title: string;
  tags: string;
  content: string;
  pinned: boolean;
}

const emptyDraft = (): Draft => ({ type: "user", title: "", tags: "", content: "", pinned: false });
const toDraft = (e: KnowledgeEntry): Draft => ({ id: e.id, type: e.type, title: e.title, tags: e.tags.join(", "), content: e.content, pinned: e.pinned });
const when = (iso?: string) => (iso ? new Date(iso).toLocaleDateString() : "");

/**
 * 지식베이스 (설계 DESIGN-AGENT.md §4 "지식베이스", desktop-agent의 지식베이스 화면을 옮김).
 * 에이전트가 대화에서 남기거나 사람이 직접 쓴 항목을 찾고·고치고·정리한다. 항목 하나는 agent-kit 상태 폴더의 memory/<id>.md 파일이다.
 * - 목록: 찾기·종류·태그·보관함, 여러 개 골라 보관·고정·태그·지우기
 * - 점검 대기함: 중복 의심·오래 안 쓰임·형식 불일치·확인 안 됨을 이유와 함께 (합치기·확인함·보관)
 * - 통계·미리보기: 종류별 개수, 태그, 요청 하나에 프롬프트로 무엇이 실리는지
 */
export function KnowledgePage({ onError }: { onError: (message: string) => void }) {
  const [tab, setTab] = useState<Tab>("list");
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [review, setReview] = useState<ReviewItem[]>([]);
  const [stats, setStats] = useState<KnowledgeStats>();
  const [autoLearn, setAutoLearn] = useState<boolean>();
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<MemoryType | "">("");
  const [tagFilter, setTagFilter] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkTag, setBulkTag] = useState("");
  const [draft, setDraft] = useState<Draft>();
  const [previewPrompt, setPreviewPrompt] = useState("");
  const [preview, setPreview] = useState<{ text: string; chars: number; injected: number }>();

  const run = (action: () => Promise<unknown>) =>
    action().catch((error: unknown) => onError(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(error)));
  const refresh = async () => {
    const [list, items, numbers] = await Promise.all([window.piAgent.kbList(showArchived), window.piAgent.kbReview(), window.piAgent.kbStats()]);
    setEntries(list);
    setReview(items);
    setStats(numbers);
    setSelected((prev) => new Set([...prev].filter((id) => list.some((e) => e.id === id))));
  };

  useEffect(() => void run(async () => (await refresh(), setAutoLearn(await window.piAgent.getAutoLearn()))), []);
  useEffect(() => void run(refresh), [showArchived]);

  const shown = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return entries.filter((e) => {
      if (typeFilter && e.type !== typeFilter) return false;
      if (tagFilter && !e.tags.includes(tagFilter)) return false;
      const text = `${e.title} ${e.tags.join(" ")} ${e.content}`.toLowerCase();
      return terms.every((t) => text.includes(t));
    });
  }, [entries, query, typeFilter, tagFilter]);

  const save = () =>
    run(async () => {
      if (!draft) return;
      const saved = await window.piAgent.kbSave(draft.id, {
        type: draft.type,
        title: draft.title,
        content: draft.content,
        tags: draft.tags.split(",").map((t) => t.trim()).filter(Boolean),
        pinned: draft.pinned,
      });
      setDraft(toDraft(saved));
      await refresh();
    });

  const bulk = (action: BulkAction, ids = [...selected], tag?: string) =>
    run(async () => {
      if (action === "delete" && !confirm(`${ids.length}개를 지울까요? (memory/forgotten 폴더로 옮겨져 되돌릴 수 있습니다)`)) return;
      await window.piAgent.kbBulk(ids, action, tag);
      if (draft?.id && ids.includes(draft.id) && action === "delete") setDraft(undefined);
      await refresh();
    });

  const editing = draft?.id ? entries.find((e) => e.id === draft.id) : undefined;
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="page">
      <header className="page-head">
        <h2>지식베이스</h2>
        <span className="muted">고정 항목은 늘, 나머지는 목록(제목)과 요청에 관련된 것의 본문이 대화에 실립니다</span>
      </header>
      <div className="page-body">
        <label className="check-row" title="대화가 끝날 때마다 지금 모델을 한 번 더 불러 남길 것을 뽑습니다. 실패한 도구·거부한 승인은 교훈 후보가 됩니다">
          <input
            type="checkbox"
            checked={autoLearn ?? true}
            disabled={autoLearn === undefined}
            onChange={(e) => {
              const on = e.target.checked;
              run(async () => (await window.piAgent.setAutoLearn(on), setAutoLearn(on)));
            }}
          />
          <span>대화가 끝나면 자동으로 지식 남기기</span>
          <span className="muted small-text">(모델을 한 번 더 부릅니다. 남길 때마다 대화에 알림이 뜹니다)</span>
        </label>

        <div className="row kb-tabs" role="tablist">
          <button role="tab" aria-selected={tab === "list"} className={tab === "list" ? "primary small" : "small"} onClick={() => setTab("list")}>
            목록 {stats ? `(${stats.active})` : ""}
          </button>
          <button role="tab" aria-selected={tab === "review"} className={tab === "review" ? "primary small" : "small"} onClick={() => setTab("review")}>
            점검 대기함 {review.length > 0 ? `(${review.length})` : ""}
          </button>
          <button role="tab" aria-selected={tab === "stats"} className={tab === "stats" ? "primary small" : "small"} onClick={() => setTab("stats")}>
            통계·미리보기
          </button>
        </div>

        {tab === "list" && (
          <>
            <div className="form-row kb-filters">
              <input className="grow" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="제목·태그·본문에서 찾기" />
              <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as MemoryType | "")}>
                <option value="">모든 종류</option>
                {MEMORY_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABEL[t]}
                  </option>
                ))}
              </select>
              <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}>
                <option value="">모든 태그</option>
                {stats?.tags.map((t) => (
                  <option key={t.tag} value={t.tag}>
                    {t.tag} ({t.count})
                  </option>
                ))}
              </select>
              <label className="check-row small-text">
                <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
                보관함
              </label>
              <button className="small primary" onClick={() => setDraft(emptyDraft())}>
                + 새 항목
              </button>
              <button className="small" onClick={() => run(async () => window.piAgent.kbExport())} title="Markdown 한 파일로 내보내기">
                내보내기
              </button>
            </div>

            {selected.size > 0 && (
              <div className="row kb-bulk">
                <span className="small-text">{selected.size}개 고름</span>
                <button className="small" onClick={() => bulk("archive")}>
                  보관
                </button>
                <button className="small" onClick={() => bulk("activate")}>
                  되살리기
                </button>
                <button className="small" onClick={() => bulk("pin")}>
                  고정
                </button>
                <button className="small" onClick={() => bulk("unpin")}>
                  고정 풀기
                </button>
                <input className="kb-tag-input" value={bulkTag} onChange={(e) => setBulkTag(e.target.value)} placeholder="태그" />
                <button className="small" disabled={!bulkTag.trim()} onClick={() => bulk("addTag", undefined, bulkTag.trim())}>
                  태그 붙이기
                </button>
                <button className="small" disabled={!bulkTag.trim()} onClick={() => bulk("removeTag", undefined, bulkTag.trim())}>
                  태그 떼기
                </button>
                {selected.size >= 2 && (
                  <button
                    className="small"
                    title="처음 고른 항목에 나머지 본문·태그를 붙이고 나머지는 지웁니다"
                    onClick={() =>
                      run(async () => {
                        const ids = shown.filter((e) => selected.has(e.id)).map((e) => e.id);
                        await window.piAgent.kbMerge(ids[0]!, ids.slice(1));
                        setSelected(new Set());
                        await refresh();
                      })
                    }
                  >
                    합치기
                  </button>
                )}
                <button className="small danger" onClick={() => bulk("delete")}>
                  지우기
                </button>
                <button className="small link-button" onClick={() => setSelected(new Set())}>
                  고르기 풀기
                </button>
              </div>
            )}

            <div className="kb-layout">
              <ul className="list kb-list">
                {shown.length === 0 && <li className="muted">{entries.length === 0 ? "아직 지식이 없습니다. 대화에서 \"기억해\"라고 하거나 + 새 항목으로 남기세요." : "맞는 항목이 없습니다."}</li>}
                {shown.map((e) => (
                  <li key={e.id} className={`kb-item${draft?.id === e.id ? " active" : ""}${e.status === "archived" ? " archived" : ""}`}>
                    <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggle(e.id)} aria-label={`${e.title} 고르기`} />
                    <button className="kb-row" onClick={() => setDraft(toDraft(e))}>
                      <span className="kb-row-head">
                        <span className={`tag kb-type ${e.type}`}>{TYPE_LABEL[e.type]}</span>
                        {e.pinned && <span title="고정: 늘 실립니다">📌</span>}
                        <strong className="kb-title">{e.title}</strong>
                        {e.unverified && (
                          <span className="badge warn" title="도구로 확인하지 않은 대화에서 나왔습니다">
                            확인 안 됨
                          </span>
                        )}
                        {e.status === "archived" && <span className="badge">보관</span>}
                      </span>
                      <span className="kb-row-meta muted small-text">
                        {[e.tags.map((t) => `#${t}`).join(" "), e.origin === "user" ? "직접" : "자동", when(e.updated), e.recallCount ? `${e.recallCount}회 쓰임` : ""]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>

              {draft && (
                <section className="card kb-editor">
                  <h3>{draft.id ? "항목 고치기" : "새 항목"}</h3>
                  <div className="form-row">
                    <select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as MemoryType })}>
                      {MEMORY_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {TYPE_LABEL[t]}
                        </option>
                      ))}
                    </select>
                    <input className="grow" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="제목 (한 줄 요약)" />
                  </div>
                  <div className="form-row">
                    <input className="grow" value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} placeholder="태그 (쉼표로 나눔, 예: 배포, gradle, 공유제외)" />
                    <label className="check-row small-text" title="요청과 상관없이 늘 본문까지 실립니다">
                      <input type="checkbox" checked={draft.pinned} onChange={(e) => setDraft({ ...draft, pinned: e.target.checked })} />
                      고정
                    </label>
                  </div>
                  <textarea
                    className="kb-content"
                    value={draft.content}
                    onChange={(e) => setDraft({ ...draft, content: e.target.value })}
                    placeholder={draft.type === "lesson" ? "**상황:** ...\n\n**실수:** ...\n\n**원인:** ...\n\n**재발 방지:** ..." : "본문 (Markdown)"}
                  />
                  {editing && (
                    <p className="muted small-text">
                      만든 때 {when(editing.created)} · 고친 때 {when(editing.updated)} · {editing.origin === "user" ? "직접 씀" : "에이전트가 남김"}
                      {editing.recallCount ? ` · ${editing.recallCount}회 쓰임(마지막 ${when(editing.lastRecalledAt)})` : " · 아직 쓰이지 않음"}
                      {editing.source ? ` · 출처 ${editing.source}` : ""}
                    </p>
                  )}
                  <div className="row">
                    <button className="small primary" disabled={!draft.title.trim() || !draft.content.trim()} onClick={save}>
                      저장
                    </button>
                    {editing?.unverified && (
                      <button className="small" onClick={() => run(async () => (await window.piAgent.kbReviewed(editing.id), await refresh()))}>
                        확인함
                      </button>
                    )}
                    {editing && (
                      <button className="small" onClick={() => bulk(editing.status === "archived" ? "activate" : "archive", [editing.id])}>
                        {editing.status === "archived" ? "되살리기" : "보관"}
                      </button>
                    )}
                    {editing && (
                      <button className="small danger" onClick={() => bulk("delete", [editing.id])}>
                        지우기
                      </button>
                    )}
                    <button className="small link-button" onClick={() => setDraft(undefined)}>
                      닫기
                    </button>
                  </div>
                </section>
              )}
            </div>
          </>
        )}

        {tab === "review" && (
          <>
            <p className="muted small-text">자동으로 쌓인 지식에 틀린 것이 섞이지 않도록, 사람이 한 번 볼 것만 이유와 함께 모았습니다. 확인함을 누르면 다시 올라오지 않습니다.</p>
            {review.length === 0 ? (
              <p className="muted">점검할 것이 없습니다.</p>
            ) : (
              <ul className="list">
                {review.map((item) => (
                  <li key={`${item.kind}-${item.id}`} className="kb-review">
                    <span className={`badge ${item.kind === "unverified" || item.kind === "malformed" ? "warn" : ""}`}>{REVIEW_LABEL[item.kind]}</span>
                    <div className="grow">
                      <strong>
                        [{TYPE_LABEL[item.type]}] {item.title}
                      </strong>
                      {item.pairTitle && <span className="muted small-text"> ↔ {item.pairTitle}</span>}
                      <div className="muted small-text">{item.reason}</div>
                    </div>
                    <button
                      className="small"
                      onClick={() => {
                        const target = entries.find((e) => e.id === item.id);
                        if (target) {
                          setDraft(toDraft(target));
                          setTab("list");
                        }
                      }}
                    >
                      열기
                    </button>
                    {item.kind === "duplicate" && item.pairId && (
                      <button className="small" title="이 항목에 짝의 본문·태그를 붙이고 짝은 지웁니다" onClick={() => run(async () => (await window.piAgent.kbMerge(item.id, [item.pairId!]), await refresh()))}>
                        합치기
                      </button>
                    )}
                    <button className="small" onClick={() => run(async () => (await window.piAgent.kbReviewed(item.id), await refresh()))}>
                      확인함
                    </button>
                    <button className="small" onClick={() => bulk("archive", [item.id])}>
                      보관
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {tab === "stats" && stats && (
          <>
            <div className="usage-tiles">
              {MEMORY_TYPES.map((t) => (
                <div key={t} className="usage-tile">
                  <div className="muted small-text">{TYPE_LABEL[t]}</div>
                  <strong>{stats.byType[t]}</strong>
                </div>
              ))}
              <div className="usage-tile">
                <div className="muted small-text">고정</div>
                <strong>{stats.pinned}</strong>
              </div>
              <div className="usage-tile">
                <div className="muted small-text">확인 안 됨</div>
                <strong>{stats.unverified}</strong>
              </div>
              <div className="usage-tile">
                <div className="muted small-text">보관</div>
                <strong>{stats.archived}</strong>
              </div>
            </div>
            {stats.tags.length > 0 && (
              <p className="small-text">
                태그:{" "}
                {stats.tags.slice(0, 30).map((t) => (
                  <button
                    key={t.tag}
                    className="link-button small-text kb-tag-link"
                    onClick={() => {
                      setTagFilter(t.tag);
                      setTab("list");
                    }}
                  >
                    #{t.tag}({t.count})
                  </button>
                ))}
              </p>
            )}
            <section className="card">
              <h3>주입 미리보기</h3>
              <p className="muted small-text">요청을 적으면 그 요청에 지식베이스에서 무엇이 실리는지 보여 줍니다 (클라우드 모델 기준 8,000자 예산, 쓰임 횟수는 늘지 않음).</p>
              <div className="form-row">
                <input className="grow" value={previewPrompt} onChange={(e) => setPreviewPrompt(e.target.value)} placeholder="예: 배포 스크립트 고쳐 줘" />
                <button className="small" onClick={() => run(async () => setPreview(await window.piAgent.kbPreview(previewPrompt)))}>
                  미리보기
                </button>
              </div>
              {preview && (
                <>
                  <p className="small-text">
                    {preview.chars.toLocaleString()}자 (약 {Math.round(preview.chars / 2).toLocaleString()}토큰) · 본문까지 실린 항목 {preview.injected}개
                  </p>
                  <pre className="kb-preview">{preview.text || "(실릴 것이 없습니다)"}</pre>
                </>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
