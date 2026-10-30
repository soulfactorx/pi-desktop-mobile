import { useEffect, useState } from "react";
import type { FsListDirResult } from "../shared/api";
import { pathTrail } from "./folder-pick";

/**
 * 원격 호스트의 폴더 고르기 (설계 DESIGN-MATE-REMOTE.md §1). 실행기가 그 호스트의 폴더를 훑는다 (mate.call listDir).
 * 숨김 폴더는 "숨김 보기"를 켜야 보인다.
 */
export function FolderPicker({ hostLabel, initial, onPick, onClose }: { hostLabel: string; initial?: string; onPick: (path: string) => void; onClose: () => void }) {
  const [listing, setListing] = useState<FsListDirResult>();
  const [error, setError] = useState<string>();
  const [typed, setTyped] = useState("");
  const [hidden, setHidden] = useState(false);

  const open = (path?: string) =>
    void window.mate.listDir(path).then(
      (result) => {
        setListing(result);
        setTyped(result.path);
        setError(undefined);
      },
      (e: Error) => setError(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")),
    );
  useEffect(() => open(initial || undefined), []);

  const dirs = listing?.dirs.filter((d) => hidden || !d.startsWith(".")) ?? [];
  return (
    <div className="overlay" onClick={onClose}>
      <div className="session-panel folder-picker" onClick={(e) => e.stopPropagation()}>
        <div className="section-head">
          <h2>폴더 고르기</h2>
          <span className="muted">{hostLabel}</span>
          <span className="right">
            <button className="small" onClick={onClose}>
              닫기
            </button>
          </span>
        </div>
        <div className="row">
          <input className="grow" value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === "Enter" && open(typed)} />
          <button className="small" onClick={() => open(typed)}>
            이동
          </button>
          <label className="inline small-text">
            <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /> 숨김 보기
          </label>
        </div>
        {listing && (
          <div className="row small-text">
            {pathTrail(listing.path).map((crumb) => (
              <button key={crumb.path} className="link" onClick={() => open(crumb.path)}>
                {crumb.name}
              </button>
            ))}
            <button className="link" onClick={() => open(listing.home)}>
              (홈)
            </button>
          </div>
        )}
        {error && <div className="banner bad">{error}</div>}
        <ul className="folder-list">
          {listing?.parent && (
            <li>
              <button className="link" onClick={() => open(listing.parent)}>
                ⬆ 위 폴더
              </button>
            </li>
          )}
          {dirs.map((name) => (
            <li key={name}>
              <button className="link" onClick={() => open(`${listing!.path.replace(/\/$/, "")}/${name}`)}>
                📁 {name}
              </button>
            </li>
          ))}
          {listing && dirs.length === 0 && <li className="muted">하위 폴더가 없습니다</li>}
          {listing?.truncated && <li className="muted">너무 많아 일부만 보입니다</li>}
        </ul>
        <div className="row end">
          <button className="primary" disabled={!listing} onClick={() => listing && onPick(listing.path)}>
            이 폴더 고르기
          </button>
        </div>
      </div>
    </div>
  );
}
