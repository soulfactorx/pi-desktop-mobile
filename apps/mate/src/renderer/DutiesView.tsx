import { useEffect, useState } from "react";
import type { DutyDraft, DutyView, McpServerView, Overview, PiSetupView, SkillView } from "../shared/api";
import { ModelSelect } from "./PiSetup";
import { pickFolder } from "./folder-pick";
import type { Act } from "./App";
import {
  defaultTrigger,
  DUTY_TEMPLATES,
  emptyDraft,
  grantLabel,
  nextRunLabel,
  PROFILE_LABELS,
  relativeTime,
  STATUS_LABELS,
  toggleSkill,
  TRIGGER_HINTS,
  TRIGGER_KINDS,
  triggerLabel,
  WEEKDAY_LABELS,
} from "./mate-view";

/** 임무 목록과 만들기·고치기 폼 */
export function DutiesView({ overview, now, act, setup }: { overview: Overview; now: number; act: Act; setup: PiSetupView | undefined }) {
  const [editing, setEditing] = useState<DutyDraft>();

  if (editing) {
    return (
      <DutyForm
        initial={editing}
        defaultModel={overview.config.model}
        setup={setup}
        defaultMaxCost={overview.config.maxCostUsd}
        onCancel={() => setEditing(undefined)}
        onSave={async (draft) => {
          // 거부되면(예: 확인 명령이 허용 목록 밖) 고칠 수 있게 폼을 열어 둔다
          if (await act(() => window.mate.saveDuty(draft))) setEditing(undefined);
        }}
      />
    );
  }

  const lastCwd = overview.duties.at(-1)?.cwd ?? "";
  return (
    <section>
      <div className="section-head">
        <span className="muted">정한 때에 Pi가 작업 폴더를 읽기만 하며 살펴보고, 결과·제안을 인박스에 남깁니다.</span>
        <button className="primary" onClick={() => setEditing(emptyDraft(lastCwd))}>
          새 임무
        </button>
      </div>
      {overview.duties.length === 0 && (
        <div className="empty">
          <p>아직 임무가 없습니다. 템플릿으로 시작해 보세요.</p>
          <div className="row">
            {DUTY_TEMPLATES.map((t) => (
              <button key={t.label} onClick={() => setEditing({ ...t.draft, cwd: lastCwd })}>
                {t.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <ul className="cards">
        {overview.duties.map((duty) => (
          <DutyCard key={duty.id} duty={duty} now={now} paused={overview.config.paused} act={act} onEdit={() => setEditing(duty)} />
        ))}
      </ul>
    </section>
  );
}

function DutyCard({ duty, now, paused, act, onEdit }: { duty: DutyView; now: number; paused: boolean; act: Act; onEdit: () => void }) {
  const toggle = () => void act(() => window.mate.saveDuty({ ...duty, enabled: !duty.enabled }));
  return (
    <li className={`card duty-card${duty.enabled ? "" : " disabled"}`}>
      <div className="card-head">
        <label className="switch" title={duty.enabled ? "끄기" : "켜기"}>
          <input type="checkbox" checked={duty.enabled} onChange={toggle} />
        </label>
        <strong className="title">{duty.name}</strong>
        <span className="chip">{PROFILE_LABELS[duty.profile].name}</span>
        <span className="muted">{triggerLabel(duty.trigger)}</span>
      </div>
      <div className="muted path" title={duty.cwd}>
        {duty.cwd}
      </div>
      <div className="duty-meta">
        <span>{nextRunLabel(duty, now, paused)}</span>
        {duty.lastRunAt && (
          <span className={duty.lastStatus === "done" ? "" : "bad-text"}>
            마지막: {relativeTime(duty.lastRunAt, now)} {duty.lastStatus ? STATUS_LABELS[duty.lastStatus] : ""}
          </span>
        )}
      </div>
      <div className="card-actions">
        <button className="small primary" disabled={duty.queued} onClick={() => void act(() => window.mate.runNow(duty.id))}>
          지금 실행
        </button>
        <button className="small" onClick={onEdit}>
          고치기
        </button>
        <button
          className="small danger"
          onClick={() => {
            if (confirm(`"${duty.name}" 임무를 지울까요? 휴지통으로 옮겨져 되살릴 수 있고, 이미 쌓인 제안과 실행 기록은 남습니다.`)) void act(() => window.mate.deleteDuty(duty.id));
          }}
        >
          지우기
        </button>
      </div>
    </li>
  );
}

function DutyForm({
  initial,
  defaultModel,
  setup,
  defaultMaxCost,
  onSave,
  onCancel,
}: {
  initial: DutyDraft;
  defaultModel: string;
  setup: PiSetupView | undefined;
  defaultMaxCost: number;
  onSave: (draft: DutyDraft) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<DutyDraft>(initial);
  const set = (patch: Partial<DutyDraft>) => setDraft((d) => ({ ...d, ...patch }));
  // 고를 수 있는 스킬·MCP 서버 (Mate 홈의 skills/·mcp.json, 스킬·MCP 탭에서 관리)
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [servers, setServers] = useState<McpServerView[]>([]);
  useEffect(() => {
    void window.mate.skillsList().then(setSkills, () => setSkills([]));
    void window.mate.listMcp().then(setServers, () => setServers([]));
  }, []);
  const skillNames = skills.map((s) => s.name);
  const pickedServers = new Set(draft.mcpServers ?? []);
  const t = draft.trigger;
  const valid = draft.name.trim() && draft.cwd.trim() && draft.prompt.trim();

  const setKind = (kind: DutyDraft["trigger"]["kind"]) => set({ trigger: defaultTrigger(kind) });
  const setTrigger = (patch: Record<string, unknown>) => set({ trigger: { ...t, ...patch } as DutyDraft["trigger"] });
  const toggleDay = (day: number) => {
    if (t.kind !== "daily" && t.kind !== "interval") return;
    const days = new Set(t.weekdays ?? [0, 1, 2, 3, 4, 5, 6]);
    if (days.has(day)) days.delete(day);
    else days.add(day);
    set({ trigger: { ...t, weekdays: [...days].sort() } });
  };

  return (
    <section className="form">
      <h2>{initial.id ? "임무 고치기" : "새 임무"}</h2>
      {!initial.id && (
        <div className="row">
          <span className="muted">템플릿:</span>
          {DUTY_TEMPLATES.map((tpl) => (
            <button key={tpl.label} className="small" onClick={() => setDraft({ ...tpl.draft, cwd: draft.cwd })}>
              {tpl.label}
            </button>
          ))}
        </div>
      )}
      <label>
        이름
        <input value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="예: 아침 브리핑" />
      </label>
      <label>
        작업 폴더
        <div className="row">
          <input className="grow" value={draft.cwd} onChange={(e) => set({ cwd: e.target.value })} placeholder="Pi가 살펴볼 저장소 폴더" />
          <button
            onClick={async () => {
              const dir = await pickFolder();
              if (dir) set({ cwd: dir });
            }}
          >
            찾아보기
          </button>
        </div>
      </label>
      <label>
        지시
        <textarea rows={5} value={draft.prompt} onChange={(e) => set({ prompt: e.target.value })} placeholder="무엇을 살펴보고 무엇을 알려 줄지" />
      </label>
      <fieldset>
        <legend>하는 일</legend>
        {(Object.keys(PROFILE_LABELS) as Array<DutyDraft["profile"]>).map((p) => (
          <label key={p} className="radio">
            <input type="radio" checked={draft.profile === p} onChange={() => set({ profile: p })} />
            <strong>{PROFILE_LABELS[p].name}</strong> <span className="muted">{PROFILE_LABELS[p].hint}</span>
          </label>
        ))}
        <div className="muted small-text">
          보고·제안은 파일을 바꾸지 않습니다. 고치기도 내 작업 폴더는 적용 전까지 그대로입니다. bash는 어느 단계든 읽기 명령만 통과합니다. 다른 명령이
          필요하면 실행한 뒤 Mate가 대화로 허용을 묻습니다.
        </div>
        {draft.grants?.length ? (
          <div className="row">
            <span className="muted">허용한 명령·도구:</span>
            {draft.grants.map((g) => (
              <span key={g} className="badge">
                <code>{grantLabel(g)}</code>{" "}
                <button
                  className="small"
                  title={`${g} 허용 빼기`}
                  onClick={() => {
                    const rest = draft.grants!.filter((x) => x !== g);
                    set({ grants: rest.length ? rest : undefined });
                  }}
                >
                  빼기
                </button>
              </span>
            ))}
          </div>
        ) : null}
      </fieldset>
      <fieldset>
        <legend>스킬·MCP</legend>
        <div className="row">
          <span className="muted">스킬:</span>
          <label className="radio">
            <input type="radio" checked={!draft.skills} onChange={() => set({ skills: undefined })} /> 전부
          </label>
          <label className="radio">
            <input type="radio" checked={!!draft.skills} onChange={() => set({ skills: draft.skills ?? skillNames })} /> 고르기
          </label>
          {skillNames.length === 0 && <span className="muted small-text">스킬이 없습니다 (스킬·MCP 탭에서 만듭니다)</span>}
        </div>
        {draft.skills && skillNames.length > 0 && (
          <div className="row">
            {skills.map((s) => (
              <label key={s.name} className="day" title={s.description}>
                <input type="checkbox" checked={draft.skills!.includes(s.name)} onChange={() => set({ skills: toggleSkill(draft.skills, skillNames, s.name) })} /> {s.name}
              </label>
            ))}
          </div>
        )}
        <div className="row">
          <span className="muted">MCP 서버:</span>
          {servers.length === 0 && <span className="muted small-text">없음 (스킬·MCP 탭에서 넣습니다)</span>}
          {servers.map((s) => (
            <label key={s.name} className="day" title={s.description ?? s.target}>
              <input
                type="checkbox"
                checked={pickedServers.has(s.name)}
                disabled={!s.enabled && !pickedServers.has(s.name)}
                onChange={() => {
                  const next = new Set(pickedServers);
                  if (next.has(s.name)) next.delete(s.name);
                  else next.add(s.name);
                  set({ mcpServers: next.size ? [...next] : undefined });
                }}
              />{" "}
              {s.name}
              {!s.enabled && " (꺼짐)"}
            </label>
          ))}
        </div>
        <div className="muted small-text">
          스킬은 지침일 뿐 권한을 넓히지 않습니다. 고른 MCP 서버의 도구도 처음 쓸 때는 막고, 실행이 끝나면 Mate가 도구마다 허용을 묻습니다.
        </div>
      </fieldset>
      <fieldset>
        <legend>언제</legend>
        <div className="row">
          <select value={t.kind} onChange={(e) => setKind(e.target.value as DutyDraft["trigger"]["kind"])}>
            {TRIGGER_KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </select>
          {t.kind === "interval" && (
            <>
              <input type="number" min={15} step={15} value={t.minutes} onChange={(e) => setTrigger({ minutes: Number(e.target.value) })} />
              <span className="muted">분마다 (최소 15분)</span>
              <label className="day" title="정한 시간대에만 돌립니다 (예: 낮 시간에만)">
                <input
                  type="checkbox"
                  checked={Boolean(t.from)}
                  onChange={(e) =>
                    set({
                      trigger: e.target.checked
                        ? { ...t, from: "08:00", to: "20:00" }
                        : { kind: "interval", minutes: t.minutes, ...(t.weekdays ? { weekdays: t.weekdays } : {}) },
                    })
                  }
                />
                시간대
              </label>
              {t.from && (
                <>
                  <input type="time" value={t.from} onChange={(e) => setTrigger({ from: e.target.value })} />
                  <span className="muted">~</span>
                  <input type="time" value={t.to} onChange={(e) => setTrigger({ to: e.target.value })} />
                </>
              )}
              {WEEKDAY_LABELS.map((label, day) => (
                <label key={day} className="day">
                  <input type="checkbox" checked={!t.weekdays?.length || t.weekdays.includes(day)} onChange={() => toggleDay(day)} />
                  {label}
                </label>
              ))}
            </>
          )}
          {t.kind === "daily" && (
            <>
              <input type="time" value={t.time} onChange={(e) => set({ trigger: { ...t, time: e.target.value } })} />
              {WEEKDAY_LABELS.map((label, day) => (
                <label key={day} className="day">
                  <input type="checkbox" checked={!t.weekdays?.length || t.weekdays.includes(day)} onChange={() => toggleDay(day)} />
                  {label}
                </label>
              ))}
            </>
          )}
          {t.kind === "poll" && (
            <>
              <input className="grow" value={t.command} onChange={(e) => setTrigger({ command: e.target.value })} placeholder="gh run list --limit 5" />
              <input type="number" min={15} step={15} value={t.minutes} onChange={(e) => setTrigger({ minutes: Number(e.target.value) })} />
              <span className="muted">분마다 확인</span>
            </>
          )}
          {t.kind === "files" && (
            <>
              <input type="number" min={10} value={t.quietSeconds ?? 60} onChange={(e) => setTrigger({ quietSeconds: Number(e.target.value) })} />
              <span className="muted">초 동안 저장이 없으면</span>
            </>
          )}
          {(t.kind === "git" || t.kind === "files" || t.kind === "session") && (
            <>
              <input type="number" min={5} value={t.cooldownMinutes ?? 15} onChange={(e) => setTrigger({ cooldownMinutes: Number(e.target.value) })} />
              <span className="muted">분 안에는 다시 돌지 않음</span>
            </>
          )}
        </div>
        <div className="muted small-text">{TRIGGER_HINTS[t.kind]}</div>
      </fieldset>
      <details>
        <summary>고급</summary>
        <label>
          모델
          <ModelSelect
            value={draft.model ?? ""}
            onChange={(model) => set({ model: model || undefined })}
            setup={setup}
            inheritLabel={`Mate 설정 따르기 (${defaultModel || "Pi 기본 모델"})`}
          />
        </label>
        <label>
          시간 제한(초)
          <input
            type="number"
            min={30}
            max={3600}
            value={draft.timeoutSec ?? ""}
            onChange={(e) => set({ timeoutSec: e.target.value ? Number(e.target.value) : undefined })}
            placeholder="기본: 300"
          />
        </label>
        <label>
          비용 상한(USD, 실행당)
          <input
            type="number"
            min={0}
            step={0.05}
            value={draft.maxCostUsd ?? ""}
            onChange={(e) => set({ maxCostUsd: e.target.value ? Number(e.target.value) : undefined })}
            placeholder={`기본: $${defaultMaxCost}`}
          />
        </label>
      </details>
      <div className="row end">
        <button onClick={onCancel}>취소</button>
        <button className="primary" disabled={!valid} onClick={() => void onSave(draft)}>
          저장
        </button>
      </div>
    </section>
  );
}
