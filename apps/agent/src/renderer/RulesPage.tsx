import { useEffect, useState } from "react";
import type { AuditView, RuleView } from "../shared/api";

const DECISION_LABEL: Record<string, string> = {
  "allow-rule": "규칙으로 허용",
  "deny-rule": "규칙으로 거부",
  "session-rule": "세션 허용",
  once: "이번만 허용",
  session: "세션 허용",
  always: "항상 허용",
  deny: "거부",
  "repeat-deny": "같은 호출 다시 거부",
  blocked: "위험 명령 차단",
  unattended: "사람 없음 → 거부",
};

/**
 * 승인 규칙과 기록 (설계 DESIGN-AGENT.md §4 "승인 게이트").
 * "항상 허용"으로 저장한 규칙을 보고 지우며, 최근 승인 판단을 확인한다.
 */
export function RulesPage({ onError }: { onError: (message: string) => void }) {
  const [rules, setRules] = useState<RuleView[]>([]);
  const [audit, setAudit] = useState<AuditView[]>([]);

  const run = (action: () => Promise<void>) =>
    action().catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)));
  const refresh = async () => {
    const [nextRules, nextAudit] = await Promise.all([window.piAgent.listRules(), window.piAgent.listAudit()]);
    setRules(nextRules);
    setAudit(nextAudit);
  };

  useEffect(() => void run(refresh), []);

  return (
    <div className="page">
      <header className="page-head">
        <h2>승인</h2>
        <span className="muted">파일 쓰기·명령 실행·웹 요청은 실행 전에 묻습니다. "항상 허용"한 것은 아래 규칙으로 남습니다.</span>
      </header>
      <div className="page-body">
        <h3>저장된 규칙</h3>
        {rules.length === 0 ? (
          <p className="muted">저장된 규칙이 없습니다. 승인 창에서 "항상 허용"을 고르면 생깁니다.</p>
        ) : (
          <ul className="list">
            {rules.map((rule) => (
              <li key={`${rule.toolName}|${rule.pattern}|${rule.action}`}>
                <span className={`tag ${rule.action === "allow" ? "allow" : "deny"}`}>{rule.action === "allow" ? "허용" : "거부"}</span>
                <code>{rule.toolName}</code>
                <span className="grow mono">{rule.pattern}</span>
                <button className="small" onClick={() => run(async () => (await window.piAgent.removeRule(rule), await refresh()))}>
                  지우기
                </button>
              </li>
            ))}
          </ul>
        )}

        <h3>최근 판단</h3>
        {audit.length === 0 ? (
          <p className="muted">아직 기록이 없습니다.</p>
        ) : (
          <ul className="list compact">
            {audit.map((a, i) => (
              <li key={`${a.at}-${i}`}>
                <span className="muted small-text">{new Date(a.at).toLocaleString()}</span>
                <span className={`tag ${/deny|blocked|unattended/.test(a.decision) ? "deny" : "allow"}`}>{DECISION_LABEL[a.decision] ?? a.decision}</span>
                <code>{a.toolName}</code>
                <span className="grow mono ellipsis" title={a.target}>
                  {a.target}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
