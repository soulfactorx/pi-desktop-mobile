import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { TOPIC_LABELS, type InsightTopic } from "@pi-desktop/mate-runner/activity-types";
import type { InboxView, Overview } from "../shared/api";
import type { Act } from "./App";
import { relativeTime, splitInbox } from "./mate-view";

const SEVERITY_LABELS: Record<InboxView["severity"], string> = { info: "참고", warn: "확인 필요", action: "할 일" };
const STATUS_TEXT: Record<NonNullable<InboxView["status"]>, string> = { accepted: "확인함", dismissed: "버림", applied: "적용함" };

/**
 * 인박스: 실행기가 돌며 남긴 제안·결과 (설계 DESIGN-MATE.md §5).
 * 앱이 꺼져 있던 동안 쌓인 것도 여기서 본다. 제안의 "확인함"은 표시만 하고,
 * 고치기(act) 변경은 "적용"을 눌러야 내 작업 폴더에 들어온다 (승인 대기).
 */
export function InboxPanel({ overview, now, act }: { overview: Overview; now: number; act: Act }) {
  const [showHandled, setShowHandled] = useState(false);
  const { fresh, handled } = splitInbox(overview.inbox);
  const list = showHandled ? handled : fresh;

  return (
    <section>
      <div className="section-head">
        <div className="segmented">
          <button className={!showHandled ? "active" : ""} onClick={() => setShowHandled(false)}>
            새 제안 {fresh.length}
          </button>
          <button className={showHandled ? "active" : ""} onClick={() => setShowHandled(true)}>
            처리함 {handled.length}
          </button>
        </div>
        {/* 고친 변경(act)은 적용·버리기를 하나씩 정해야 하므로 "모두 확인함"에서 뺀다 */}
        {!showHandled && fresh.filter((i) => !i.change && !i.install).length > 1 && (
          <button onClick={() => void act(() => window.mate.setInbox(fresh.filter((i) => !i.change && !i.install).map((i) => i.id), "accepted"))}>
            모두 확인함
          </button>
        )}
      </div>
      {list.length === 0 && (
        <div className="empty">
          {showHandled
            ? "처리한 제안이 없습니다."
            : overview.duties.length === 0
              ? "아직 임무가 없습니다. 임무 탭에서 만들면, Mate가 정한 때에 살펴보고 여기에 알려 줍니다."
              : "새 제안이 없습니다. 임무가 돌면서 알릴 것이 생기면 여기에 쌓입니다."}
        </div>
      )}
      <ul className="cards">
        {list.map((item) => (
          <InboxCard key={item.id} item={item} now={now} act={act} />
        ))}
      </ul>
    </section>
  );
}

export function InboxCard({ item, now, act }: { item: InboxView; now: number; act: Act }) {
  const [open, setOpen] = useState(false);
  /** 설치 제안이면 적용하기 전에 무엇이 들어가는지 보인다 (스킬 내용, 서버 명령, 복사할 원본) */
  const [preview, setPreview] = useState<string>();
  useEffect(() => {
    if (item.install && !item.status) void window.mate.describeInstall(item.id).then(setPreview, (e: Error) => setPreview(`내용을 읽지 못했습니다: ${e.message}`));
  }, [item.id, item.install, item.status]);
  return (
    <li className={`card inbox-card sev-${item.severity}`}>
      <div className="card-head">
        <span className={`chip sev-${item.severity}`}>{SEVERITY_LABELS[item.severity]}</span>
        {item.topic && <span className="chip">{TOPIC_LABELS[item.topic as InsightTopic] ?? item.topic}</span>}
        <strong className="title">{item.title}</strong>
        <span className="muted">
          {item.dutyName} · {relativeTime(item.createdAt, now)}
        </span>
      </div>
      <div className="summary markdown">
        <Markdown remarkPlugins={[remarkGfm]}>{item.summary}</Markdown>
      </div>
      {item.detail && (
        <>
          <button className="link" onClick={() => setOpen(!open)}>
            {open ? "근거 접기" : "근거 보기"}
          </button>
          {open && (
            <div className="detail markdown">
              <Markdown remarkPlugins={[remarkGfm]}>{item.detail}</Markdown>
            </div>
          )}
        </>
      )}
      {preview && (
        <div className="detail markdown">
          <Markdown remarkPlugins={[remarkGfm]}>{preview}</Markdown>
        </div>
      )}
      {item.change && (
        <div className="muted small-text path" title={item.change.files.join("\n")}>
          {item.change.repo} · {item.change.files.slice(0, 5).join(", ")}
          {item.change.files.length > 5 ? ` 외 ${item.change.files.length - 5}개` : ""}
        </div>
      )}
      <div className="card-actions">
        {item.status ? (
          <>
            <span className="muted">{STATUS_TEXT[item.status]}</span>
            {/* 고친 변경은 적용하거나 버리면 작업 공간이 지워져 되돌릴 수 없다 */}
            {!item.change && item.status !== "applied" && (
              <button className="small" onClick={() => void act(() => window.mate.setInbox([item.id], undefined))}>
                새 제안으로 되돌리기
              </button>
            )}
          </>
        ) : item.install ? (
          <>
            <button className="primary small" onClick={() => void act(() => window.mate.applyInstall(item.id))}>
              적용
            </button>
            <button className="small" onClick={() => void act(() => window.mate.setInbox([item.id], "dismissed"))}>
              버리기
            </button>
            <span className="muted small-text">적용하면 Mate 홈에 넣고 이 임무가 쓰게 합니다. 같은 이름이 있으면 덮어쓰지 않습니다</span>
          </>
        ) : item.change ? (
          <>
            <button
              className="primary small"
              onClick={() => {
                if (confirm(`${item.change!.repo}에 이 변경을 적용할까요?\n커밋하지 않은 변경으로 들어가며, 커밋은 직접 합니다.`)) {
                  void act(() => window.mate.applyChange(item.id));
                }
              }}
            >
              적용
            </button>
            <button className="small" onClick={() => void act(() => window.mate.discardChange(item.id))}>
              버리기
            </button>
            <span className="muted small-text">적용 전까지 내 작업 폴더는 그대로입니다</span>
          </>
        ) : (
          <>
            {item.followUp && (
              <button
                className="primary small"
                title={item.followUp.prompt}
                onClick={() => void act(() => window.mate.delegate(item.id))}
              >
                Mate에게 맡기기
              </button>
            )}
            <button className={`${item.followUp ? "" : "primary "}small`} onClick={() => void act(() => window.mate.setInbox([item.id], "accepted"))}>
              확인함
            </button>
            <button className="small" onClick={() => void act(() => window.mate.setInbox([item.id], "dismissed"))}>
              버리기
            </button>
            {item.followUp && <span className="muted small-text">맡기면 별도 작업 공간에서 고치고, 적용은 다시 묻습니다</span>}
            {item.topic && !item.followUp && <span className="muted small-text">버린 주제는 Mate가 덜 알립니다</span>}
          </>
        )}
      </div>
    </li>
  );
}
