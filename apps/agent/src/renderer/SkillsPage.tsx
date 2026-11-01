import { useState } from "react";
import type { SkillView } from "@pi-desktop/agent-kit/skill-types";
import { emptySkillDraft, skillDraftOf, skillDraftReady, useSkills } from "@pi-desktop/pi-resources/react";

/**
 * 스킬 (설계 DESIGN-AGENT.md §4 "스킬"). Pi 스킬(SKILL.md)을 보고 만들고 고친다.
 * 모델은 스킬의 이름·설명을 보고 필요할 때 지시를 읽고, 사람은 /skill:이름으로 부른다. 대화에서 "스킬로 만들어"라고 해도 저장된다.
 * 스킬은 앱 홈의 skills/(~/.pi-desktop-agent/skills)에 있다. Pi Desktop·터미널 pi의 스킬과 섞이지 않는다 (DESIGN-APPS.md §3).
 * 상태와 동작은 세 앱이 함께 쓰는 pi-resources의 것이고, 여기서는 모양만 그린다 (DESIGN-APPS.md §3.5).
 */
export function SkillsPage({ onUse, onError }: { onUse: (name: string) => void; onError: (message: string) => void }) {
  const [selected, setSelected] = useState<SkillView>();

  const run = (action: () => Promise<unknown>) =>
    void action().catch((error: unknown) => onError(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(error)));
  const { skills, draft, setDraft, save: saveDraft, remove } = useSkills(
    { list: () => window.piAgent.skillsList(), save: (previous, input) => window.piAgent.skillSave(previous, input), remove: (name) => window.piAgent.skillDelete(name) },
    run,
  );
  const save = () => saveDraft(() => setSelected(undefined));

  const user = skills ?? [];

  const row = (s: SkillView) => (
    <li key={s.folder} className={`skill-item${selected?.path === s.path ? " active" : ""}`}>
      <button
        className="kb-row"
        onClick={() => {
          setSelected(s);
          setDraft(undefined);
        }}
      >
        <span className="kb-row-head">
          <strong className="kb-title">/skill:{s.name}</strong>
          {!s.modelInvocation && (
            <span className="badge" title="모델이 알아서 고르지 않고 /skill:이름으로만 씁니다">
              명령으로만
            </span>
          )}
          {s.extraFiles.length > 0 && <span className="muted small-text">+ {s.extraFiles.join(", ")}</span>}
        </span>
        <span className="muted small-text kb-row-meta">{s.description}</span>
      </button>
      <button className="small" onClick={() => onUse(s.name)} title={`대화 입력창에 /skill:${s.name} 을 채웁니다`}>
        대화에서 쓰기
      </button>
    </li>
  );

  return (
    <div className="page">
      <header className="page-head">
        <h2>스킬</h2>
        <span className="muted">되풀이하는 작업 방법을 Pi 스킬로 둡니다. 모델이 설명을 보고 필요할 때 읽고, /skill:이름으로 부를 수도 있습니다</span>
      </header>
      <div className="page-body">
        <div className="row">
          <button className="small primary" onClick={() => (setDraft(emptySkillDraft()), setSelected(undefined))}>
            + 새 스킬
          </button>
          <button className="small" onClick={() => run(async () => window.piAgent.skillOpenFolder())} title="스크립트·참고 파일을 함께 두려면 폴더에서 직접 넣으세요">
            스킬 폴더 열기
          </button>
          <span className="muted small-text">대화에서 "이걸 스킬로 만들어"라고 해도 저장됩니다. 바꾼 스킬은 새 대화부터 쓰입니다.</span>
        </div>

        <div className="kb-layout">
          <div>
            <h3>내 스킬</h3>
            {!skills ? (
              <p className="muted">읽는 중…</p>
            ) : user.length === 0 ? (
              <p className="muted">아직 스킬이 없습니다. + 새 스킬로 만들거나, 대화에서 다듬은 작업을 "스킬로 만들어"라고 하세요.</p>
            ) : (
              <ul className="list">{user.map(row)}</ul>
            )}
          </div>

          {selected && !draft && (
            <section className="card kb-editor">
              <h3>/skill:{selected.name}</h3>
              <p className="small-text">{selected.description}</p>
              <p className="muted small-text">
                {selected.modelInvocation ? "모델이 알아서 고를 수 있음" : "/skill:이름으로만"} · {selected.path}
              </p>
              <pre className="kb-preview">{selected.instructions}</pre>
              <div className="row">
                <button className="small primary" onClick={() => onUse(selected.name)}>
                  대화에서 쓰기
                </button>
                <button className="small" onClick={() => setDraft(skillDraftOf(selected))}>
                  고치기
                </button>
                <button
                  className="small danger"
                  onClick={() => remove(selected.name, `${selected.name} 스킬을 지울까요? (휴지통 폴더로 옮겨져 되돌릴 수 있습니다)`, () => setSelected(undefined))}
                >
                  지우기
                </button>
                <button className="small link-button" onClick={() => setSelected(undefined)}>
                  닫기
                </button>
              </div>
            </section>
          )}

          {draft && (
            <section className="card kb-editor">
              <h3>{draft.previous ? `${draft.previous} 고치기` : "새 스킬"}</h3>
              <div className="form-row">
                <input className="grow" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value.toLowerCase() })} placeholder="이름 (영어 소문자·숫자·하이픈, 예: weekly-report)" />
              </div>
              <div className="form-row">
                <input
                  className="grow"
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  placeholder="설명: 무엇을 하고 언제 쓰는지 (예: 주간 보고서를 만든다. 금요일 보고 준비에 쓴다)"
                />
              </div>
              <label className="check-row small-text" title="끄면 /skill:이름으로 부를 때만 씁니다">
                <input type="checkbox" checked={draft.modelInvocation} onChange={(e) => setDraft({ ...draft, modelInvocation: e.target.checked })} />
                모델이 알아서 고를 수 있게 하기
              </label>
              <textarea
                className="kb-content"
                value={draft.instructions}
                onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
                placeholder={"지시 (Markdown)\n# 주간 보고\n1. 지난 7일의 커밋을 본다\n2. 기능·수정·문서로 나눠 세 줄씩 정리한다"}
              />
              <div className="row">
                <button className="small primary" disabled={!skillDraftReady(draft)} onClick={save}>
                  저장
                </button>
                <button className="small link-button" onClick={() => setDraft(undefined)}>
                  취소
                </button>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
