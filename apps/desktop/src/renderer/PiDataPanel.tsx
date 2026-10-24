import { useEffect, useState } from "react";
import type { DataBackupResult, PiStatus } from "@pi-desktop/host-protocol/messages";
import { formatBytes } from "./attachments";

/** 삭제를 확인하려고 사용자가 직접 입력해야 하는 낱말 */
export const DELETE_WORD = "삭제";

/**
 * Pi 관리 창의 데이터 영역 (설계 §4.9 "제거"의 데이터 처리).
 * 백업은 언제든, 삭제는 Pi를 제거한 뒤에만 된다 (관리형 설치는 Pi가 데이터 폴더 안에 있다).
 * 삭제는 두 번 확인한다: 버튼 → 낱말 직접 입력. 기본은 백업 후 삭제.
 */
export function PiDataPanel({ hostId, status, onChanged }: { hostId: string; status: PiStatus; onChanged: () => void }) {
  const [backup, setBackup] = useState<DataBackupResult | undefined>();
  const [busy, setBusy] = useState<"backup" | "delete" | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [deleting, setDeleting] = useState(false);
  const [typed, setTyped] = useState("");
  const [deleted, setDeleted] = useState(false);
  const data = status.data;

  useEffect(() => {
    setBackup(undefined);
    setDeleting(false);
    setTyped("");
    setError(undefined);
    setDeleted(false);
  }, [hostId]);

  async function runBackup(): Promise<DataBackupResult | undefined> {
    setBusy("backup");
    setError(undefined);
    try {
      const result = await window.piDesktop.dataBackup(hostId);
      setBackup(result);
      return result;
    } catch (e) {
      setError(`백업하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    } finally {
      setBusy(undefined);
    }
  }

  async function runDelete(withBackup: boolean) {
    if (withBackup && !(await runBackup())) return; // 백업에 실패하면 지우지 않는다
    setBusy("delete");
    setError(undefined);
    try {
      await window.piDesktop.dataDelete(hostId, data.agentDir);
      setDeleting(false);
      setTyped("");
      setDeleted(true);
      onChanged();
    } catch (e) {
      setError(`지우지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <section className="pi-install">
      <h3>데이터</h3>
      <div className="muted">
        {data.agentDir} {data.exists ? `· 세션 ${data.sessions.count}개 · ${formatBytes(data.sessions.bytes)}` : "· 없음"}
      </div>
      {data.exists && (
        <div className="install-steps">
          <button type="button" disabled={busy !== undefined} onClick={() => void runBackup()}>
            {busy === "backup" ? "백업 중…" : "백업"}
          </button>
          {!status.pi && (
            <button type="button" className="danger" disabled={busy !== undefined} onClick={() => setDeleting(true)}>
              데이터 삭제…
            </button>
          )}
          {status.pi && <span className="muted">데이터 삭제는 Pi를 제거한 뒤에 할 수 있습니다.</span>}
        </div>
      )}
      {backup && (
        <div className="install-steps">
          <span className="probe-ok">
            백업했습니다 ({formatBytes(backup.bytes)}): {backup.path}
          </span>
          {window.piDesktop.shell === "electron" && (
            <button type="button" className="small" onClick={() => void window.piDesktop.revealFile(hostId, "", backup.path)}>
              위치 열기
            </button>
          )}
        </div>
      )}
      {deleting && (
        <div className="install-confirm">
          <div className="banner error">
            {data.agentDir}를 지웁니다. 세션 기록, 설정, 프롬프트·스킬, 자격 증명(auth.json)이 모두 사라지며 되돌릴 수 없습니다.
          </div>
          <label className="delete-confirm">
            계속하려면 "{DELETE_WORD}"를 입력하세요
            <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus aria-label="삭제 확인" />
          </label>
          <div className="install-steps">
            <button
              type="button"
              className="primary"
              disabled={typed.trim() !== DELETE_WORD || busy !== undefined}
              onClick={() => void runDelete(true)}
            >
              백업 후 삭제
            </button>
            <button
              type="button"
              className="danger"
              disabled={typed.trim() !== DELETE_WORD || busy !== undefined}
              onClick={() => void runDelete(false)}
            >
              백업 없이 삭제
            </button>
            <button type="button" onClick={() => setDeleting(false)}>
              취소
            </button>
          </div>
        </div>
      )}
      {deleted && <div className="banner ok">데이터 폴더를 지웠습니다.</div>}
      {error && <div className="banner error">{error}</div>}
    </section>
  );
}
