import { useCallback, useEffect, useState } from "react";
import type { SessionSummary } from "@pi-desktop/host-protocol/messages";
import { layoutTree, type TreeNode, type TreeRow } from "./session-tree";

interface Props {
  hostId: string;
  session: SessionSummary;
  disabled: boolean;
  onFork: (entryId: string) => void;
  /** 같은 세션 안에서 이 위치로 옮긴다 (요약 방법은 부모가 묻는다) */
  onNavigate: (entryId: string, text: string) => void;
  /** 바뀌면 다시 읽는다 (옮긴 뒤) */
  version: number;
  onClone: () => void;
  onClose: () => void;
}

/**
 * 세션 트리 패널 (설계 §4.1). Pi get_tree로 대화의 분기 구조를 보여준다.
 * 사용자 메시지에서 "여기서 분기"를 누르면 그 질문 직전에서 새 세션으로 갈라지고, 질문은 입력창에 채워진다.
 */
export function TreePanel({ hostId, session, disabled, onFork, onNavigate, version, onClose, onClone }: Props) {
  const [rows, setRows] = useState<TreeRow[]>([]);
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(async () => {
    try {
      const response = await window.piDesktop.sendCommand(hostId, session.sessionId, { type: "get_tree" });
      if (response.success !== true) throw new Error(String(response.error ?? "트리를 받지 못했습니다"));
      const data = response.data as { tree?: TreeNode[]; leafId?: string | null } | undefined;
      setRows(layoutTree(data?.tree ?? [], data?.leafId));
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [hostId, session.sessionId]);

  // 세션 파일이 바뀌면(fork·clone) 다시 읽는다.
  useEffect(() => {
    void load();
  }, [load, session.sessionFile, version]);

  // 실행이 끝날 때마다 새 항목이 생기므로 다시 읽는다.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = window.piDesktop.onSessionEvent((id, n) => {
      if (id !== hostId || n.sessionId !== session.sessionId) return;
      if ((n.event as { type?: string } | null)?.type !== "agent_settled") return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), 300);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [hostId, session.sessionId, load]);

  return (
    <aside className="tree-panel">
      <div className="tree-head">
        <h3 className="sidebar-title">세션 트리</h3>
        <div className="tree-actions">
          <button type="button" onClick={() => void load()} title="다시 읽기">
            새로고침
          </button>
          <button type="button" disabled={disabled} onClick={onClone} title="현재 위치까지를 새 세션으로 복제합니다">
            복제
          </button>
          <button type="button" onClick={onClose} aria-label="트리 닫기">
            닫기
          </button>
        </div>
      </div>
      <p className="tree-hint">
        “여기로”는 이 세션 안에서 그 위치로 옮겨 이어 씁니다 (TUI /tree). 질문으로 옮기면 질문이 입력창에 채워집니다. “여기서 분기”는
        그 질문 직전에서 새 세션으로 갈라집니다.
      </p>
      {error && <p className="sidebar-error">{error}</p>}
      <ol className="tree">
        {rows.map((row) => (
          <li
            key={row.id}
            className={`tree-row ${row.kind}${row.active ? " active" : ""}${row.isLeaf ? " leaf" : ""}${row.branchStart ? " branch" : ""}`}
            style={{ paddingLeft: `${8 + row.depth * 14}px` }}
          >
            <span className="tree-text" title={row.text}>
              {row.label && <span className="tree-label">{row.label}</span>}
              {row.text}
            </span>
            {row.isLeaf && <span className="tree-here">현재</span>}
            {!row.isLeaf && (row.kind === "user" || row.kind === "assistant") && (
              <button
                type="button"
                className="tree-fork"
                disabled={disabled}
                title="이 세션 안에서 이 위치로 옮깁니다"
                onClick={() => onNavigate(row.id, row.text)}
              >
                여기로
              </button>
            )}
            {row.canFork && (
              <button type="button" className="tree-fork" disabled={disabled} onClick={() => onFork(row.id)}>
                여기서 분기
              </button>
            )}
          </li>
        ))}
      </ol>
    </aside>
  );
}
