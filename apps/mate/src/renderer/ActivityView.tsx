import { TOPIC_LABELS, type InsightTopic } from "@pi-desktop/mate-runner/activity-types";
import { useEffect, useState } from "react";
import type { ActivityRecord, Overview } from "../shared/api";
import type { Act } from "./App";
import { relativeTime } from "./mate-view";
import { pickFolder } from "./folder-pick";

/**
 * 활동 관찰 (설계 DESIGN-MATE.md §10, M4).
 * 켜면 Pi 세션 기록과 최근 작업한 저장소를 보고, 작업이 끝났을 때 도울 거리를 인박스에 남긴다.
 */
export function ActivityView({ overview, now, act }: { overview: Overview; now: number; act: Act }) {
  const { observe } = overview.config;
  const view = overview.observe;
  const [quiet, setQuiet] = useState(String(observe.quietMinutes));
  const [limit, setLimit] = useState(String(observe.dailySuggestionLimit));
  useEffect(() => {
    setQuiet(String(observe.quietMinutes));
    setLimit(String(observe.dailySuggestionLimit));
  }, [observe.quietMinutes, observe.dailySuggestionLimit]);
  const save = (patch: Partial<typeof observe>) => void act(() => window.mate.saveConfig({ observe: patch }));

  return (
    <section className="form">
      <label className="radio">
        <input type="checkbox" checked={observe.enabled} onChange={() => save({ enabled: !observe.enabled })} />
        <strong>활동 관찰</strong>
        <span className="muted">작업이 끝날 때마다 Mate가 도울 거리를 찾아 알려 줍니다</span>
      </label>
      <div className="muted small-text privacy">
        <div>
          <strong>보는 것</strong>: Pi Desktop·터미널 Pi·Pi Desktop Agent 세션 기록(요청, 고친 파일, 실패한 명령, 오류. 읽기만 함)과 최근 작업한 저장소의 git 상태.
        </div>
        <div>
          <strong>보지 않는 것</strong>: 화면, 키 입력, 다른 프로그램. 파일 내용·모델 답변은 기록하지 않고, 요청·명령은 앞부분만 남기며 비밀값처럼
          보이는 것은 가립니다. 기록은 이 PC의 Mate 데이터 폴더에만 있습니다.
        </div>
        <div>
          <strong>알리는 것</strong>: 연결 오류로 끝난 세션, push 안 한 커밋(하루), 커밋 안 한 변경(이틀)은 바로. 고치고 테스트를 안 돌림·같은 실패
          반복은 쉬는 때 관찰자가 살펴보고 필요할 때만. 계속 버리는 주제는 덜 알립니다.
        </div>
      </div>

      {observe.enabled && (
        <>
          <div className="row">
            <label className="inline">
              조용한 시간(분)
              <input type="number" min={1} max={120} value={quiet} onChange={(e) => setQuiet(e.target.value)} onBlur={() => save({ quietMinutes: Number(quiet) })} />
            </label>
            <label className="inline">
              하루 제안 상한
              <input type="number" min={0} max={50} value={limit} onChange={(e) => setLimit(e.target.value)} onBlur={() => save({ dailySuggestionLimit: Number(limit) })} />
            </label>
            <span className="muted small-text">
              오늘 {view.today.count}/{observe.dailySuggestionLimit}건 알림 · 관찰자 대기 {view.queue}건
            </span>
          </div>
          <ExcludedFolders excluded={observe.excluded} onChange={(excluded) => save({ excluded })} />

          <h2>배운 것</h2>
          {Object.keys(view.feedback).length === 0 ? (
            <div className="muted small-text">아직 관찰 제안에 대한 반응이 없습니다.</div>
          ) : (
            <div className="kv">
              {Object.entries(view.feedback).map(([topic, f]) => {
                const muted = f.dismissed >= 3 && f.accepted === 0;
                return (
                  <FragmentRow key={topic} label={TOPIC_LABELS[topic as InsightTopic] ?? topic}>
                    {f.shown}번 알림 · 받아들임 {f.accepted} · 버림 {f.dismissed}
                    {muted && <span className="chip warn">덜 알리는 중</span>}
                  </FragmentRow>
                );
              })}
            </div>
          )}

          {view.projects.length > 0 && (
            <>
              <h2>최근 작업한 저장소</h2>
              <ul className="cards">
                {view.projects.map((p) => (
                  <li key={p.cwd} className="card">
                    <div className="card-head">
                      <strong className="title">{p.cwd.replace(/\\/g, "/").split("/").filter(Boolean).at(-1)}</strong>
                      <span className="chip">{p.branch}</span>
                      <span className="muted small-text path">{p.cwd}</span>
                    </div>
                    <div className="duty-meta">
                      <span>{p.ahead === undefined ? "원격 브랜치 없음" : p.ahead > 0 ? `push 안 한 커밋 ${p.ahead}개` : "원격과 같음"}</span>
                      <span>{p.dirty > 0 ? `커밋 안 한 파일 ${p.dirty}개${p.dirtySince ? ` (${relativeTime(p.dirtySince, now)}부터)` : ""}` : "변경 없음"}</span>
                      <span className="muted">확인: {relativeTime(p.checkedAt, now)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}

          <h2>최근 활동</h2>
          {view.activity.length === 0 && (
            <div className="muted small-text">
              아직 기록이 없습니다. Pi Desktop·터미널 Pi·Agent로 작업하고 {observe.quietMinutes}분 쉬면 여기에 나타납니다.
            </div>
          )}
          <ul className="cards">
            {view.activity.map((record, i) => (
              <ActivityRow key={i} record={record} now={now} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function FragmentRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <span>{label}</span>
      <span>{children}</span>
    </>
  );
}

function ActivityRow({ record, now }: { record: ActivityRecord; now: number }) {
  if (record.kind === "session-ended") {
    const s = record.session;
    const name = s.cwd.replace(/\\/g, "/").split("/").filter(Boolean).at(-1);
    return (
      <li className="card activity">
        <div className="card-head">
          <span className="chip">작업 끝</span>
          <strong className="title">{s.firstPrompt ?? "(요청 없음)"}</strong>
          <span className="muted">
            {name} · {relativeTime(record.at, now)}
          </span>
        </div>
        <div className="duty-meta">
          <span>요청 {s.prompts}번</span>
          {s.editedFiles.length > 0 && <span title={s.editedFiles.join("\n")}>고친 파일 {s.editedFiles.length}개</span>}
          {s.commands > 0 && <span>명령 {s.commands}번{s.ranTests ? " (테스트 포함)" : ""}</span>}
          {s.failures.length > 0 && <span className="bad-text" title={s.failures.join("\n")}>실패 {s.failures.length}번</span>}
          {s.modelErrors.length > 0 && <span className="bad-text">모델 오류: {s.modelErrors.at(-1)}</span>}
        </div>
      </li>
    );
  }
  if (record.kind === "suggested") {
    return (
      <li className="card activity">
        <div className="card-head">
          <span className="chip sev-info">알림</span>
          <strong className="title">{record.title}</strong>
          <span className="muted">
            {TOPIC_LABELS[record.topic as InsightTopic] ?? record.topic} · {relativeTime(record.at, now)}
          </span>
        </div>
      </li>
    );
  }
  return null;
}

function ExcludedFolders({ excluded, onChange }: { excluded: string[]; onChange: (excluded: string[]) => void }) {
  return (
    <div className="excluded">
      <span>관찰하지 않을 폴더</span>
      {excluded.length === 0 && <span className="muted small-text">없음 (모든 Pi 세션)</span>}
      {excluded.map((folder) => (
        <span key={folder} className="chip">
          {folder}{" "}
          <button className="link" onClick={() => onChange(excluded.filter((f) => f !== folder))} title="빼기">
            ×
          </button>
        </span>
      ))}
      <button
        className="small"
        onClick={async () => {
          const dir = await pickFolder();
          if (dir && !excluded.includes(dir)) onChange([...excluded, dir]);
        }}
      >
        폴더 추가
      </button>
    </div>
  );
}
