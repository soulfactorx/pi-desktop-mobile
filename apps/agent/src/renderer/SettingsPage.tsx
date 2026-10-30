import { useEffect, useState } from "react";
import type { UpdateState } from "../shared/api";
import { piSetupIssues, type PiSetupView } from "../shared/pi-setup";
import { PiDesktopButton } from "./PiSetupBanner";
import { HostSettings } from "./HostSettings";

/**
 * 설정 (설계 DESIGN-AGENT.md §0 "Pi 관리").
 * Pi 설치·로그인·프로바이더·모델 같은 Pi 관리는 Pi Desktop에서 한다. 여기서는 상태를 보여 주고 Pi Desktop으로 보낸다.
 * API 키도 Pi Desktop에서 넣는다 (auth.json). 에이전트는 따로 키를 받지 않는다.
 */
export function SettingsPage({
  setup,
  update,
  onRefresh,
  onError,
}: {
  setup?: PiSetupView;
  update?: UpdateState;
  onRefresh: () => void;
  onError: (message: string) => void;
}) {
  const issues = setup ? piSetupIssues(setup) : [];
  const [elevation, setElevation] = useState<boolean>();
  useEffect(() => {
    window.piAgent.getElevation().then(setElevation, (error: unknown) => onError(String(error)));
  }, []);
  return (
    <div className="page">
      <header className="page-head">
        <h2>설정</h2>
      </header>
      <div className="page-body">
        <HostSettings onError={onError} />
        <section className="card">
          <h3>Pi</h3>
          <p className="muted">
            Pi 설치·업데이트, <strong>프로바이더 로그인·API 키, 모델 관리는 Pi Desktop</strong>에서 합니다. 에이전트는 Pi Desktop이 저장한 Pi
            설정을 그대로 씁니다. 대화 화면에서 바꾼 모델은 그 대화에만 적용됩니다.
          </p>
          {setup ? (
            <dl className="facts">
              <dt>Pi</dt>
              <dd>{setup.piVersion ? `설치됨 (${setup.piVersion})` : `없음${setup.piError ? ` — ${setup.piError}` : ""}`}</dd>
              <dt>Node.js</dt>
              <dd>
                {setup.node.version ?? "알 수 없음"} {setup.node.ok ? "" : `(필요: ${setup.node.required ?? "22.19 이상"})`}
              </dd>
              <dt>로그인한 프로바이더</dt>
              <dd>{setup.authProviders.length > 0 ? setup.authProviders.join(", ") : "없음"}</dd>
              <dt>쓸 수 있는 모델</dt>
              <dd>{setup.models.length > 0 ? `${setup.models.length}개` : "없음"}</dd>
              {setup.platform === "win32" && setup.gitBash && (
                <>
                  <dt>Git Bash</dt>
                  <dd>{setup.gitBash.found ? "있음" : "없음 (명령 실행에 필요)"}</dd>
                </>
              )}
              <dt>Pi Desktop</dt>
              <dd>{setup.piDesktopPath ? "설치됨" : "설치되지 않음"}</dd>
            </dl>
          ) : (
            <p className="muted">Pi 상태를 읽는 중…</p>
          )}
          <div className="row">
            {setup && <PiDesktopButton setup={setup} onError={onError} />}
            <button className="small" onClick={onRefresh}>
              다시 확인
            </button>
            {issues.length === 0 && setup && <span className="badge ok">준비됨</span>}
          </div>
        </section>

        <section className="card">
          <h3>관리자 권한 실행</h3>
          <label className="check-row">
            <input
              type="checkbox"
              checked={elevation ?? false}
              disabled={elevation === undefined}
              onChange={(e) => {
                const on = e.target.checked;
                window.piAgent.setElevation(on).then(
                  () => setElevation(on),
                  (error: unknown) => onError(String(error)),
                );
              }}
            />
            <span>에이전트가 관리자 권한이 필요한 작업을 요청할 수 있게 하기 (기본 꺼짐)</span>
          </label>
          <p className="muted small-text">
            켜면 사람이 지켜보는 대화에서만 shell_exec_elevated 도구가 보입니다. 부를 때마다 실행될 명령 그대로 승인을 받고(이번만 허용·거부),
            비밀번호는 OS 인증 창(Windows UAC 등)이 직접 받습니다. 예약·백그라운드 작업에서는 쓸 수 없습니다. 다음 요청부터 바로 적용됩니다.
          </p>
        </section>

        <section className="card">
          <h3>업데이트</h3>
          <p className="muted">
            앱을 켜고 20초 뒤와 6시간마다 새 버전을 확인합니다. 묻기 전에는 내려받거나 설치하지 않습니다.
            {update?.mode === "notify" && " 이 OS에서는 자동 설치가 되지 않아 새 버전을 알리고 릴리스 페이지를 엽니다."}
          </p>
          <div className="row">
            <span>지금 버전 {update?.current ?? "?"}</span>
            <span className="muted small-text">{updateText(update)}</span>
            <button className="small" disabled={update?.status === "checking"} onClick={() => void window.piAgent.checkForUpdates(true)}>
              업데이트 확인
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

function updateText(update: UpdateState | undefined): string {
  switch (update?.status) {
    case "disabled":
      return update.error ?? "업데이트를 확인하지 않는 실행";
    case "checking":
      return "확인 중…";
    case "none":
      return "최신 버전";
    case "available":
      return `새 버전 ${update.version}`;
    case "downloading":
      return `내려받는 중 ${update.percent ?? 0}%`;
    case "downloaded":
      return `${update.version} 내려받음 — 다시 시작하면 설치`;
    case "error":
      return `확인 실패: ${update.error ?? ""}`;
    default:
      return "";
  }
}
