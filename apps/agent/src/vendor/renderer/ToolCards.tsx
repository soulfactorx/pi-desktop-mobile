import { useState, type ReactNode } from "react";
import type { ChatItem } from "./chat-state";
import {
  diffStats,
  editLines,
  resultLineCount,
  shellExitCode,
  shellOutput,
  toolKind,
  toolTarget,
  writePreview,
  type DiffLine,
} from "./tool-view";

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

export interface ToolCardActions {
  /** 실행 중인 `!` 셸 명령을 멈춘다 */
  onAbortBash?: () => void;
  /** 툴이 다룬 파일을 탐색기에서 보여준다. 이 PC에서 열 수 없는 호스트면 없음 */
  onReveal?: (path: string) => void;
}

/** 한 번에 그리는 diff 줄 수. 넘으면 나머지는 "더 보기"로 */
const DIFF_PAGE = 400;

/**
 * 툴 호출 카드 (설계 §4.1). 툴마다 알맞은 모양으로 보여준다.
 * - edit·write: diff (줄 번호, 추가·삭제 수), 탐색기에서 보기
 * - bash·powershell: 터미널 모양, 종료 코드
 * - read·grep·find·ls: 대상과 결과 줄 수 요약, 펼치면 결과
 * - 그 밖(확장·MCP 툴): 인자와 부가 정보를 JSON 트리로
 */
export function ToolCard({ item, actions }: { item: ToolItem; actions: ToolCardActions }) {
  if (item.toolName === "!bash" || item.toolName === "!!bash") return <UserShellCard item={item} onAbort={actions.onAbortBash} />;
  switch (toolKind(item.toolName)) {
    case "edit":
      return <DiffCard item={item} lines={editLines(item.args, item.details)} onReveal={actions.onReveal} />;
    case "write":
      return <DiffCard item={item} lines={writePreview(item.args)} onReveal={actions.onReveal} />;
    case "shell":
      return <ShellToolCard item={item} />;
    case "read":
    case "search":
      return <ResultCard item={item} />;
    default:
      return <GenericCard item={item} />;
  }
}

function statusText(item: ToolItem): string {
  const status = item.status === "running" ? "실행 중" : item.status === "error" ? "실패" : "완료";
  return item.durationMs !== undefined && item.status !== "running" ? `${status} · ${formatDuration(item.durationMs)}` : status;
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** 카드 머리: 툴 이름, 대상, 덧붙일 요약, 상태. 누르면 본문을 접고 편다 */
function ToolHead({
  item,
  extra,
  open,
  onToggle,
  children,
}: {
  item: ToolItem;
  extra?: ReactNode;
  open: boolean;
  onToggle: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="tool-head-row">
      <button type="button" className="tool-head" onClick={onToggle} aria-expanded={open}>
        <span className="tool-caret">{open ? "▾" : "▸"}</span>
        <span className="tool-name">{item.toolName}</span>
        <span className="tool-args">{toolTarget(item.toolName, item.args)}</span>
        {extra}
        <span className="tool-status">{statusText(item)}</span>
      </button>
      {children}
    </div>
  );
}

function DiffCard({ item, lines, onReveal }: { item: ToolItem; lines: DiffLine[]; onReveal: ((path: string) => void) | undefined }) {
  const [open, setOpen] = useState(true);
  const { added, removed } = diffStats(lines);
  const path = (item.args as { path?: unknown } | undefined)?.path;
  return (
    <div className={`tool ${item.status}`}>
      <ToolHead
        item={item}
        open={open}
        onToggle={() => setOpen(!open)}
        extra={
          <span className="diff-stats">
            {added > 0 && <span className="diff-added">+{added}</span>}
            {removed > 0 && <span className="diff-removed">−{removed}</span>}
          </span>
        }
      >
        {onReveal && typeof path === "string" && (
          <button type="button" className="small" onClick={() => onReveal(path)} title="탐색기에서 이 파일 위치를 엽니다">
            위치 열기
          </button>
        )}
      </ToolHead>
      {open && (
        <div className="tool-body">
          {item.status === "error" && item.output && <pre className="tool-output error-text">{item.output}</pre>}
          {lines.length > 0 && <DiffView lines={lines} />}
        </div>
      )}
    </div>
  );
}

export function DiffView({ lines }: { lines: DiffLine[] }) {
  const [shown, setShown] = useState(DIFF_PAGE);
  const showNumbers = lines.some((l) => l.oldNo !== undefined || l.newNo !== undefined);
  return (
    <div className="diff">
      <table>
        <tbody>
          {lines.slice(0, shown).map((line, i) =>
            line.kind === "hunk" ? (
              <tr key={i} className="diff-hunk">
                <td colSpan={showNumbers ? 4 : 2}>{line.text}</td>
              </tr>
            ) : (
              <tr key={i} className={`diff-${line.kind}`}>
                {showNumbers && <td className="diff-no">{line.oldNo ?? ""}</td>}
                {showNumbers && <td className="diff-no">{line.newNo ?? ""}</td>}
                <td className="diff-sign">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</td>
                <td className="diff-text">{line.text}</td>
              </tr>
            ),
          )}
        </tbody>
      </table>
      {lines.length > shown && (
        <button type="button" className="small diff-more" onClick={() => setShown(shown + DIFF_PAGE)}>
          {lines.length - shown}줄 더 보기
        </button>
      )}
    </div>
  );
}

/** Pi가 실행한 bash·powershell 툴 */
function ShellToolCard({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(true);
  const exitCode = shellExitCode(item.exitCode, item.output);
  const output = shellOutput(item.output);
  const args = (typeof item.args === "object" && item.args !== null ? item.args : {}) as { command?: unknown; timeout?: unknown };
  const command = typeof args.command === "string" ? args.command.trim() : "";
  return (
    <div className={`tool shell ${item.status}`}>
      <ToolHead
        item={item}
        open={open}
        onToggle={() => setOpen(!open)}
        extra={exitCode !== undefined && item.status !== "running" ? <span className="tool-status">종료 코드 {exitCode}</span> : undefined}
      />
      {/* 머리에는 첫 줄만 잘려 보이므로, 펼치면 실행한 명령 전체를 보여준다 */}
      {open && command && (
        <pre className="shell-command">
          <span className="shell-prompt">$ </span>
          {command}
          {typeof args.timeout === "number" && <span className="shell-timeout">{`  (제한 ${args.timeout}초)`}</span>}
        </pre>
      )}
      {open && output.trim() && <pre className="shell-output">{output}</pre>}
    </div>
  );
}

/** read·grep·find·ls: 결과는 길기 쉬우므로 접어 두고 줄 수만 보여준다 */
function ResultCard({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const count = resultLineCount(item.output);
  const unit = toolKind(item.toolName) === "read" ? "줄" : "개";
  return (
    <div className={`tool ${item.status}`}>
      <ToolHead
        item={item}
        open={open}
        onToggle={() => setOpen(!open)}
        extra={item.status === "done" ? <span className="tool-status">{count}{unit}</span> : undefined}
      />
      {open && item.output && (
        <div className="tool-body">
          <pre className={`tool-output${item.status === "error" ? " error-text" : ""}`}>{item.output}</pre>
        </div>
      )}
    </div>
  );
}

/** 확장·MCP 등 모르는 툴: 인자와 부가 정보를 JSON 트리로 */
function GenericCard({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(item.status === "error");
  return (
    <div className={`tool ${item.status}`}>
      <ToolHead item={item} open={open} onToggle={() => setOpen(!open)} />
      {open && (
        <div className="tool-body">
          <div className="tool-section">
            <div className="tool-section-title">인자</div>
            <JsonTree value={item.args} />
          </div>
          {item.output && (
            <div className="tool-section">
              <div className="tool-section-title">결과</div>
              <pre className={`tool-output${item.status === "error" ? " error-text" : ""}`}>{item.output}</pre>
            </div>
          )}
          {item.details !== undefined && (
            <div className="tool-section">
              <div className="tool-section-title">부가 정보</div>
              <JsonTree value={item.details} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 접고 펼 수 있는 JSON 트리. 첫 단계만 펼쳐 둔다 */
export function JsonTree({ value, name, depth = 0 }: { value: unknown; name?: string; depth?: number }) {
  const label = name !== undefined ? <span className="json-key">{name}: </span> : null;
  if (value === null || typeof value !== "object") {
    return (
      <div className="json-leaf">
        {label}
        <span className={`json-${value === null ? "null" : typeof value}`}>
          {typeof value === "string" ? JSON.stringify(value) : String(value)}
        </span>
      </div>
    );
  }
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value);
  const brackets = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  if (entries.length === 0) {
    return (
      <div className="json-leaf">
        {label}
        <span className="json-null">{brackets.join("")}</span>
      </div>
    );
  }
  return (
    <details className="json-node" open={depth < 1}>
      <summary>
        {label}
        <span className="json-null">
          {brackets[0]} {entries.length}개 {brackets[1]}
        </span>
      </summary>
      <div className="json-children">
        {entries.map(([key, child]) => (
          <JsonTree key={key} name={key} value={child} depth={depth + 1} />
        ))}
      </div>
    </details>
  );
}

/**
 * 사용자가 입력창에서 실행한 `!` 셸 명령. 터미널처럼 명령과 출력을 바로 보여준다.
 * `!!`(컨텍스트 제외)는 결과가 모델에 전달되지 않는다는 표시를 붙인다.
 */
function UserShellCard({ item, onAbort }: { item: ToolItem; onAbort: (() => void) | undefined }) {
  const args = item.args as { command?: unknown } | undefined;
  const excluded = item.toolName === "!!bash";
  return (
    <div className={`tool shell ${item.status}`}>
      <div className="shell-head">
        <code className="shell-command">$ {String(args?.command ?? "")}</code>
        {excluded && <span className="muted" title="이 출력은 모델에 전달되지 않습니다">컨텍스트 제외</span>}
        <span className="tool-status">
          {item.status === "running"
            ? "실행 중"
            : item.exitCode !== undefined
              ? `종료 코드 ${item.exitCode}`
              : item.status === "error"
                ? "실패"
                : "완료"}
        </span>
        {item.status === "running" && onAbort && (
          <button type="button" className="danger small" onClick={onAbort}>
            멈춤
          </button>
        )}
      </div>
      {item.output && <pre className="shell-output">{item.output}</pre>}
    </div>
  );
}
