import type { MateTrashItem, Overview } from "../shared/api";
import type { Act } from "./App";
import { relativeTime } from "./mate-view";

const KIND_LABELS: Record<MateTrashItem["kind"], string> = { duty: "임무", run: "실행 기록", chat: "대화", skill: "스킬" };

/**
 * 휴지통 (설계 DESIGN-APPS.md §3.2). 지운 임무·실행 기록·대화와, 200개 넘어 정리한 실행 기록이 있다.
 * 되살리면 원래 자리로 돌아가고(대화는 그사이 대화와 시각 순으로 합침), 비우면 정말 지운다.
 */
export function TrashView({ overview, now, act }: { overview: Overview; now: number; act: Act }) {
  const { trash } = overview;
  return (
    <section>
      <div className="section-head">
        <span className="muted">지운 것은 여기 있다가, 되살리면 원래 자리로 돌아갑니다. 비우면 정말 지웁니다.</span>
        {trash.length > 0 && (
          <button
            className="small danger right"
            onClick={() => {
              if (confirm(`휴지통의 ${trash.length}개를 정말 지울까요? 되돌릴 수 없습니다.`)) void act(() => window.mate.emptyTrash());
            }}
          >
            휴지통 비우기
          </button>
        )}
      </div>
      {trash.length === 0 && <div className="empty">휴지통이 비어 있습니다.</div>}
      <ul className="cards">
        {trash.map((item) => (
          <li key={item.id} className="card">
            <div className="card-head">
              <span className="chip">{KIND_LABELS[item.kind]}</span>
              <strong className="title">{item.title}</strong>
              <span className="muted">
                {relativeTime(item.deletedAt, now)} 삭제{item.detail ? ` · ${item.detail}` : ""} · 파일 {item.files}개
              </span>
              <span className="right">
                <button className="small primary" onClick={() => void act(() => window.mate.restoreTrash(item.id))}>
                  되살리기
                </button>{" "}
                <button
                  className="small danger"
                  onClick={() => {
                    if (confirm(`"${item.title}"을(를) 정말 지울까요? 되돌릴 수 없습니다.`)) void act(() => window.mate.emptyTrash([item.id]));
                  }}
                >
                  영구 삭제
                </button>
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
