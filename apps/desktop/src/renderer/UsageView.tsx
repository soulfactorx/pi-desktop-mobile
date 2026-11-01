import { useEffect, useState } from "react";
import type { UsageRange, UsageSource, UsageSummary, UsageTotals } from "@pi-desktop/agent-kit/usage-types";

/*
 * 사용량 통계 화면 (Pi Desktop Agent의 사용량 화면과 같은 모양). Pi Desktop과 Mate가 복사해 쓴다.
 * 데이터는 앱마다 다르다 (Pi Desktop: Pi 세션 폴더, Mate: Mate 대화·임무 실행 세션). 집계는 agent-kit usage.ts.
 */

const RANGES: Array<{ id: UsageRange; label: string }> = [
  { id: "today", label: "오늘" },
  { id: "7d", label: "7일" },
  { id: "30d", label: "30일" },
  { id: "12m", label: "12개월" },
];

const tokens = (t: UsageTotals) => t.input + t.output + t.cacheRead + t.cacheWrite;
const count = (n: number) => n.toLocaleString();
/** 큰 수는 짧게 (1.2만, 3.4억) */
function short(n: number): string {
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)}억`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)}만`;
  return count(n);
}
const dollars = (n: number) => (n === 0 ? "$0" : n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);

export function UsageView({
  load,
  onError,
  sourceLabels,
}: {
  load: (range: UsageRange) => Promise<UsageSummary>;
  onError: (message: string) => void;
  /** 쓰임새 이름. 없으면 쓰임새별 표를 그리지 않는다 */
  sourceLabels?: Partial<Record<UsageSource, string>>;
}) {
  const [range, setRange] = useState<UsageRange>("7d");
  const [summary, setSummary] = useState<UsageSummary>();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    load(range)
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
    <div className="usage-view">
      <div className="usage-ranges" role="tablist">
        {RANGES.map((r) => (
          <button key={r.id} role="tab" aria-selected={range === r.id} className={range === r.id ? "primary small" : "small"} onClick={() => setRange(r.id)}>
            {r.label}
          </button>
        ))}
        {loading && <span className="muted usage-note">읽는 중…</span>}
      </div>

      {summary && (
        <>
          <div className="usage-tiles">
            <div className="usage-tile">
              <div className="muted usage-note">총 토큰</div>
              <strong>{short(tokens(summary.total))}</strong>
            </div>
            <div className="usage-tile" title={`캐시 읽기 ${count(summary.total.cacheRead)} · 캐시 쓰기 ${count(summary.total.cacheWrite)} 포함`}>
              <div className="muted usage-note">입력 (캐시 포함)</div>
              <strong>{short(summary.total.input + summary.total.cacheRead + summary.total.cacheWrite)}</strong>
            </div>
            <div className="usage-tile">
              <div className="muted usage-note">출력</div>
              <strong>{short(summary.total.output)}</strong>
            </div>
            <div className="usage-tile" title="Pi가 아는 가격으로 계산한 값. 로컬 모델은 0">
              <div className="muted usage-note">비용 (추정)</div>
              <strong>{dollars(summary.total.cost)}</strong>
            </div>
            <div className="usage-tile">
              <div className="muted usage-note">모델 호출</div>
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
                    <div className="usage-x muted usage-note">{i % labelEvery === 0 ? b.label : ""}</div>
                  </div>
                ))}
              </div>

              <div className="usage-tables">
                <UsageTable title="모델별" rows={summary.models.map((m) => ({ key: m.name, label: m.name, totals: m }))} />
                {sourceLabels && (
                  <UsageTable
                    title="쓰임새별"
                    rows={summary.sources.map((s) => ({ key: s.source, label: sourceLabels[s.source] ?? s.source, totals: s }))}
                  />
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function UsageTable({ title, rows }: { title: string; rows: Array<{ key: string; label: string; totals: UsageTotals }> }) {
  return (
    <section className="usage-card">
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
