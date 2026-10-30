import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Overview, RunRecord, TranscriptItem } from "../shared/api";
import type { Act } from "./App";
import { costLabel, durationLabel, PROFILE_LABELS, REASON_LABELS, relativeTime, STATUS_LABELS } from "./mate-view";

/** 최근 실행 기록 (새것부터) */
export function RunsView({ overview, now, act }: { overview: Overview; now: number; act: Act }) {
  const { runs, runner } = overview;
  const [viewing, setViewing] = useState<RunRecord>();
  const todayCost = costLabel(runner.today.costUsd);
  return (
    <section>
      <div className="section-head">
        <span className="muted">
          오늘 자동 실행 {runner.today.count}회 / 하루 상한 {overview.config.dailyRunLimit}회
          {todayCost && ` · 오늘 비용 ${todayCost}`} · "지금 실행"은 상한에 세지 않습니다
        </span>
      </div>
      {runs.length === 0 && <div className="empty">아직 실행 기록이 없습니다.</div>}
      <ul className="cards">
        {runs.map((run) => (
          <RunRow
            key={run.id}
            run={run}
            now={now}
            onView={() => setViewing(run)}
            onDelete={() => void act(() => window.mate.deleteRun(run.id))}
          />
        ))}
      </ul>
      {viewing && <SessionPanel run={viewing} onClose={() => setViewing(undefined)} />}
    </section>
  );
}

function RunRow({ run, now, onView, onDelete }: { run: RunRecord; now: number; onView: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const text = run.error ?? run.summary;
  return (
    <li className={`card run-row status-${run.status}`}>
      <div className="card-head">
        <span className={`chip status-${run.status}`}>{STATUS_LABELS[run.status]}</span>
        <strong className="title">{run.dutyName}</strong>
        <span className="muted">
          {relativeTime(run.startedAt, now)} · {REASON_LABELS[run.reason]} · {PROFILE_LABELS[run.profile].name}
        </span>
        <span className="muted right">
          {[durationLabel(run), costLabel(run.costUsd), run.proposals ? `제안 ${run.proposals}건` : "", run.model].filter(Boolean).join(" · ")}
        </span>
        {run.sessionId && run.status !== "running" && (
          <button className="small" onClick={onView}>
            세션 보기
          </button>
        )}
        {run.status !== "running" && (
          <button className="small" title="세션 파일과 함께 휴지통으로 옮깁니다 (휴지통 탭에서 되살릴 수 있음)" onClick={onDelete}>
            🗑
          </button>
        )}
      </div>
      {run.cause && <div className="muted small-text">계기: {run.cause}</div>}
      {text && (
        <div className={`run-text${open ? " open" : ""}${run.error ? " bad-text" : ""}`} onClick={() => setOpen(!open)}>
          {text}
        </div>
      )}
    </li>
  );
}

/** 실행 세션을 읽기 전용으로 보여 준다 (무엇을 읽고 어떤 명령을 돌렸는지 확인용) */
function SessionPanel({ run, onClose }: { run: RunRecord; onClose: () => void }) {
  const [items, setItems] = useState<TranscriptItem[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    window.mate.readSession(run.id).then(setItems, (e: Error) => setError(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")));
  }, [run.id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="overlay" onClick={onClose}>
      <aside className="session-panel" onClick={(e) => e.stopPropagation()}>
        <div className="section-head">
          <strong>
            {run.dutyName} · {new Date(run.startedAt).toLocaleString()}
          </strong>
          <button className="small" onClick={onClose}>
            닫기
          </button>
        </div>
        {error && <div className="bad-text">{error}</div>}
        {!items && !error && <div className="muted">불러오는 중…</div>}
        <ol className="transcript">
          {items?.map((item, i) => (
            <TranscriptRow key={i} item={item} />
          ))}
        </ol>
      </aside>
    </div>
  );
}

function TranscriptRow({ item }: { item: TranscriptItem }) {
  switch (item.kind) {
    case "user":
      return (
        <li className="t-user">
          <div className="t-label">지시</div>
          <div className="pre">{item.text}</div>
        </li>
      );
    case "assistant":
      return (
        <li className="t-assistant">
          <div className="t-label">Pi</div>
          <div className="markdown">
            <Markdown remarkPlugins={[remarkGfm]}>{item.text}</Markdown>
          </div>
        </li>
      );
    case "tool":
      return (
        <li className={`t-tool${item.isError ? " t-error" : ""}`}>
          <details>
            <summary>
              <code>{item.name}</code> {toolSummary(item.args)}
              {item.isError && <span className="chip bad">막힘·오류</span>}
            </summary>
            {item.args && <pre>{item.args}</pre>}
            {item.result !== undefined && <pre className="t-result">{item.result || "(출력 없음)"}</pre>}
          </details>
        </li>
      );
    case "note":
      return <li className="t-note muted small-text">{item.text}</li>;
  }
}

/** 도구 인자에서 한 줄 요약 (bash면 명령, read면 경로) */
function toolSummary(args: string): string {
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    const first = parsed.command ?? parsed.path ?? parsed.pattern ?? parsed.title;
    return typeof first === "string" ? first.split("\n").at(-1)!.slice(0, 120) : "";
  } catch {
    return "";
  }
}
