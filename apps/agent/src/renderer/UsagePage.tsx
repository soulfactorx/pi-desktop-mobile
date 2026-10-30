import { useEffect, useState } from "react";
import type { UsageRange, UsageSource, UsageSummary, UsageTotals } from "../shared/api";

const RANGES: Array<{ id: UsageRange; label: string }> = [
  { id: "today", label: "오늘" },
  { id: "7d", label: "7일" },
  { id: "30d", label: "30일" },
  { id: "12m", label: "12개월" },
];

const SOURCE_LABEL: Record<UsageSource, string> = {
  chat: "대화",
  schedule: "예약",
  worker: "백그라운드 작업",
  memory: "기억 추출",
  document: "문서 처리",
  peer: "피어 질문에 답하기",
};

const tokens = (t: UsageTotals) => t.input + t.output + t.cacheRead + t.cacheWrite;
const count = (n: number) => n.toLocaleString();
/** 큰 수는 짧게 (1.2만, 3.4억) */
function short(n: number): string {
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)}억`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)}만`;
  return count(n);
}
const dollars = (n: number) => (n === 0 ? "$0" : n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);

/**
 * 사용량 (설계 DESIGN-AGENT.md §4 "사용량"). Pi 세션 파일의 사용량에, 세션에 남지 않는 호출
 * (기억 추출·문서 처리·백그라운드 작업)을 더해 보인다. 세션 폴더는 Pi Desktop·TUI와 같이 쓰므로 그 대화도 들어간다.
 */
export function UsagePage({ onError }: { onError: (message: string) => void }) {
  const [range, setRange] = useState<UsageRange>("7d");
  const [summary, setSummary] = useState<UsageSummary>();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    window.piAgent
      .usageSummary(range)
      .then((next) => alive && setSummary(next))
      .catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [range]);

  const max = Math.max(1, ...(summary?.buckets ?? []).map(tokens));
  const labelEvery = Math.max(1, Math.ceil((summary?.buckets.length ?? 1) / 12));

  return (
    <div className="page">
      <header className="page-head">
        <h2>사용량</h2>
        <span className="muted">Pi 세션 폴더의 모든 대화(Pi Desktop·TUI 포함)와 이 앱의 기억 추출·문서 처리·백그라운드 작업</span>
      </header>
      <div className="page-body">
        <div className="row usage-ranges" role="tablist">
          {RANGES.map((r) => (
            <button key={r.id} role="tab" aria-selected={range === r.id} className={range === r.id ? "primary small" : "small"} onClick={() => setRange(r.id)}>
              {r.label}
            </button>
          ))}
          {loading && <span className="muted small-text">읽는 중…</span>}
        </div>

        {summary && (
          <>
            <div className="usage-tiles">
              <div className="usage-tile">
                <div className="muted small-text">총 토큰</div>
                <strong>{short(tokens(summary.total))}</strong>
              </div>
              <div className="usage-tile" title={`캐시 읽기 ${count(summary.total.cacheRead)} · 캐시 쓰기 ${count(summary.total.cacheWrite)} 포함`}>
                <div className="muted small-text">입력 (캐시 포함)</div>
                <strong>{short(summary.total.input + summary.total.cacheRead + summary.total.cacheWrite)}</strong>
              </div>
              <div className="usage-tile">
                <div className="muted small-text">출력</div>
                <strong>{short(summary.total.output)}</strong>
              </div>
              <div className="usage-tile" title="Pi가 아는 가격으로 계산한 값. 로컬 모델은 0">
                <div className="muted small-text">비용 (추정)</div>
                <strong>{dollars(summary.total.cost)}</strong>
              </div>
              <div className="usage-tile">
                <div className="muted small-text">모델 호출</div>
                <strong>{count(summary.total.calls)}</strong>
              </div>
            </div>

            {summary.total.calls === 0 ? (
              <p className="muted">이 기간에 기록된 사용량이 없습니다.</p>
            ) : (
              <>
                <div className="usage-chart" role="img" aria-label="구간별 토큰 사용량 막대 차트 (아래 표에 같은 내용)">
                  {summary.buckets.map((b, i) => (
                    <div key={b.key} className="usage-col" title={`${b.label}: ${count(tokens(b))} 토큰 · ${dollars(b.cost)} · 호출 ${b.calls}`}>
                      <div className="usage-bar-area">
                        {tokens(b) > 0 && <div className="usage-bar" style={{ height: `${Math.max(2, (tokens(b) / max) * 100)}%` }} />}
                      </div>
                      <div className="usage-x muted small-text">{i % labelEvery === 0 ? b.label : ""}</div>
                    </div>
                  ))}
                </div>

                <div className="usage-tables">
                  <UsageTable title="모델별" rows={summary.models.map((m) => ({ key: m.name, label: m.name, totals: m }))} />
                  <UsageTable
                    title="쓰임새별"
                    rows={summary.sources.map((s) => ({ key: s.source, label: SOURCE_LABEL[s.source] ?? s.source, totals: s }))}
                  />
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function UsageTable({ title, rows }: { title: string; rows: Array<{ key: string; label: string; totals: UsageTotals }> }) {
  return (
    <section className="card">
      <h3>{title}</h3>
      <table className="usage-table">
        <thead>
          <tr>
            <th />
            <th>토큰</th>
            <th>출력</th>
            <th>호출</th>
            <th>비용</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td title={r.label}>{r.label}</td>
              <td>{count(tokens(r.totals))}</td>
              <td>{count(r.totals.output)}</td>
              <td>{count(r.totals.calls)}</td>
              <td>{dollars(r.totals.cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
