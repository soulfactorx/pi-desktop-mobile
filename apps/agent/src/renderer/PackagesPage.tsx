import { useImports, usePackages } from "@pi-desktop/pi-resources/react";

/**
 * 확장 (Pi 패키지)과 다른 앱에서 가져오기 (설계 DESIGN-APPS.md §3.5). 패키지는 앱 홈(~/.pi-desktop-agent)에 설치되고
 * 새 대화부터 올라간다. Pi Desktop·Mate의 패키지와는 따로다. 다른 앱에 있는 스킬·패키지는 복사해서 가져온다.
 * 상태와 동작은 세 앱이 함께 쓰는 pi-resources의 것이고, 여기서는 모양만 그린다.
 */
export function PackagesPage({ onError }: { onError: (message: string) => void }) {
  const run = (action: () => Promise<void>) =>
    void action().catch((error: unknown) => onError(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(error)));
  const pkgs = usePackages(
    { list: () => window.piAgent.packagesList(), install: (s) => window.piAgent.packageInstall(s), remove: (s) => window.piAgent.packageRemove(s) },
    run,
  );
  const imports = useImports(
    { list: () => window.piAgent.importList(), importSkill: (from, name) => window.piAgent.importSkill(from, name), installPackage: (s) => window.piAgent.packageInstall(s) },
    run,
    pkgs.refresh,
  );

  return (
    <div className="page">
      <header className="page-head">
        <h2>확장</h2>
        <span className="muted">Pi 패키지(확장·스킬·프롬프트 묶음)를 이 앱에 설치합니다. Pi Desktop·Mate에 설치한 것과는 따로입니다</span>
      </header>
      <div className="page-body">
        {pkgs.changed && <p className="notice-line small-text">바꾼 확장은 새 대화부터 적용됩니다. 열린 대화는 닫고 다시 여세요.</p>}

        <section className="card">
          <h3>패키지 설치</h3>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              pkgs.install();
            }}
          >
            <input
              className="grow"
              value={pkgs.source}
              onChange={(e) => pkgs.setSource(e.target.value)}
              placeholder="npm 패키지 이름 (예: pi-web-access) 또는 npm:·git:·https 주소"
              enterKeyHint="go"
            />
            <button className="small primary" type="submit" disabled={!pkgs.source.trim() || Boolean(pkgs.busy)}>
              설치
            </button>
          </form>
          <p className="muted small-text">패키지는 코드를 실행합니다. 믿을 수 있는 것만 설치하세요. 설치에는 몇 분이 걸릴 수 있습니다.</p>
          {pkgs.busy && <p className="small-text">{pkgs.busy} 중…</p>}
          {pkgs.result && (
            <>
              <p className={pkgs.result.ok ? "small-text" : "small-text error-text"}>
                {pkgs.result.action} {pkgs.result.ok ? "완료" : "실패"}
              </p>
              {!pkgs.result.ok && <pre className="mcp-output">{pkgs.result.output.slice(-2000) || "(출력 없음)"}</pre>}
            </>
          )}
        </section>

        <section className="card">
          <h3>설치된 패키지</h3>
          {!pkgs.packages ? (
            <p className="muted">읽는 중…</p>
          ) : pkgs.packages.length === 0 ? (
            <p className="muted">아직 설치한 패키지가 없습니다.</p>
          ) : (
            <ul className="list">
              {pkgs.packages.map((p) => (
                <li key={p.source}>
                  <div className="grow">
                    <strong>{p.name}</strong>
                    <div className="muted small-text mcp-target" title={p.path ?? ""}>
                      {p.source}
                      {!p.path && " · 설치 폴더를 찾지 못함 (다시 설치해 보세요)"}
                    </div>
                  </div>
                  <button className="small" disabled={Boolean(pkgs.busy)} onClick={() => pkgs.remove(p.source, `${p.name} 패키지를 지울까요?`)}>
                    지우기
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <div className="row">
            <h3 className="grow">다른 앱에서 가져오기</h3>
            <button className="small" disabled={Boolean(imports.busy)} onClick={imports.load}>
              {imports.items ? "다시 읽기" : "목록 보기"}
            </button>
          </div>
          <p className="muted small-text">Pi Desktop·Mate의 스킬은 이 앱으로 복사하고, 패키지는 같은 것을 이 앱에 새로 설치합니다. MCP 서버는 토큰이 섞이지 않게 웹 검색·MCP 화면에서 새로 넣으세요.</p>
          {imports.busy && <p className="small-text">{imports.busy} 가져오는 중…</p>}
          {imports.message && <p className="small-text">{imports.message}</p>}
          {imports.items && (
            <>
              <h4>스킬</h4>
              {imports.items.skills.length === 0 ? (
                <p className="muted small-text">가져올 스킬이 없습니다.</p>
              ) : (
                <ul className="list">
                  {imports.items.skills.map((s) => (
                    <li key={`${s.from}:${s.name}`}>
                      <div className="grow">
                        <strong>{s.name}</strong> <span className="badge">{s.fromLabel}</span>
                        <div className="muted small-text">{s.description}</div>
                      </div>
                      <button className="small" disabled={s.exists || Boolean(imports.busy)} onClick={() => imports.importSkill(s.from, s.name)}>
                        {s.exists ? "있음" : "가져오기"}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <h4>패키지</h4>
              {imports.items.packages.length === 0 ? (
                <p className="muted small-text">가져올 패키지가 없습니다.</p>
              ) : (
                <ul className="list">
                  {imports.items.packages.map((p) => (
                    <li key={`${p.from}:${p.source}`}>
                      <div className="grow">
                        <strong>{p.name}</strong> <span className="badge">{p.fromLabel}</span>
                        <div className="muted small-text">{p.source}</div>
                      </div>
                      <button className="small" disabled={p.exists || Boolean(imports.busy)} onClick={() => imports.importPackage(p.source)}>
                        {p.exists ? "있음" : "설치"}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
