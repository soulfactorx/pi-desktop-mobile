import { useEffect, useState } from "react";
import type { CurrentHost, HostView, SshHostConfig } from "../shared/api";
import type { Act } from "./App";

/**
 * 호스트 고르기 (설계 DESIGN-MATE-REMOTE.md §3.1). Mate는 한 번에 한 호스트(로컬·WSL·SSH)의 실행기에 붙는다.
 * 원격을 고르면 그 호스트에 실행기와 mate-kit을 올리고, 임무·인박스·대화가 그 호스트에서 돈다.
 * 앞 호스트의 실행기는 그대로 두면 임무가 두 곳에서 같이 돌 수 있어 기본으로 멈춘다.
 */
export function HostSettings({ act }: { act: Act }) {
  const [hosts, setHosts] = useState<HostView[]>();
  const [current, setCurrent] = useState<CurrentHost>();
  const [ssh, setSsh] = useState<SshHostConfig[]>([]);
  const [stopPrevious, setStopPrevious] = useState(true);
  const [draft, setDraft] = useState<{ previous?: string; name: string; target: string; port: string }>();
  const [switching, setSwitching] = useState(false);

  const load = async () => {
    const [h, c, s] = await Promise.all([window.mate.listHosts(), window.mate.currentHost(), window.mate.listSshHosts()]);
    setHosts(h);
    setCurrent(c);
    setSsh(s);
  };
  useEffect(() => void act(load), []);

  return (
    <>
      <h2>호스트</h2>
      <div className="muted small-text">
        Mate 실행기를 어느 컴퓨터에서 돌릴지 고릅니다. WSL·SSH를 고르면 임무·인박스·대화·활동 관찰이 그 호스트에서 돌고, 앱을 닫거나 이 PC를 꺼도 그 호스트에서
        계속 돕니다. 그 호스트에 Node.js 22 이상과 Pi가 있어야 합니다.
      </div>
      {hosts && current && (
        <div className="row">
          <select
            value={current.id}
            disabled={switching}
            onChange={(e) => {
              const next = e.target.value;
              setSwitching(true);
              void act(() => window.mate.setHost(next, stopPrevious)).then((ok) => {
                if (!ok) setSwitching(false);
              });
            }}
          >
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.label}
              </option>
            ))}
            {!hosts.some((h) => h.id === current.id) && <option value={current.id}>{current.id} (목록에 없음)</option>}
          </select>
          <label className="inline small-text" title="앞 호스트의 실행기를 그대로 두면 그 호스트의 임무도 계속 돈다">
            <input type="checkbox" checked={stopPrevious} onChange={(e) => setStopPrevious(e.target.checked)} /> 바꿀 때 지금 호스트의 실행기 멈추기
          </label>
          {switching && <span className="muted small-text">다시 연결하는 중…</span>}
        </div>
      )}
      {current?.remote && current.home && <div className="muted small-text">그 호스트의 Mate 데이터: {current.home}</div>}

      <h3>SSH 호스트</h3>
      {ssh.length === 0 && <div className="muted small-text">등록한 SSH 호스트가 없습니다.</div>}
      {ssh.map((h) => (
        <div key={h.name} className="row">
          <strong>{h.name}</strong>
          <span className="muted small-text grow">
            {h.target}
            {h.port ? `:${h.port}` : ""}
          </span>
          <button className="small" onClick={() => setDraft({ previous: h.name, name: h.name, target: h.target, port: h.port ? String(h.port) : "" })}>
            고치기
          </button>
          <button className="small" onClick={() => void act(async () => (await window.mate.removeSshHost(h.name), await load()))}>
            지우기
          </button>
        </div>
      ))}
      {draft ? (
        <div className="row">
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="이름 (예: devbox)" />
          <input className="grow" value={draft.target} onChange={(e) => setDraft({ ...draft, target: e.target.value })} placeholder="user@host 또는 ~/.ssh/config의 Host" />
          <input value={draft.port} size={6} onChange={(e) => setDraft({ ...draft, port: e.target.value.replace(/\D/g, "") })} placeholder="포트" />
          <button
            className="small primary"
            onClick={() =>
              void act(async () => {
                await window.mate.saveSshHost({ name: draft.name, target: draft.target, ...(draft.port ? { port: Number(draft.port) } : {}) }, draft.previous);
                setDraft(undefined);
                await load();
              })
            }
          >
            저장
          </button>
          <button className="small" onClick={() => setDraft(undefined)}>
            취소
          </button>
        </div>
      ) : (
        <button className="small" onClick={() => setDraft({ name: "", target: "", port: "" })}>
          + SSH 호스트
        </button>
      )}
      <div className="muted small-text">SSH는 키 인증만 씁니다 (앱은 비밀번호를 묻거나 저장하지 않습니다).</div>
    </>
  );
}
