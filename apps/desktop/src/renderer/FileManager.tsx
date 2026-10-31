import { useCallback, useEffect, useRef, useState } from "react";
import type { FileEntry, FileListing, WebFilesApi } from "../shared/web-files";
import { formatRelative } from "./format";

/**
 * Pi Web의 파일 관리자 (설계 §5.10 "파일 관리자"). 서버(휴대폰의 Termux) 홈 폴더 아래를 다룬다.
 * 웹에만 있다 (window.piWeb). ⋮ 메뉴에서 연다.
 *
 * - 폴더 누르기: 들어가기. 파일 누르기: 그 파일의 할 일(보기·고치기, 내려받기, 이름 바꾸기, 복사·이동, 지우기)
 * - 고르기를 켜면 여러 개를 골라 복사·이동·지우기. 복사·이동은 붙여 넣을 폴더로 가서 "여기에 붙여 넣기"
 * - 지금 폴더에서 새 세션을 연다 (로컬 호스트 탭)
 */

type Clip = { mode: "move" | "copy"; paths: string[] };

const HIDDEN_KEY = "pi-web-files-hidden";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

/** 경로 조각 (위로 가는 단추용). 홈은 ~로 보인다 */
function crumbs(path: string, home: string): Array<{ name: string; path: string }> {
  if (!home || !path.startsWith(home)) return [{ name: path, path }];
  const rest = path.slice(home.length).split("/").filter(Boolean);
  return [{ name: "~", path: home }, ...rest.map((name, i) => ({ name, path: `${home}/${rest.slice(0, i + 1).join("/")}` }))];
}

export function FileManager({ api, onClose, onOpenSession }: { api: WebFilesApi; onClose: () => void; onOpenSession: (path: string) => void }) {
  const [listing, setListing] = useState<FileListing>();
  const [home, setHome] = useState("");
  const [error, setError] = useState<string>();
  const [info, setInfo] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [showHidden, setShowHidden] = useState(() => {
    try {
      return localStorage.getItem(HIDDEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [clip, setClip] = useState<Clip>();
  const [action, setAction] = useState<FileEntry>();
  const [ask, setAsk] = useState<{ title: string; value: string; onOk: (value: string) => Promise<unknown> }>();
  const [confirmDelete, setConfirmDelete] = useState<string[]>();
  const [editor, setEditor] = useState<{ path: string; text: string; mtime: number; dirty: boolean }>();
  const upload = useRef<HTMLInputElement>(null);

  const run = useCallback(async (work: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await work();
      if (done) setInfo(done);
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const load = useCallback(
    (path?: string) =>
      run(async () => {
        const next = await api.list(path);
        if (path === undefined) setHome(next.path);
        setListing(next);
        setSelected(new Set());
      }),
    [api, run],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const here = listing?.path ?? "";
  const reload = () => load(here);
  const entries = (listing?.entries ?? []).filter((e) => showHidden || !e.name.startsWith("."));

  const toggleHidden = () => {
    setShowHidden((v) => {
      try {
        localStorage.setItem(HIDDEN_KEY, v ? "0" : "1");
      } catch {
        // 기억하지 못하면 이번만
      }
      return !v;
    });
  };

  const toggle = (path: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const openEntry = (entry: FileEntry) => {
    if (selecting) return toggle(entry.path);
    if (entry.dir) return void load(entry.path);
    setAction(entry);
  };

  const openEditor = (entry: FileEntry) =>
    run(async () => {
      const { text, mtime } = await api.readText(entry.path);
      setEditor({ path: entry.path, text, mtime, dirty: false });
    });

  const paste = () =>
    clip &&
    run(async () => {
      await api.transfer(clip.paths, here, clip.mode);
      setClip(undefined);
      await reload();
    }, `${clip.paths.length}개를 ${clip.mode === "copy" ? "복사했습니다" : "옮겼습니다"}`);

  const uploadFiles = (list: FileList | null) => {
    const picked = [...(list ?? [])];
    if (picked.length === 0) return;
    void run(async () => {
      for (const file of picked) await api.upload(here, file);
      await reload();
    }, `${picked.length}개를 올렸습니다`);
  };

  if (editor) {
    return (
      <div className="modal-backdrop">
        <div className="modal file-manager file-editor" role="dialog" aria-label="파일 편집">
          <div className="file-bar">
            <strong className="file-title" title={editor.path}>
              {editor.path.split("/").pop()}
              {editor.dirty ? " •" : ""}
            </strong>
            <button
              type="button"
              className="primary"
              disabled={!editor.dirty || busy}
              onClick={() =>
                void run(async () => {
                  const mtime = await api.writeText(editor.path, editor.text, editor.mtime);
                  setEditor({ ...editor, mtime, dirty: false });
                }, "저장했습니다")
              }
            >
              저장
            </button>
            <button
              type="button"
              onClick={() => {
                if (editor.dirty && !window.confirm("저장하지 않은 내용이 있습니다. 닫을까요?")) return;
                setEditor(undefined);
                setInfo(undefined);
              }}
            >
              닫기
            </button>
          </div>
          {error && <div className="banner error">{error}</div>}
          {info && <div className="banner info">{info}</div>}
          <textarea
            className="file-text"
            spellCheck={false}
            value={editor.text}
            onChange={(e) => setEditor({ ...editor, text: e.target.value, dirty: true })}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop">
      <div className="modal file-manager" role="dialog" aria-label="파일 관리자">
        <div className="file-bar">
          <strong className="file-title">파일 관리자</strong>
          <button type="button" onClick={onClose}>
            닫기
          </button>
        </div>
        <nav className="file-crumbs" aria-label="경로">
          {crumbs(here, home).map((c, i, all) => (
            <span key={c.path}>
              <button type="button" className="link-button" onClick={() => void load(c.path)} disabled={i === all.length - 1}>
                {c.name}
              </button>
              {i < all.length - 1 && <span className="muted"> / </span>}
            </span>
          ))}
        </nav>
        <div className="file-tools">
          <button type="button" disabled={!listing?.parent || busy} onClick={() => void load(listing?.parent)} title="위 폴더">
            ⬆
          </button>
          <button type="button" disabled={busy} onClick={() => void load(`${home}/storage`)} title="휴대폰 공용 저장소 (termux-setup-storage)">
            📱 저장소
          </button>
          <button type="button" disabled={busy} onClick={() => setAsk({ title: "새 폴더 이름", value: "", onOk: (v) => api.makeDir(here, v).then(reload) })}>
            + 폴더
          </button>
          <button type="button" disabled={busy} onClick={() => setAsk({ title: "새 파일 이름", value: "", onOk: (v) => api.makeFile(here, v).then(reload) })}>
            + 파일
          </button>
          <button type="button" disabled={busy} onClick={() => upload.current?.click()}>
            ⤴ 올리기
          </button>
          <input ref={upload} type="file" multiple hidden onChange={(e) => uploadFiles(e.target.files)} />
          <button type="button" className={selecting ? "active" : ""} onClick={() => (setSelecting((v) => !v), setSelected(new Set()))}>
            {selecting ? "고르기 끝" : "☑ 고르기"}
          </button>
          <button type="button" className={showHidden ? "active" : ""} onClick={toggleHidden} title="이름이 .으로 시작하는 파일">
            숨긴 파일
          </button>
        </div>
        {clip && (
          <div className="banner info file-clip">
            <span>
              {clip.paths.length}개를 {clip.mode === "copy" ? "복사" : "이동"}할 곳으로 가서 붙여 넣으세요.
            </span>
            <button type="button" className="primary" disabled={busy} onClick={() => void paste()}>
              여기에 붙여 넣기
            </button>
            <button type="button" onClick={() => setClip(undefined)}>
              그만
            </button>
          </div>
        )}
        {selecting && selected.size > 0 && (
          <div className="file-selection">
            <span>{selected.size}개 고름</span>
            <button type="button" onClick={() => (setClip({ mode: "copy", paths: [...selected] }), setSelecting(false))}>
              복사
            </button>
            <button type="button" onClick={() => (setClip({ mode: "move", paths: [...selected] }), setSelecting(false))}>
              이동
            </button>
            <button type="button" className="danger" onClick={() => setConfirmDelete([...selected])}>
              지우기
            </button>
          </div>
        )}
        {error && <div className="banner error">{error}</div>}
        {info && (
          <div className="banner info">
            <span>{info}</span>
            <button type="button" className="small" onClick={() => setInfo(undefined)}>
              닫기
            </button>
          </div>
        )}
        <ul className="file-list" aria-busy={busy}>
          {entries.length === 0 && <li className="muted file-empty">{listing ? "비어 있습니다" : "읽는 중…"}</li>}
          {entries.map((entry) => (
            <li key={entry.path} className={selected.has(entry.path) ? "picked" : undefined}>
              <button type="button" className="file-row" onClick={() => openEntry(entry)}>
                {selecting && <input type="checkbox" readOnly checked={selected.has(entry.path)} tabIndex={-1} />}
                <span className="file-icon" aria-hidden="true">
                  {entry.dir ? "📁" : "📄"}
                </span>
                <span className="file-name">
                  {entry.name}
                  {entry.link ? " ↪" : ""}
                </span>
                <span className="file-meta muted">
                  {entry.dir ? "" : `${formatSize(entry.size)} · `}
                  {entry.mtime ? formatRelative(entry.mtime) : ""}
                </span>
              </button>
              {!selecting && (
                <button type="button" className="file-more" aria-label={`${entry.name} 할 일`} onClick={() => setAction(entry)}>
                  ⋯
                </button>
              )}
            </li>
          ))}
        </ul>
        <div className="file-foot">
          <button type="button" className="primary" disabled={!here} onClick={() => onOpenSession(here)} title="지금 폴더를 작업 폴더로 새 세션을 엽니다">
            이 폴더에서 새 세션
          </button>
        </div>

        {action && (
          <div className="file-sheet-backdrop" onClick={() => setAction(undefined)}>
            <div className="file-sheet" role="menu" onClick={(e) => e.stopPropagation()}>
              <strong className="file-sheet-title">{action.name}</strong>
              {action.dir ? (
                <button type="button" role="menuitem" onClick={() => (setAction(undefined), void load(action.path))}>
                  열기
                </button>
              ) : (
                <>
                  <button type="button" role="menuitem" onClick={() => (setAction(undefined), void openEditor(action))}>
                    보기·고치기
                  </button>
                  <button type="button" role="menuitem" onClick={() => (setAction(undefined), void run(() => api.download(action.path)))}>
                    휴대폰으로 내려받기
                  </button>
                </>
              )}
              {action.dir && (
                <button type="button" role="menuitem" onClick={() => (setAction(undefined), onOpenSession(action.path))}>
                  이 폴더에서 새 세션
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setAction(undefined);
                  setAsk({ title: "새 이름", value: action.name, onOk: (v) => api.rename(action.path, v).then(reload) });
                }}
              >
                이름 바꾸기
              </button>
              <button type="button" role="menuitem" onClick={() => (setAction(undefined), setClip({ mode: "copy", paths: [action.path] }))}>
                복사…
              </button>
              <button type="button" role="menuitem" onClick={() => (setAction(undefined), setClip({ mode: "move", paths: [action.path] }))}>
                이동…
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setAction(undefined);
                  void navigator.clipboard?.writeText(action.path).then(() => setInfo("경로를 복사했습니다"), () => setInfo(action.path));
                }}
              >
                경로 복사
              </button>
              <button type="button" role="menuitem" className="danger" onClick={() => (setAction(undefined), setConfirmDelete([action.path]))}>
                지우기
              </button>
            </div>
          </div>
        )}

        {ask && (
          <div className="file-sheet-backdrop" onClick={() => setAsk(undefined)}>
            <form
              className="file-sheet"
              onClick={(e) => e.stopPropagation()}
              onSubmit={(e) => {
                e.preventDefault();
                const { onOk, value } = ask;
                setAsk(undefined);
                void run(() => onOk(value.trim()));
              }}
            >
              <strong className="file-sheet-title">{ask.title}</strong>
              <input autoFocus value={ask.value} onChange={(e) => setAsk({ ...ask, value: e.target.value })} autoCapitalize="off" spellCheck={false} />
              <div className="file-sheet-actions">
                <button type="button" onClick={() => setAsk(undefined)}>
                  취소
                </button>
                <button type="submit" className="primary" disabled={!ask.value.trim()}>
                  확인
                </button>
              </div>
            </form>
          </div>
        )}

        {confirmDelete && (
          <div className="file-sheet-backdrop" onClick={() => setConfirmDelete(undefined)}>
            <div className="file-sheet" role="alertdialog" onClick={(e) => e.stopPropagation()}>
              <strong className="file-sheet-title">{confirmDelete.length === 1 ? `"${confirmDelete[0]!.split("/").pop()}"을(를) 지울까요?` : `${confirmDelete.length}개를 지울까요?`}</strong>
              <p className="muted">휴지통 없이 바로 지웁니다. 폴더는 안의 것까지 지웁니다.</p>
              <div className="file-sheet-actions">
                <button type="button" onClick={() => setConfirmDelete(undefined)}>
                  취소
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() => {
                    const paths = confirmDelete;
                    setConfirmDelete(undefined);
                    setSelecting(false);
                    void run(async () => {
                      await api.remove(paths);
                      await reload();
                    }, `${paths.length}개를 지웠습니다`);
                  }}
                >
                  지우기
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
