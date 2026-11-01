import { useEffect, useState } from "react";
import { UsageView } from "./UsageView";

/** 사용량 (Pi 세션 폴더의 대화: Pi Desktop·TUI). Pi Desktop Agent의 사용량 화면과 같은 집계 */
export function UsagePanel({ hostId, hostLabel, onClose }: { hostId: string; hostLabel: string; onClose: () => void }) {
  const [error, setError] = useState<string>();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal usage-modal" role="dialog" aria-label="사용량" onMouseDown={(e) => e.stopPropagation()}>
        <header className="pi-manager-head">
          <h2 className="modal-title">사용량</h2>
          <button type="button" onClick={onClose}>
            닫기
          </button>
        </header>
        <p className="muted usage-note">{hostLabel}의 Pi 세션 폴더에 남은 모든 대화(Pi Desktop·TUI)의 토큰과 비용입니다.</p>
        {error && <p className="sidebar-error">{error}</p>}
        <UsageView
          load={(range) => {
            setError(undefined);
            return window.piDesktop.usageSummary(hostId, range);
          }}
          onError={setError}
        />
      </div>
    </div>
  );
}
