import { useEffect, useState } from "react";
import { WEB_SEARCH_PRESETS, type McpCheckResult, type McpServerView } from "@pi-desktop/pi-isolation/mcp-presets";

/**
 * 웹 검색·MCP (설계 DESIGN-AGENT.md §4 "웹 페이지 읽기, 웹 검색"). 앱 홈의 MCP 설정(mcp.json)을 보여 주고,
 * 웹 검색 서버를 골라 넣거나 켜고 끈다. 바꾼 설정은 새 대화부터 적용된다(열린 대화는 Pi를 다시 띄워야 함).
 * 연결 확인은 `pi mcp list`로 한다.
 */
export function McpPage({ onError }: { onError: (message: string) => void }) {
  const [servers, setServers] = useState<McpServerView[]>();
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [check, setCheck] = useState<McpCheckResult>();
  const [checking, setChecking] = useState(false);
  const [changed, setChanged] = useState(false);

  const run = (action: () => Promise<void>) => action().catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)));
  const apply = (next: McpServerView[]) => {
    setServers(next);
    setChanged(true);
    setCheck(undefined);
  };

  useEffect(() => void run(async () => setServers(await window.piAgent.listMcp())), []);

  return (
    <div className="page">
      <header className="page-head">
        <h2>웹 검색·MCP</h2>
        <span className="muted">이 앱의 MCP 서버 설정(mcp.json). 웹 검색은 검색 서버를 하나 넣으면 에이전트가 씁니다</span>
      </header>
      <div className="page-body">
        {changed && <p className="notice-line small-text">바꾼 설정은 새 대화부터 적용됩니다. 열린 대화는 닫고 다시 여세요.</p>}

        <section className="card">
          <h3>웹 검색 서버 넣기</h3>
          <ul className="list">
            {WEB_SEARCH_PRESETS.map((preset) => {
              const added = servers?.some((s) => s.name === preset.name);
              return (
                <li key={preset.id} className="mcp-preset">
                  <div className="grow">
                    <strong>{preset.label}</strong>
                    <div className="muted small-text">{preset.detail}</div>
                  </div>
                  {preset.keyEnv && !added && (
                    <input
                      type="password"
                      className="mcp-key"
                      placeholder={`${preset.keyEnv}`}
                      value={keys[preset.id] ?? ""}
                      onChange={(e) => setKeys((prev) => ({ ...prev, [preset.id]: e.target.value }))}
                    />
                  )}
                  {preset.keyUrl && !added && (
                    <button className="small link-button" onClick={() => window.open(preset.keyUrl, "_blank")}>
                      키 받기
                    </button>
                  )}
                  <button
                    className={added ? "small" : "small primary"}
                    disabled={added || (!!preset.keyEnv && !keys[preset.id]?.trim())}
                    onClick={() =>
                      run(async () => {
                        apply(await window.piAgent.addMcpPreset(preset.id, keys[preset.id]));
                        setKeys((prev) => ({ ...prev, [preset.id]: "" }));
                      })
                    }
                  >
                    {added ? "넣음" : "넣기"}
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="muted small-text">API 키는 앱 폴더(~/.pi-desktop-agent)의 mcp.json에 저장됩니다. 화면에는 다시 보이지 않습니다.</p>
        </section>

        <section className="card">
          <div className="row">
            <h3 className="grow">설정된 서버</h3>
            <button className="small" onClick={() => void window.piAgent.openMcpFile()} title="다른 MCP 서버는 mcp.json을 직접 고치거나 pi mcp add로 넣습니다">
              mcp.json 열기
            </button>
            <button
              className="small"
              disabled={checking || !servers?.length}
              onClick={() =>
                run(async () => {
                  setChecking(true);
                  try {
                    setCheck(await window.piAgent.checkMcp());
                  } finally {
                    setChecking(false);
                  }
                })
              }
            >
              {checking ? "확인 중…" : "연결 확인"}
            </button>
          </div>
          {!servers ? (
            <p className="muted">읽는 중…</p>
          ) : servers.length === 0 ? (
            <p className="muted">아직 MCP 서버가 없습니다. 위에서 웹 검색 서버를 넣어 보세요.</p>
          ) : (
            <ul className="list">
              {servers.map((s) => (
                <li key={s.name}>
                  <label className="check-row mcp-toggle" title={s.enabled ? "끄기" : "켜기"}>
                    <input
                      type="checkbox"
                      checked={s.enabled}
                      onChange={(e) => {
                        const on = e.target.checked;
                        run(async () => apply(await window.piAgent.setMcpEnabled(s.name, on)));
                      }}
                    />
                  </label>
                  <div className="grow">
                    <strong className={s.enabled ? "" : "muted"}>{s.name}</strong>
                    {s.hasSecrets && <span className="badge">키 있음</span>}
                    <div className="muted small-text mcp-target" title={s.target}>
                      {s.kind === "url" ? "🌐 " : "▶ "}
                      {s.target}
                    </div>
                    {s.description && <div className="muted small-text">{s.description}</div>}
                  </div>
                  <button className="small" onClick={() => run(async () => apply(await window.piAgent.removeMcp(s.name)))}>
                    빼기
                  </button>
                </li>
              ))}
            </ul>
          )}
          {check && (
            <>
              <p className={check.ok ? "small-text" : "small-text error-text"}>{check.ok ? "모든 서버에 연결됩니다." : "연결되지 않는 서버가 있습니다."}</p>
              <pre className="mcp-output">{check.output.trim() || "(출력 없음)"}</pre>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
