import { useEffect, useRef, type KeyboardEvent } from "react";
import { ApprovalChoice, type ParsedApproval } from "@pi-desktop/agent-kit/approval";
import type { DialogRequest } from "../vendor/renderer/extension-ui-state";
import { splitOption } from "./approval-option";

type Answer = { value?: string; cancelled?: boolean };

/**
 * permissions 확장의 승인 요청 화면 (설계 DESIGN-AGENT.md §4).
 *
 * 확장이 보낸 것은 일반 select 다이얼로그다. 제목을 agent-kit의 같은 함수로 읽어
 * 위험도·도구·대상을 따로 보여준다. 고른 버튼의 글자를 그대로 돌려주므로 확장 쪽 판단은 바뀌지 않는다.
 */
export function ApprovalDialog({
  dialog,
  approval,
  onAnswer,
}: {
  dialog: DialogRequest;
  approval: ParsedApproval;
  onAnswer: (answer: Answer) => void;
}) {
  const denyButton = useRef<HTMLButtonElement>(null);
  const options = dialog.options ?? [];
  const deny = options.find((o) => o === ApprovalChoice.deny);
  const allows = options.filter((o) => o !== ApprovalChoice.deny);
  // 자주 고르는 "이번만 허용"은 "거부" 옆 아래 줄에, 범위를 넓히는 허용(세션·항상)은 그 위에 한 줄씩 둔다
  const once = allows.find((o) => o === ApprovalChoice.once) ?? (allows.length === 1 ? allows[0] : undefined);
  const wider = allows.filter((o) => o !== once);
  const tone = approval.riskLabel === "실행" ? "exec" : "write";

  // Enter를 습관적으로 눌러 허용하는 일을 막기 위해 기본 초점은 "거부"에 둔다.
  useEffect(() => denyButton.current?.focus(), [dialog.id]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onAnswer({ cancelled: true });
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onKeyDown={onKeyDown}>
      <div className="modal approval" role="dialog" aria-modal="true" aria-labelledby={`approval-${dialog.id}`}>
        <div className="modal-head">
          <span className={`approval-risk ${tone}`}>{approval.riskLabel}</span>
          <span className="modal-badge">승인 요청</span>
        </div>
        <h2 id={`approval-${dialog.id}`} className="modal-title">
          <code>{approval.toolName}</code> {approval.summary}
        </h2>
        <pre className="approval-target">{approval.target || "(대상 없음)"}</pre>
        {wider.length > 0 && (
          <div className="approval-wider">
            <span className="muted small-text">더 넓게 허용</span>
            {wider.map((option) => {
              const { label, pattern } = splitOption(option);
              return (
                <button key={option} type="button" className="approval-scope" onClick={() => onAnswer({ value: option })}>
                  <span>{label}</span>
                  {pattern && <code>{pattern}</code>}
                </button>
              );
            })}
          </div>
        )}
        <div className="approval-actions">
          {deny && (
            <button ref={denyButton} type="button" className="danger" onClick={() => onAnswer({ value: deny })}>
              {deny}
            </button>
          )}
          {once && (
            <button type="button" className="primary" onClick={() => onAnswer({ value: once })}>
              {once}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

