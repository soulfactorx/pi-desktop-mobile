import { emptySkillDraft, skillDraftReady, useImports, useMcp, usePackages, useSkills } from "@pi-desktop/pi-resources/react";
import type { Act } from "./App";

/**
 * 스킬·MCP (설계 DESIGN-APPS.md §3.4). Mate 홈의 skills/·mcp.json을 Agent의 스킬·MCP 화면과 같은 방식으로 다룬다.
 * 임무마다 이 중에서 쓸 스킬·서버를 고른다 (임무 고치기). Pi Desktop·Agent의 것과 섞이지 않는다.
 * 상태와 동작은 세 앱이 함께 쓰는 pi-resources의 것이고, 여기서는 모양만 그린다 (DESIGN-APPS.md §3.5).
 */
export function SkillsMcpView({ act }: { act: Act }) {
  const run = (job: () => Promise<void>) => void act(job);
  const { skills, draft, setDraft, save, remove, refresh: refreshSkills } = useSkills(
    { list: () => window.mate.skillsList(), save: (previous, input) => window.mate.skillSave(previous, input), remove: (name) => window.mate.skillDelete(name) },
    run,
  );
  const mcp = useMcp(
    {
      list: () => window.mate.listMcp(),
      addPreset: (id, key) => window.mate.addMcpPreset(id, key),
      setEnabled: (name, on) => window.mate.setMcpEnabled(name, on),
      remove: (name) => window.mate.removeMcp(name),
      check: () => window.mate.checkMcp(),
    },
    run,
  );
  const { servers, keys, check, checking } = mcp;
  const pkgs = usePackages(
    { list: () => window.mate.packagesList(), install: (s) => window.mate.packageInstall(s), remove: (s) => window.mate.packageRemove(s) },
    run,
  );
  const imports = useImports(
    { list: () => window.mate.importList(), importSkill: (from, name) => window.mate.importSkill(from, name), installPackage: (s) => window.mate.packageInstall(s) },
    run,
    () => {
      pkgs.refresh();
      refreshSkills();
    },
  );

  return (
    <section>
      <div className="section-head">
        <h2>스킬</h2>
        <span className="muted">임무 지시에 쓸 작업 방법 (Pi 스킬). 임무마다 쓸 스킬을 고릅니다 (기본: 전부)</span>
        <span className="right">
          <button className="small primary" onClick={() => setDraft(emptySkillDraft())}>
            + 새 스킬
          </button>{" "}
          <button className="small" onClick={() => void act(() => window.mate.skillOpenFolder())} title="스크립트·참고 파일을 함께 두려면 폴더에서 직접 넣으세요">
            스킬 폴더 열기
          </button>
        </span>
      </div>
      {draft && (
        <div className="form">
          <h2>{draft.previous ? `${draft.previous} 고치기` : "새 스킬"}</h2>
          <label>
            이름
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value.toLowerCase() })} placeholder="영어 소문자·숫자·하이픈 (예: hn-summary)" />
          </label>
          <label>
            설명
            <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="무엇을 하고 언제 쓰는지 (모델이 이것을 보고 고른다)" />
          </label>
          <label className="inline">
            <input type="checkbox" checked={draft.modelInvocation} onChange={(e) => setDraft({ ...draft, modelInvocation: e.target.checked })} /> 모델이 알아서 고를 수 있게 하기
          </label>
          <label>
            지시
            <textarea rows={8} value={draft.instructions} onChange={(e) => setDraft({ ...draft, instructions: e.target.value })} placeholder={"# HN 글 요약\n1. 제목과 점수를 본다\n2. 세 줄로 요약한다"} />
          </label>
          <div className="row end">
            <button onClick={() => setDraft(undefined)}>취소</button>
            <button
              className="primary"
              disabled={!skillDraftReady(draft)}
              onClick={() => save()}
            >
              저장
            </button>
          </div>
        </div>
      )}
      {skills && skills.length === 0 && <div className="empty">아직 스킬이 없습니다. 임무가 되풀이할 방법이 있으면 스킬로 적어 두세요.</div>}
      <ul className="cards">
        {skills?.map((s) => (
          <li key={s.folder} className="card">
            <div className="card-head">
              <strong className="title">{s.name}</strong>
              {!s.modelInvocation && <span className="chip">명령으로만</span>}
              <span className="muted">{s.description}</span>
              <span className="right">
                <button className="small" onClick={() => setDraft({ previous: s.name, name: s.name, description: s.description, instructions: s.instructions, modelInvocation: s.modelInvocation })}>
                  고치기
                </button>{" "}
                <button
                  className="small"
                  onClick={() => remove(s.name, `${s.name} 스킬을 지울까요? 휴지통으로 옮겨져 되살릴 수 있습니다.`)}
                >
                  지우기
                </button>
              </span>
            </div>
            {s.extraFiles.length > 0 && <div className="muted small-text">함께 든 파일: {s.extraFiles.join(", ")}</div>}
          </li>
        ))}
      </ul>

      <div className="section-head">
        <h2>MCP 서버</h2>
        <span className="muted">임무·대화가 쓸 외부 서비스. 임무마다 고르고(기본: 없음), 처음 쓰는 도구는 Mate가 허용을 묻습니다</span>
        <span className="right">
          <button className="small" onClick={() => void act(() => window.mate.openMcpFile())} title="다른 서버는 mcp.json을 직접 고칩니다">
            mcp.json 열기
          </button>{" "}
          <button
            className="small"
            disabled={checking || !servers?.length}
            onClick={mcp.runCheck}
          >
            {checking ? "확인 중…" : "연결 확인"}
          </button>
        </span>
      </div>
      <ul className="cards">
        {mcp.presets.map((row) => {
          const { preset, added, needsKey } = row;
          // Mate의 제안으로 키 없이(꺼진 채) 넣은 서버는 키를 넣으면 켜진다
          return (
            <li key={preset.id} className="card">
              <div className="card-head">
                <strong className="title">{preset.label}</strong>
                <span className="muted">{preset.detail}</span>
                <span className="right">
                  {needsKey && <input type="password" placeholder={preset.keyEnv} value={keys[preset.id] ?? ""} onChange={(e) => mcp.setKey(preset.id, e.target.value)} />}{" "}
                  <button className={added && !needsKey ? "small" : "small primary"} disabled={(added && !needsKey) || !mcp.canAdd(row)} onClick={() => mcp.addPreset(preset.id)}>
                    {added ? (needsKey ? "키 넣고 켜기" : "넣음") : "넣기"}
                  </button>
                </span>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="muted small-text">API 키는 Mate 폴더(~/.pi-desktop-mate)의 mcp.json에 저장되고 화면에는 다시 보이지 않습니다.</div>
      {servers && servers.length === 0 && <div className="empty">아직 MCP 서버가 없습니다.</div>}
      <ul className="cards">
        {servers?.map((s) => (
          <li key={s.name} className={`card${s.enabled ? "" : " disabled"}`}>
            <div className="card-head">
              <label className="switch" title={s.enabled ? "끄기" : "켜기"}>
                <input type="checkbox" checked={s.enabled} onChange={(e) => mcp.setEnabled(s.name, e.target.checked)} />
              </label>
              <strong className="title">{s.name}</strong>
              {s.hasSecrets && <span className="chip">키 있음</span>}
              <span className="muted path" title={s.target}>
                {s.kind === "url" ? "🌐 " : "▶ "}
                {s.target}
              </span>
              <span className="right">
                <button className="small" onClick={() => mcp.remove(s.name)}>
                  빼기
                </button>
              </span>
            </div>
            {s.description && <div className="muted small-text">{s.description}</div>}
          </li>
        ))}
      </ul>
      {check && (
        <div className="detail">
          <div className={check.ok ? "small-text" : "small-text bad-text"}>{check.ok ? "모든 서버에 연결됩니다." : "연결되지 않는 서버가 있습니다."}</div>
          <pre>{check.output.trim() || "(출력 없음)"}</pre>
        </div>
      )}

      <div className="section-head">
        <h2>확장 (Pi 패키지)</h2>
        <span className="muted">Mate 홈에 설치합니다. 확장이 더하는 도구는 처음 쓸 때 Mate가 허용을 묻습니다</span>
      </div>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          pkgs.install();
        }}
      >
        <input className="grow" value={pkgs.source} onChange={(e) => pkgs.setSource(e.target.value)} placeholder="npm 패키지 이름 (예: pi-web-access) 또는 npm:·git:·https 주소" enterKeyHint="go" />{" "}
        <button className="small primary" type="submit" disabled={!pkgs.source.trim() || Boolean(pkgs.busy)}>
          설치
        </button>
      </form>
      <div className="muted small-text">패키지는 코드를 실행합니다. 믿을 수 있는 것만 설치하세요. 설치에는 몇 분이 걸릴 수 있습니다.</div>
      {pkgs.busy && <div className="small-text">{pkgs.busy} 중…</div>}
      {pkgs.result && (
        <div className="detail">
          <div className={pkgs.result.ok ? "small-text" : "small-text bad-text"}>
            {pkgs.result.action} {pkgs.result.ok ? "완료" : "실패"}
          </div>
          {!pkgs.result.ok && <pre>{pkgs.result.output.slice(-2000) || "(출력 없음)"}</pre>}
        </div>
      )}
      {pkgs.packages && pkgs.packages.length === 0 && <div className="empty">아직 설치한 패키지가 없습니다.</div>}
      <ul className="cards">
        {pkgs.packages?.map((p) => (
          <li key={p.source} className="card">
            <div className="card-head">
              <strong className="title">{p.name}</strong>
              <span className="muted path" title={p.path ?? ""}>
                {p.source}
                {!p.path && " · 설치 폴더를 찾지 못함"}
              </span>
              <span className="right">
                <button className="small" disabled={Boolean(pkgs.busy)} onClick={() => pkgs.remove(p.source, `${p.name} 패키지를 지울까요?`)}>
                  지우기
                </button>
              </span>
            </div>
          </li>
        ))}
      </ul>

      <div className="section-head">
        <h2>다른 앱에서 가져오기</h2>
        <span className="muted">Pi Desktop·Agent의 스킬은 Mate로 복사하고, 패키지는 같은 것을 Mate에 새로 설치합니다. MCP는 위에서 새로 넣으세요</span>
        <span className="right">
          <button className="small" disabled={Boolean(imports.busy)} onClick={imports.load}>
            {imports.items ? "다시 읽기" : "목록 보기"}
          </button>
        </span>
      </div>
      {imports.busy && <div className="small-text">{imports.busy} 가져오는 중…</div>}
      {imports.message && <div className="small-text">{imports.message}</div>}
      {imports.items && imports.items.skills.length + imports.items.packages.length === 0 && <div className="empty">가져올 것이 없습니다.</div>}
      <ul className="cards">
        {imports.items?.skills.map((s) => (
          <li key={`s:${s.from}:${s.name}`} className="card">
            <div className="card-head">
              <strong className="title">{s.name}</strong>
              <span className="chip">스킬 · {s.fromLabel}</span>
              <span className="muted">{s.description}</span>
              <span className="right">
                <button className="small" disabled={s.exists || Boolean(imports.busy)} onClick={() => imports.importSkill(s.from, s.name)}>
                  {s.exists ? "있음" : "가져오기"}
                </button>
              </span>
            </div>
          </li>
        ))}
        {imports.items?.packages.map((p) => (
          <li key={`p:${p.from}:${p.source}`} className="card">
            <div className="card-head">
              <strong className="title">{p.name}</strong>
              <span className="chip">패키지 · {p.fromLabel}</span>
              <span className="muted path">{p.source}</span>
              <span className="right">
                <button className="small" disabled={p.exists || Boolean(imports.busy)} onClick={() => imports.importPackage(p.source)}>
                  {p.exists ? "있음" : "설치"}
                </button>
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
