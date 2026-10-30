import { useEffect, useState } from "react";
import { describeSchedule } from "@pi-desktop/agent-kit/schedule-plan";
import type { Schedule, TaskRecord } from "../shared/api";

const STATUS: Record<TaskRecord["status"], { text: string; tone: "ok" | "bad" | "" }> = {
  waiting: { text: "승인 기다림", tone: "" },
  running: { text: "실행 중", tone: "" },
  done: { text: "완료", tone: "ok" },
  failed: { text: "실패", tone: "bad" },
  cancelled: { text: "취소됨", tone: "" },
};

function when(iso: string | undefined): string {
  return iso ? new Date(iso).toLocaleString() : "-";
}

/**
 * 작업·예약 목록 (설계 DESIGN-AGENT.md §4 "알림"). 대화에서 맡긴 작업과 예약 실행 결과를 함께 본다.
 * 앱을 닫아 둔 동안 돈 예약의 결과도 여기서 확인한다.
 */
export function TasksPanel({ onError }: { onError: (message: string) => void }) {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [openId, setOpenId] = useState<string>();

  const run = (action: () => Promise<void>) =>
    action().catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)));
  const refresh = async () => {
    const [nextTasks, nextSchedules] = await Promise.all([window.piAgent.listTasks(), window.piAgent.listSchedules()]);
    setTasks(nextTasks);
    setSchedules(nextSchedules);
  };

  useEffect(() => {
    void run(refresh);
    return window.piAgent.onTasksChanged(() => void run(refresh));
  }, []);

  return (
    <div className="tasks-panel">
      <section>
        <h3>예약</h3>
        {schedules.length === 0 ? (
          <p className="tasks-empty">예약이 없습니다. 대화에서 "매일 9시에 …"처럼 부탁하면 등록됩니다.</p>
        ) : (
          <ul className="tasks-list">
            {schedules.map((s) => (
              <li key={s.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={s.enabled}
                    onChange={(e) => run(async () => (await window.piAgent.setScheduleEnabled(s.id, e.target.checked), await refresh()))}
                  />
                  <strong>{s.title}</strong>
                </label>
                <span className="tasks-meta">
                  {s.kind === "once" ? `한 번 ${when(s.at)}` : describeSchedule(s)} · 다음 {when(s.nextRun)}
                </span>
                <button onClick={() => run(async () => (await window.piAgent.removeSchedule(s.id), await refresh()))}>지우기</button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h3>최근 작업</h3>
        {tasks.length === 0 ? (
          <p className="tasks-empty">아직 작업이 없습니다.</p>
        ) : (
          <ul className="tasks-list">
            {tasks.map((t) => (
              <li key={t.id} className="tasks-item">
                <button className="tasks-row" onClick={() => setOpenId(openId === t.id ? undefined : t.id)}>
                  <span className={`badge ${STATUS[t.status].tone}`}>{STATUS[t.status].text}</span>
                  <span className="tasks-origin">{originLabel(t)}</span>
                  <strong>{t.title}</strong>
                  <span className="tasks-meta">{when(t.finishedAt ?? t.startedAt)}</span>
                </button>
                {openId === t.id && <pre className="tasks-result">{t.error ?? t.result ?? "(결과 없음)"}</pre>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** 작업이 어디서 왔는지 (예약, 대화, 피어가 맡김, 피어에게 맡김) */
function originLabel(task: TaskRecord): string {
  if (task.origin === "schedule") return "예약";
  if (task.origin === "peer-in") return `${task.peer?.name ?? "피어"}가 맡김`;
  if (task.origin === "peer-out") return `${task.peer?.name ?? "피어"}에게 맡김`;
  return "작업";
}
