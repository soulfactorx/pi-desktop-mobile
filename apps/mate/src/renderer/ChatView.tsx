import { useEffect, useMemo, useRef, useState, type ClipboardEvent } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatImage, ChatLine, InboxView, Overview } from "../shared/api";
import type { Act } from "./App";
import { InboxCard } from "./InboxPanel";
import { relativeTime } from "./mate-view";
import { canReadClipboard, readBase64, readClipboardImages, transferFiles, useDraftImages, useSharedImages } from "./clipboard-images";
import { ImagePasteBox } from "./ImagePasteBox";
import { ChatNavigator } from "./ChatNavigator";

/** 한 번에 보낼 수 있는 이미지 (실행기와 같은 한도) */
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** 입력창이 "/"로 시작하면 보여 줄 명령 */
const COMMANDS: Array<[string, string]> = [
  ["/status", "실행기·오늘 실행·새 제안"],
  ["/inbox", "새 제안 목록"],
  ["/duties", "임무 목록"],
  ["/folders", "지시할 수 있는 폴더"],
  ["/run ", "임무를 지금 실행"],
  ["/ask ", "[폴더] 지시 — 읽기만 하며 살펴보기"],
  ["/fix ", "[폴더] 지시 — 별도 작업 공간에서 고치기"],
  ["/new", "새 대화 시작"],
  ["/help", "도움말"],
];

type Entry = { kind: "line"; at: number; line: ChatLine } | { kind: "item"; at: number; item: InboxView };

/**
 * Mate와의 대화 (설계 DESIGN-MATE.md §13).
 * 대화 기록과 새 제안을 시간 순서로 함께 보여 준다. Mate의 질문에는 선택지 버튼으로 답한다.
 * "/"로 시작하면 명령, 그 밖에는 그냥 말로 묻거나 시킨다. 휴대폰(텔레그램)에서 나눈 대화도 함께 보인다.
 */
export function ChatView({ overview, now, act }: { overview: Overview; now: number; act: Act }) {
  const { chat } = overview;
  const [text, setText] = useState("");
  const [answerTo, setAnswerTo] = useState<ChatLine>();
  const [sending, setSending] = useState(false);
  const [images, setImages] = useState<ChatImage[]>([]);
  // 붙여 둔 이미지를 보관해, 화면이 새로 열려도(휴대폰 공유 등) 남긴다
  useDraftImages("mate", images, setImages);
  const [imageNote, setImageNote] = useState<string>();
  const bottom = useRef<HTMLDivElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const [pasteBox, setPasteBox] = useState(false);

  const answered = useMemo(() => {
    const map = new Map<string, string>();
    for (const l of chat.lines) if (l.answerTo) map.set(l.answerTo, l.text);
    return map;
  }, [chat.lines]);

  // 대화 줄 + 아직 처리하지 않은 제안을 시간 순서로 (제안은 대화 기록이 시작된 뒤 것만, 없으면 최근 7일)
  const entries = useMemo<Entry[]>(() => {
    const since = chat.lines[0]?.at ?? now - 7 * 24 * 3_600_000;
    const items = overview.inbox.filter((i) => !i.status && i.createdAt >= since).map((item): Entry => ({ kind: "item", at: item.createdAt, item }));
    const lines = chat.lines.map((line): Entry => ({ kind: "line", at: line.at, line }));
    return [...lines, ...items].sort((a, b) => a.at - b.at);
  }, [chat.lines, overview.inbox, now]);

  const last = entries.at(-1);
  const lastKey = last ? (last.kind === "line" ? last.line.id : last.item.id) : "";
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [lastKey, chat.busy]);

  /** 입력창의 말을 보낸다. 선택지 버튼(withImages=false)은 붙인 이미지를 남겨 둔다 */
  const send = async (value: string, to?: string, withImages = false) => {
    const t = value.trim();
    const attached = withImages ? images : [];
    if ((!t && attached.length === 0) || sending) return;
    setSending(true);
    const ok = await act(() => window.mate.chatSend(t, to, attached.length > 0 ? attached : undefined));
    setSending(false);
    if (ok) {
      setText("");
      setAnswerTo(undefined);
      if (withImages) {
        setImages([]);
        setImageNote(undefined);
      }
    }
  };

  /** 붙여넣기·클립보드·고르기로 받은 이미지 파일을 붙인다 */
  const addImageFiles = async (files: File[]) => {
    const notes: string[] = [];
    const added: ChatImage[] = [];
    for (const file of files) {
      const name = file.name || "붙여 넣은 이미지";
      if (!IMAGE_TYPES.includes(file.type)) notes.push(`${name}: PNG·JPEG·GIF·WebP 이미지만 붙일 수 있어요`);
      else if (file.size > MAX_IMAGE_BYTES) notes.push(`${name}: 5MB보다 커요`);
      else if (images.length + added.length >= MAX_IMAGES) notes.push(`이미지는 한 번에 ${MAX_IMAGES}장까지예요`);
      else {
        try {
          added.push({ name, mimeType: file.type, data: await readBase64(file) });
        } catch {
          notes.push(`${name}: 읽지 못했어요`);
        }
      }
    }
    if (added.length > 0) setImages((prev) => [...prev, ...added].slice(0, MAX_IMAGES));
    setImageNote(notes.length > 0 ? [...new Set(notes)].join("\n") : undefined);
  };

  // 휴대폰 웹앱으로 공유한 이미지(스크린샷 등)를 붙인다
  useSharedImages((files) => void addImageFiles(files));

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = transferFiles(e.clipboardData).filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) return; // 글 붙여넣기는 그대로
    e.preventDefault();
    void addImageFiles(files);
  };

  /**
   * 📋 버튼: 붙여넣기 칸을 열고(키보드의 클립보드에 있는 스크린샷은 이 칸으로만 들어온다),
   * 브라우저가 클립보드를 읽게 해 주면 거기 있는 이미지는 바로 붙이고 칸을 닫는다
   */
  const pasteFromClipboard = async () => {
    setPasteBox(true);
    if (!canReadClipboard()) return;
    const files = await readClipboardImages().catch(() => []);
    if (files.length === 0) return;
    setPasteBox(false);
    await addImageFiles(files);
  };

  const hints = text.startsWith("/") && !text.includes("\n") ? COMMANDS.filter(([c]) => c.trim().startsWith(text.trim().split(" ")[0]!)) : [];

  return (
    <section className="chat">
      <div className="chat-log" ref={log}>
        {entries.length === 0 && (
          <div className="empty chat-empty">
            <p>Mate에게 무엇이든 물어보거나 시켜 보세요.</p>
            <p className="muted">예: “오늘 뭐 했어?”, “pi-desktop CI 왜 깨졌는지 살펴봐 줘”, “매일 아침 9시에 의존성 점검하는 임무 만들어 줘”</p>
            <p className="muted">관찰 중에 Mate가 묻고 싶은 것이 생기면 여기에 질문이 옵니다. 명령은 /로 시작합니다.</p>
          </div>
        )}
        {entries.map((e) =>
          e.kind === "item" ? (
            <ul key={e.item.id} className="chat-item">
              <InboxCard item={e.item} now={now} act={act} />
            </ul>
          ) : (
            <ChatBubble
              key={e.line.id}
              line={e.line}
              now={now}
              answer={answered.get(e.line.id)}
              onOption={(option) => void send(option, e.line.id)}
              onAnswer={() => setAnswerTo(e.line)}
              disabled={sending}
            />
          ),
        )}
        {chat.busy && <div className="chat-busy muted">Mate가 답을 쓰는 중…{chat.busy.source === "telegram" ? " (휴대폰 대화)" : ""}</div>}
        {chat.pending > 0 && !chat.busy && <div className="chat-busy muted">맡긴 일 {chat.pending}건이 끝나면 결과를 알려 드릴게요.</div>}
        <div ref={bottom} />
        <ChatNavigator scroller={log} turnSelector=".bubble.user" textSelector=".bubble-text" />
      </div>
      <div className="chat-input">
        {answerTo && (
          <div className="chat-answering">
            <span className="muted">질문에 답하는 중: {answerTo.text.slice(0, 80)}</span>
            <button className="link" onClick={() => setAnswerTo(undefined)}>
              취소
            </button>
          </div>
        )}
        {hints.length > 0 && (
          <ul className="chat-hints">
            {hints.map(([c, d]) => (
              <li key={c}>
                <button className="link" onClick={() => setText(c)}>
                  {c.trim()}
                </button>
                <span className="muted"> {d}</span>
              </li>
            ))}
          </ul>
        )}
        {(images.length > 0 || imageNote) && (
          <div className="chat-images">
            {images.map((image, i) => (
              <span key={i} className="chat-image" title={image.name}>
                <img src={`data:${image.mimeType};base64,${image.data}`} alt={image.name} />
                <button className="link" title="빼기" aria-label={`${image.name} 빼기`} onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}>
                  ×
                </button>
              </span>
            ))}
            {imageNote && <span className="muted small-text">{imageNote}</span>}
          </div>
        )}
        {pasteBox && (
          <ImagePasteBox
            onFiles={(files) => {
              setPasteBox(false);
              void addImageFiles(files);
            }}
            onClose={() => setPasteBox(false)}
          />
        )}
        <div className="chat-row">
          <textarea
            value={text}
            rows={2}
            placeholder={answerTo ? "답을 쓰세요" : "Mate에게 말하기 (Enter 보내기, Shift+Enter 줄바꿈, /로 명령)"}
            onChange={(e) => setText(e.target.value)}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(text, answerTo?.id, true);
              }
            }}
          />
          <div className="chat-buttons">
            <button className="primary" disabled={(!text.trim() && images.length === 0) || sending} onClick={() => void send(text, answerTo?.id, true)}>
              보내기
            </button>
            <div className="image-buttons">
              <button className="small" disabled={sending} onClick={() => void pasteFromClipboard()} title="클립보드의 이미지 붙이기" aria-label="클립보드의 이미지 붙이기">
                📋
              </button>
              <button className="small" disabled={sending} onClick={() => imageInput.current?.click()} title="이미지 고르기" aria-label="이미지 고르기">
                🖼
              </button>
              <input
                ref={imageInput}
                type="file"
                accept={IMAGE_TYPES.join(",")}
                multiple
                hidden
                onChange={(e) => {
                  const files = [...(e.target.files ?? [])];
                  e.target.value = "";
                  if (files.length > 0) void addImageFiles(files);
                }}
              />
            </div>
            <button className="small" title="앞의 대화를 잊고 새로 시작합니다" disabled={sending} onClick={() => void send("/new")}>
              새 대화
            </button>
            <button
              className="small"
              title="지금까지의 대화 기록을 휴지통으로 옮깁니다 (휴지통 탭에서 되살릴 수 있음)"
              disabled={sending || overview.chat.lines.length === 0}
              onClick={() => {
                if (confirm("대화 기록을 지울까요? 휴지통으로 옮겨져 되살릴 수 있고, 다음 말부터 새 대화가 됩니다.")) void act(() => window.mate.clearChat());
              }}
            >
              기록 지우기
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function ChatBubble({
  line,
  now,
  answer,
  onOption,
  onAnswer,
  disabled,
}: {
  line: ChatLine;
  now: number;
  answer: string | undefined;
  onOption: (option: string) => void;
  onAnswer: () => void;
  disabled: boolean;
}) {
  if (line.kind === "divider") return <div className="chat-divider muted">새 대화 · {relativeTime(line.at, now)}</div>;
  const phone = line.source === "telegram" ? " · 휴대폰" : "";
  if (line.role === "user") {
    return (
      <div className="bubble user">
        <div className="bubble-text">{line.text}</div>
        <div className="bubble-meta muted">
          {line.images ? `🖼 이미지 ${line.images}장 · ` : ""}
          {line.answerTo ? "질문에 답함 · " : ""}
          {relativeTime(line.at, now)}
          {phone}
        </div>
      </div>
    );
  }
  return (
    <div className={`bubble mate kind-${line.kind ?? "reply"}`}>
      {line.kind === "question" && <div className="bubble-label">Mate의 질문</div>}
      <div className="bubble-text markdown">
        <Markdown remarkPlugins={[remarkGfm]}>{line.text}</Markdown>
      </div>
      {line.kind === "question" &&
        (answer !== undefined ? (
          <div className="muted small-text">답: {answer}</div>
        ) : (
          <div className="card-actions">
            {line.options?.map((o) => (
              <button key={o} className="small" disabled={disabled} onClick={() => onOption(o)}>
                {o}
              </button>
            ))}
            <button className="small link" onClick={onAnswer}>
              직접 답하기
            </button>
          </div>
        ))}
      <div className="bubble-meta muted">
        {line.cwd ? `${line.cwd} · ` : ""}
        {relativeTime(line.at, now)}
        {phone}
      </div>
    </div>
  );
}
