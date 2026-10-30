import { useEffect, useState } from "react";
import { piSetupIssues, type PiSetupView } from "../shared/pi-setup";

const NPM_INSTALL = "npm install -g @earendil-works/pi-coding-agent";

/**
 * Pi 준비 안내 (설계 DESIGN-AGENT.md §0 "Pi 관리"). 문제가 없으면 아무것도 그리지 않는다.
 * 에이전트는 Pi 설치·로그인·프로바이더·모델 관리 화면을 두지 않고, Pi Desktop을 열거나 설치하게 돕는다 (Mate와 같은 방식).
 */
export function PiSetupBanner({ setup, onRefresh, onError }: { setup: PiSetupView; onRefresh: () => void; onError: (message: string) => void }) {
  const issues = piSetupIssues(setup);
  if (issues.length === 0) return null;
  return (
    <div className="setup-banner">
      {issues.map((issue) => (
        <div key={issue.kind} className={`setup-issue ${issue.level}`}>
          <strong>{issue.title}</strong>
          <span className="muted">{issue.detail}</span>
          {(issue.kind === "no-pi" || issue.kind === "no-models") && <PiDesktopButton setup={setup} onError={onError} />}
          {issue.kind === "no-pi" && (
            <code className="copy" title="눌러서 복사" onClick={() => void navigator.clipboard.writeText(NPM_INSTALL)}>
              {NPM_INSTALL}
            </code>
          )}
          {issue.kind === "git-bash" && (
            <a href="https://git-scm.com/download/win" target="_blank" rel="noreferrer">
              Git for Windows 내려받기
            </a>
          )}
        </div>
      ))}
      <button className="small" onClick={onRefresh}>
        다시 확인
      </button>
    </div>
  );
}

/** Pi Desktop이 있으면 열고, 없으면 내려받아 설치한다 */
export function PiDesktopButton({ setup, onError }: { setup: PiSetupView; onError: (message: string) => void }) {
  const [progress, setProgress] = useState<string>();
  useEffect(
    () => window.piAgent.onInstallProgress((received, total) => setProgress(`내려받는 중 ${Math.round((received / Math.max(1, total)) * 100)}%`)),
    [],
  );
  const run = (action: () => Promise<void>) =>
    action().catch((error: unknown) => {
      setProgress(undefined);
      onError(error instanceof Error ? error.message : String(error));
    });

  if (setup.piDesktopPath) {
    return (
      <button className="small primary" onClick={() => run(async () => void (await window.piAgent.openPiDesktop()))}>
        Pi Desktop 열기
      </button>
    );
  }
  return (
    <span className="row">
      <button
        className="small primary"
        onClick={() =>
          run(async () => {
            setProgress("릴리스 확인 중…");
            const result = await window.piAgent.installPiDesktop();
            setProgress(result.status === "opened" ? "설치 프로그램을 열었습니다. 설치 후 Pi를 설치·로그인하고 \"다시 확인\"을 누르세요" : undefined);
          })
        }
      >
        Pi Desktop 설치
      </button>
      {progress && <span className="muted">{progress}</span>}
    </span>
  );
}
