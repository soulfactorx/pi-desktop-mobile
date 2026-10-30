import { useEffect, useState } from "react";
import type { CurrentHost, HostView, SshHostConfig } from "../shared/api";

/**
 * 호스트 고르기 (설계 DESIGN-APPS.md §6 D3). 에이전트는 한 번에 한 호스트(로컬·WSL·SSH)에 붙는다.
 * 원격을 고르면 그 호스트에 Host Agent와 agent-kit을 올리고 그 호스트의 ~/.pi-desktop-agent로 대화한다.
 * SSH는 키 인증만 쓴다 (앱은 비밀번호를 묻거나 저장하지 않는다, Pi Desktop과 같음).
 */
export function HostSettings({ onError }: { onError: (message: string) => void }) {
  const [hosts, setHosts] = useState<HostView[]>();
  const [current, setCurrent] = useState<CurrentHost>();
  const [ssh, setSsh] = useState<SshHostConfig[]>([]);
  /** 편집 중인 SSH 호스트. previous가 있으면 그 호스트를 고친다 (이름도 바꿀 수 있다) */
  const [draft, setDraft] = useState<{ previous?: string; name: string; target: string; port: string }>();
  const [switching, setSwitching] = useState(false);

  const fail = (error: unknown) => onError(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(error));
  const load = async () => {
    const [h, c, s] = await Promise.all([window.piAgent.listHosts(), window.piAgent.currentHost(), window.piAgent.listSshHosts()]);
    setHosts(h);
    setCurrent(c);
    setSsh(s);
  };
  useEffect(() => void load().catch(fail), []);

  const choose = (hostId: string) => {
    setSwitching(true);
    // 바꾸면 메인이 다시 연결하고 화면을 새로 읽는다
    window.piAgent.setHost(hostId).catch((error: unknown) => {
      setSwitching(false);
      fail(error);
    });
  };

  return (
    <section className="card">
      <h3>호스트</h3>
      <p className="muted small-text">
        대화를 어느 컴퓨터에서 돌릴지 고릅니다. WSL·SSH를 고르면 그 호스트의 Pi로 대화하고, 대화·지난 대화·휴지통과 기억·작업·스킬·승인·사용량·웹 검색·네트워크 화면 모두 그 호스트의 것을
        씁니다. 스킬 폴더·mcp.json 열기는 이 PC에서만 됩니다.
      </p>
      {!hosts || !current ? (
        <p className="muted">읽는 중…</p>
      ) : (
        <div className="form-row">
          <select value={current.id} disabled={switching} onChange={(e) => choose(e.target.value)}>
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.label}
              </option>
            ))}
            {!hosts.some((h) => h.id === current.id) && <option value={current.id}>{current.id} (목록에 없음)</option>}
          </select>
          {switching && <span className="muted small-text">다시 연결하는 중…</span>}
        </div>
      )}

      <h4>SSH 호스트</h4>
      {ssh.length === 0 && <p className="muted small-text">등록한 SSH 호스트가 없습니다.</p>}
      <ul className="list">
        {ssh.map((h) => (
          <li key={h.name} className="row">
            <strong>{h.name}</strong>
            <span className="muted small-text grow">
              {h.target}
              {h.port ? `:${h.port}` : ""}
            </span>
            <button className="small" onClick={() => setDraft({ previous: h.name, name: h.name, target: h.target, port: h.port ? String(h.port) : "" })}>
              고치기
            </button>
            <button className="small" onClick={() => window.piAgent.removeSshHost(h.name).then(load).catch(fail)}>
              지우기
            </button>
          </li>
        ))}
      </ul>
      {draft ? (
        <div className="form-row">
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="이름 (예: devbox)" />
          <input className="grow" value={draft.target} onChange={(e) => setDraft({ ...draft, target: e.target.value })} placeholder="user@host 또는 ~/.ssh/config의 Host" />
          <input value={draft.port} onChange={(e) => setDraft({ ...draft, port: e.target.value.replace(/\D/g, "") })} placeholder="포트" size={6} />
          <button
            className="small primary"
            onClick={() => {
              const host: SshHostConfig = { name: draft.name, target: draft.target, ...(draft.port ? { port: Number(draft.port) } : {}) };
              window.piAgent
                .saveSshHost(host, draft.previous)
                .then(async () => {
                  setDraft(undefined);
                  await load();
                })
                .catch(fail);
            }}
          >
            저장
          </button>
          <button className="small link-button" onClick={() => setDraft(undefined)}>
            취소
          </button>
        </div>
      ) : (
        <button className="small" onClick={() => setDraft({ name: "", target: "", port: "" })}>
          + SSH 호스트
        </button>
      )}
      <p className="muted small-text">키 인증만 씁니다. 서버에 Node.js 22 이상과 Pi가 있어야 합니다.</p>
    </section>
  );
}
