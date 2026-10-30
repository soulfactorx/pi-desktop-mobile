import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { DialogRequest, ExtensionUiState, Toast } from "./extension-ui-state";

type Answer = { value?: string; confirmed?: boolean; cancelled?: boolean };

/**
 * 확장 다이얼로그 (select·confirm·input·editor). 한 번에 가장 먼저 온 것 하나를 띄운다.
 * Esc는 취소, 제한 시간이 있으면 남은 시간을 보여준다 (시간이 지나면 Pi가 기본값으로 처리하고 데몬이 닫아 준다).
 */
export function ExtensionDialog({ dialog, onAnswer }: { dialog: DialogRequest; onAnswer: (answer: Answer) => void }) {
  const [text, setText] = useState(dialog.prefill ?? "");
  const remaining = useRemaining(dialog);
  const first = useRef<HTMLElement | null>(null);

  // 새 다이얼로그가 뜨면 입력값을 초기화하고 첫 컨트롤에 초점을 준다.
  useEffect(() => {
    setText(dialog.prefill ?? "");
    first.current?.focus();
  }, [dialog.id, dialog.prefill]);

  const cancel = () => onAnswer({ cancelled: true });
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onKeyDown={onKeyDown}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={`dlg-${dialog.id}`}>
        <div className="modal-head">
          <span className="modal-badge">확장 요청</span>
          {remaining !== undefined && <span className="modal-timer">{Math.ceil(remaining / 1000)}초 남음</span>}
        </div>
        <h2 id={`dlg-${dialog.id}`} className="modal-title">
          {dialog.title}
        </h2>
        {dialog.message && <p className="modal-message">{dialog.message}</p>}

        {dialog.method === "select" && (
          <div className="modal-options">
            {(dialog.options ?? []).map((option, i) => (
              <button
                key={option}
                type="button"
                onClick={() => onAnswer({ value: option })}
              >
                {option}
              </button>
            ))}
          </div>
        )}

        {dialog.method === "input" && (
          <input
            ref={(el) => void (first.current = el)}
            className="modal-input"
            value={text}
            placeholder={dialog.placeholder}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) onAnswer({ value: text });
            }}
          />
        )}

        {dialog.method === "editor" && (
          <textarea
            ref={(el) => void (first.current = el)}
            className="modal-editor"
            value={text}
            rows={10}
            onChange={(e) => setText(e.target.value)}
          />
        )}

        <div className="modal-actions">
          <button
            type="button"
            onClick={cancel}
            // select·confirm은 위험한 동작을 허락하는 다이얼로그일 수 있어 기본 초점을 "취소"에 둔다.
            // (Enter를 습관적으로 눌러 허용하는 일을 막기 위함. 입력형은 입력란에 초점)
            ref={dialog.method === "select" || dialog.method === "confirm" ? (el) => void (first.current = el) : undefined}
          >
            취소
          </button>
          {dialog.method === "confirm" && (
            <>
              <button type="button" onClick={() => onAnswer({ confirmed: false })}>
                아니요
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => onAnswer({ confirmed: true })}
              >
                예
              </button>
            </>
          )}
          {(dialog.method === "input" || dialog.method === "editor") && (
            <button type="button" className="primary" onClick={() => onAnswer({ value: text })}>
              확인
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** 제한 시간이 있는 다이얼로그의 남은 시간(ms). 없으면 undefined */
function useRemaining(dialog: DialogRequest): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (dialog.timeout === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [dialog.timeout]);
  return dialog.timeout === undefined ? undefined : Math.max(0, dialog.at + dialog.timeout - now);
}

const TOAST_MS = 5_000;

/** notify 알림. 몇 초 뒤 저절로 사라지고, 눌러서 닫을 수도 있다. */
export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (key: string) => void }) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => (
        <ToastItem key={toast.key} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (key: string) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.key), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast.key, onDismiss]);
  return (
    <button type="button" className={`toast ${toast.level}`} onClick={() => onDismiss(toast.key)}>
      {toast.message}
    </button>
  );
}

/** setWidget으로 확장이 보여 달라고 한 줄 묶음. 입력창 위 또는 아래에 둔다. */
export function Widgets({ ui, placement }: { ui: ExtensionUiState; placement: "aboveEditor" | "belowEditor" }) {
  const entries = Object.entries(ui.widgets).filter(([, w]) => w.placement === placement);
  if (entries.length === 0) return null;
  return (
    <div className={`widgets ${placement}`}>
      {entries.map(([key, widget]) => (
        <pre key={key} className="widget" title={`확장 위젯: ${key}`}>
          {widget.lines.join("\n")}
        </pre>
      ))}
    </div>
  );
}

/** setStatus로 확장이 알려 준 상태들 */
export function StatusLine({ ui }: { ui: ExtensionUiState }) {
  const entries = Object.entries(ui.statuses);
  if (entries.length === 0) return null;
  return (
    <div className="status-line">
      {entries.map(([key, text]) => (
        <span key={key} className="status-item" title={`확장 상태: ${key}`}>
          {text}
        </span>
      ))}
    </div>
  );
}
