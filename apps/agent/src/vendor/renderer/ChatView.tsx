import { useEffect, useRef } from "react";
import type { AssistantBlock, ChatItem } from "./chat-state";
import { Markdown } from "./markdown/Markdown";
import { resendCandidate } from "./run-status";
import { ToolCard, type ToolCardActions } from "./ToolCards";
import { ChatNavigator } from "../../renderer/ChatNavigator";

/** 대화 목록. 새 내용이 오면 사용자가 위로 스크롤해 둔 경우가 아니면 맨 아래로 따라간다. */
export function ChatView({
  items,
  running,
  actions,
  onResend,
}: {
  items: ChatItem[];
  running: boolean;
  actions: ToolCardActions;
  /** 오류로 끝난 마지막 응답의 질문을 입력창에 다시 채운다 */
  onResend?: (text: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const resend = running ? undefined : resendCandidate(items);

  useEffect(() => {
    const el = scroller.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  return (
    <div
      className="chat"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {items.length === 0 && <p className="empty">세션을 열고 메시지를 보내 보세요.</p>}
      {items.map((item) => (
        <Item
          key={item.key}
          item={item}
          actions={actions}
          onResend={resend && onResend && item.key === resend.anchorKey ? () => onResend(resend.text) : undefined}
        />
      ))}
      {running && <div className="working">Pi가 작업 중…</div>}
      <ChatNavigator scroller={scroller} turnSelector=".msg.user" />
    </div>
  );
}

function Item({
  item,
  actions,
  onResend,
}: {
  item: ChatItem;
  actions: ToolCardActions;
  onResend: (() => void) | undefined;
}) {
  switch (item.kind) {
    case "user":
      return (
        <div className="msg user">
          {item.images && item.images.length > 0 && (
            <div className="msg-images">
              {item.images.map((image, i) => (
                <img key={i} src={`data:${image.mimeType};base64,${image.data}`} alt={`첨부 이미지 ${i + 1}`} />
              ))}
            </div>
          )}
          {item.text}
        </div>
      );
    case "assistant":
      return (
        <div className={`msg assistant${item.done ? "" : " streaming"}`}>
          {item.blocks.map((block, i) => (
            <Block key={i} block={block} />
          ))}
          {item.stopReason === "error" && (
            <div className="error-line">
              <span>오류: {item.errorMessage ?? "알 수 없음"}</span>
              {onResend && <ResendButton onClick={onResend} />}
            </div>
          )}
          {item.stopReason === "aborted" && <div className="muted">중단됨</div>}
        </div>
      );
    case "tool":
      return <ToolCard item={item} actions={actions} />;
    case "notice":
      return (
        <div className={`notice ${item.level}`}>
          {item.text}
          {onResend && <ResendButton onClick={onResend} />}
        </div>
      );
  }
}

function ResendButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="small resend" onClick={onClick} title="이 질문을 입력창에 다시 채웁니다. 고쳐서 보낼 수 있습니다">
      다시 보내기
    </button>
  );
}

function Block({ block }: { block: AssistantBlock }) {
  if (block.type === "thinking") {
    return block.text ? (
      <details className="thinking">
        <summary>생각</summary>
        <div>{block.text}</div>
      </details>
    ) : null;
  }
  if (block.type === "toolCall") return null; // 툴 실행 카드에서 따로 보여준다.
  return <Markdown text={block.text} />;
}
