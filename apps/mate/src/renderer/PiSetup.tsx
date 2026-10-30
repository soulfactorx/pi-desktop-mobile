import { useEffect, useState } from "react";
import type { PiSetupView } from "../shared/api";
import type { Act } from "./App";
import { piSetupIssues } from "./mate-view";

/**
 * Pi 준비 안내 (설계 DESIGN-MATE.md §9).
 * Mate는 Pi 설치·로그인 화면을 따로 두지 않고, Pi Desktop을 쉽게 설치·열 수 있게 돕는다.
 */
export function PiSetupBanner({
  setup,
  model,
  act,
  onRefresh,
  onUsePiDefault,
}: {
  setup: PiSetupView;
  model: string;
  act: Act;
  onRefresh: () => void;
  onUsePiDefault: () => void;
}) {
  const [progress, setProgress] = useState<string>();
  useEffect(
    () =>
      window.mate.onInstallProgress((received, total) =>
        setProgress(`내려받는 중 ${Math.round((received / Math.max(1, total)) * 100)}%`),
      ),
    [],
  );
  const issues = piSetupIssues(setup, model);
  if (issues.length === 0) return null;

  const installOrOpen = setup.piDesktopPath ? (
    <button className="small primary" onClick={() => void act(() => window.mate.openPiDesktop())}>
      Pi Desktop 열기
    </button>
  ) : (
    <button
      className="small primary"
      onClick={() =>
        void act(async () => {
          setProgress("릴리스 확인 중…");
          try {
            const result = await window.mate.installPiDesktop();
            setProgress(result.status === "opened" ? "설치 프로그램을 열었습니다. 설치 후 Pi를 설치·로그인하고 \"다시 확인\"을 누르세요" : undefined);
          } catch (error) {
            setProgress(undefined);
            throw error;
          }
        })
      }
    >
      Pi Desktop 설치
    </button>
  );

  return (
    <div className="setup-banner">
      {issues.map((issue) => (
        <div key={issue.kind} className={`setup-issue ${issue.level}`}>
          <strong>{issue.title}</strong>
          <span className="muted">{issue.detail}</span>
          <div className="row">
            {(issue.kind === "no-pi" || issue.kind === "no-models") && installOrOpen}
            {issue.kind === "git-bash" && (
              <a className="small-link" href="https://git-scm.com/download/win" target="_blank" rel="noreferrer">
                Git for Windows 내려받기
              </a>
            )}
            {issue.kind === "model" && setup.piDefaultModel && (
              <button className="small" onClick={onUsePiDefault}>
                Pi 기본 모델({setup.piDefaultModel})로 바꾸기
              </button>
            )}
            {issue.kind === "no-pi" && (
              <code className="copy" title="눌러서 복사" onClick={() => void navigator.clipboard.writeText(NPM_INSTALL)}>
                {NPM_INSTALL}
              </code>
            )}
          </div>
        </div>
      ))}
      <div className="row">
        {progress && <span className="muted small-text">{progress}</span>}
        <button className="small" onClick={onRefresh}>
          다시 확인
        </button>
      </div>
    </div>
  );
}

const NPM_INSTALL = "npm install -g @earendil-works/pi-coding-agent";

const INHERIT = "__inherit__";
const CUSTOM = "__custom__";

/**
 * 모델 고르기: 첫 항목은 "따르기"(value가 비어 있음), 그 아래 Pi에서 쓸 수 있는 모델(프로바이더별), 마지막에 직접 입력.
 * 목록에 없는 값이 들어 있으면 직접 입력 칸을 보인다.
 */
export function ModelSelect({
  value,
  onChange,
  setup,
  inheritLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  setup: PiSetupView | undefined;
  inheritLabel: string;
}) {
  const models = setup?.models ?? [];
  const known = models.some((m) => `${m.provider}/${m.id}` === value);
  const [custom, setCustom] = useState(!!value && !known && models.length > 0);
  // 직접 입력을 골랐으면 값이 비어 있어도 입력 칸을 보인다
  const selected = custom ? CUSTOM : !value ? INHERIT : known ? value : CUSTOM;
  const providers = [...new Set(models.map((m) => m.provider))];
  return (
    <div className="row">
      <select
        value={selected}
        onChange={(e) => {
          const next = e.target.value;
          if (next === CUSTOM) return setCustom(true);
          setCustom(false);
          onChange(next === INHERIT ? "" : next);
        }}
      >
        <option value={INHERIT}>{inheritLabel}</option>
        {providers.map((provider) => (
          <optgroup key={provider} label={provider}>
            {models
              .filter((m) => m.provider === provider)
              .map((m) => (
                <option key={m.id} value={`${m.provider}/${m.id}`}>
                  {m.id}
                </option>
              ))}
          </optgroup>
        ))}
        <option value={CUSTOM}>직접 입력…</option>
      </select>
      {selected === CUSTOM && (
        <input className="grow" value={value} onChange={(e) => onChange(e.target.value.trim())} placeholder="provider/model-id" autoFocus={custom} />
      )}
      {!setup && <span className="muted small-text">모델 목록을 불러오는 중…</span>}
    </div>
  );
}
