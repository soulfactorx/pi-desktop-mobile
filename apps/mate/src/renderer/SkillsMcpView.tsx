import { useEffect, useState } from "react";
import { WEB_SEARCH_PRESETS as MCP_PRESETS } from "@pi-desktop/pi-isolation/mcp-presets";
import type { McpCheckResult, McpServerView, SkillInput, SkillView } from "../shared/api";
import type { Act } from "./App";

/** 편집 중인 스킬. previous가 없으면 새 스킬 */
interface Draft extends SkillInput {
  previous?: string;
}

const emptyDraft = (): Draft => ({ name: "", description: "", instructions: "", modelInvocation: true });

/**
 * 스킬·MCP (설계 DESIGN-APPS.md §3.4). Mate 홈의 skills/·mcp.json을 Agent의 스킬·MCP 화면과 같은 방식으로 다룬다.
 * 임무마다 이 중에서 쓸 스킬·서버를 고른다 (임무 고치기). Pi Desktop·Agent의 것과 섞이지 않는다.
 */
export function SkillsMcpView({ act }: { act: Act }) {
  const [skills, setSkills] = useState<SkillView[]>();
  const [servers, setServers] = useState<McpServerView[]>();
  const [draft, setDraft] = useState<Draft>();
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [check, setCheck] = useState<McpCheckResult>();
  const [checking, setChecking] = useState(false);

  const load = async () => {
    const [s, m] = await Promise.all([window.mate.skillsList(), window.mate.listMcp()]);
    setSkills(s);
    setServers(m);
  };
  useEffect(() => void act(load), []);

  const mcp = (job: () => Promise<McpServerView[]>) =>
    void act(async () => {
      setServers(await job());
      setCheck(undefined);
    });

  return (
    <section>
      <div className="section-head">
        <h2>스킬</h2>
        <span className="muted">임무 지시에 쓸 작업 방법 (Pi 스킬). 임무마다 쓸 스킬을 고릅니다 (기본: 전부)</span>
        <span className="right">
          <button className="small primary" onClick={() => setDraft(emptyDraft())}>
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
              disabled={!draft.name.trim() || !draft.description.trim() || !draft.instructions.trim()}
              onClick={() =>
                void act(async () => {
                  const { previous, ...input } = draft;
                  await window.mate.skillSave(previous, input);
                  setDraft(undefined);
                  await load();
                })
              }
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
                  onClick={() => {
                    if (confirm(`${s.name} 스킬을 지울까요? 휴지통으로 옮겨져 되살릴 수 있습니다.`)) void act(async () => (await window.mate.skillDelete(s.name), await load()));
                  }}
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
            onClick={() =>
              void act(async () => {
                setChecking(true);
                try {
                  setCheck(await window.mate.checkMcp());
                } finally {
                  setChecking(false);
                }
              })
            }
          >
            {checking ? "확인 중…" : "연결 확인"}
          </button>
        </span>
      </div>
      <ul className="cards">
        {MCP_PRESETS.map((preset) => {
          const server = servers?.find((s) => s.name === preset.name);
          const added = !!server;
          // Mate의 제안으로 키 없이(꺼진 채) 넣은 서버는 키를 넣으면 켜진다
          const needsKey = !!preset.keyEnv && (!server || !server.hasSecrets);
          return (
            <li key={preset.id} className="card">
              <div className="card-head">
                <strong className="title">{preset.label}</strong>
                <span className="muted">{preset.detail}</span>
                <span className="right">
                  {needsKey && (
                    <input type="password" placeholder={preset.keyEnv} value={keys[preset.id] ?? ""} onChange={(e) => setKeys((prev) => ({ ...prev, [preset.id]: e.target.value }))} />
                  )}{" "}
                  <button
                    className={added && !needsKey ? "small" : "small primary"}
                    disabled={(added && !needsKey) || (!!preset.keyEnv && !keys[preset.id]?.trim())}
                    onClick={() => {
                      mcp(() => window.mate.addMcpPreset(preset.id, keys[preset.id]));
                      setKeys((prev) => ({ ...prev, [preset.id]: "" }));
                    }}
                  >
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
                <input type="checkbox" checked={s.enabled} onChange={(e) => mcp(() => window.mate.setMcpEnabled(s.name, e.target.checked))} />
              </label>
              <strong className="title">{s.name}</strong>
              {s.hasSecrets && <span className="chip">키 있음</span>}
              <span className="muted path" title={s.target}>
                {s.kind === "url" ? "🌐 " : "▶ "}
                {s.target}
              </span>
              <span className="right">
                <button className="small" onClick={() => mcp(() => window.mate.removeMcp(s.name))}>
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
    </section>
  );
}
