import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { ChatView } from "../vendor/renderer/ChatView";
import { StatusLine, Widgets } from "../vendor/renderer/ExtensionUi";
import { acceptsImages, MAX_IMAGE_BYTES, splitAttachments, withAttachments } from "./attachments";
import type { ImageAttachment } from "../shared/api";
import { EXAMPLES } from "./examples";
import { FolderMenu } from "./FolderMenu";
import type { useAgentSession } from "./use-agent-session";

type Session = ReturnType<typeof useAgentSession>;

/**
 * 대화 화면. 세션이 없으면 할 수 있는 일을 보여 주고, 예시를 누르면 대화를 열어 입력창에 채운다.
 * 머리에는 작업 폴더·모델(이 세션만 바꿈)·agent-kit 상태를 보인다.
 */
export function ChatPage({
  agent,
  connected,
  title,
  renameTick,
  onRenamed,
  onNewChat,
  onNewChatInFolder,
  recent,
  home,
  onMoveTo,
  onMoveToPicked,
  prefill,
  guard,
}: {
  agent: Session;
  connected: boolean;
  /** 대화 이름 (Pi 세션 이름, 없으면 폴더 이름) */
  title?: string;
  /** 바뀔 때마다 이름 입력칸을 연다 (메뉴 F2·사이드바 두 번 누르기) */
  renameTick: number;
  onRenamed: () => void;
  /** 새 대화를 연다. folder가 없으면 마지막 폴더 */
  onNewChat: (folder?: string) => Promise<void>;
  onNewChatInFolder: () => Promise<void>;
  /** 최근 작업 폴더와 홈 (폴더 옮기기 메뉴) */
  recent: string[];
  home?: string;
  /** 지금 대화를 그 폴더로 옮겨 이어 간다 */
  onMoveTo: (folder: string) => void;
  onMoveToPicked: () => void;
  /** 입력창에 채울 글. tick이 바뀔 때마다 채운다 */
  prefill?: { text: string; tick: number };
  guard: (action: () => Promise<void>) => void;
}) {
  const { session, chat, ui, kit, model, models } = agent;
  const [draft, setDraft] = useState("");
  const [renaming, setRenaming] = useState<string>();
  /** 메시지와 함께 보낼 이미지 (보내면 비운다) */
  const [images, setImages] = useState<Array<Required<Pick<ImageAttachment, "name" | "mimeType" | "data">>>>([]);
  const [attachNote, setAttachNote] = useState<string>();
  const input = useRef<HTMLTextAreaElement>(null);

  // 대화가 열리면 바로 입력할 수 있게 한다
  useEffect(() => {
    if (session) input.current?.focus();
    setRenaming(undefined);
  }, [session?.sessionId]);

  // 다른 화면에서 보낸 글(예: /skill:이름)을 입력창에 채운다. 새 요청일 때만
  const seenPrefill = useRef(prefill?.tick);
  useEffect(() => {
    if (!prefill || prefill.tick === seenPrefill.current) return;
    seenPrefill.current = prefill.tick;
    setDraft(prefill.text);
    input.current?.focus();
  }, [prefill?.tick, session?.sessionId]);

  // 이름 바꾸기 요청이 새로 왔을 때만 연다. 다른 화면에 갔다 돌아와 다시 그려질 때는 열지 않는다
  const seenRenameTick = useRef(renameTick);
  useEffect(() => {
    if (renameTick === seenRenameTick.current) return;
    seenRenameTick.current = renameTick;
    if (session) setRenaming(title ?? "");
  }, [renameTick]);

  /** Pi 세션 이름으로 저장한다 (세션 파일에 남아 Pi Desktop·TUI 목록에도 같은 이름이 보인다) */
  const saveName = (name: string) =>
    guard(async () => {
      setRenaming(undefined);
      const trimmed = name.trim();
      if (!session || !trimmed || trimmed === title) return;
      const response = await window.piAgent.sendCommand(session.sessionId, { type: "set_session_name", name: trimmed });
      if (response.success === false) throw new Error(String(response.error ?? "이름을 바꾸지 못했습니다"));
      onRenamed();
    });

  const submit = () => {
    const message = draft.trim() || (images.length > 0 ? "첨부한 이미지를 봐 주세요." : "");
    if (!message || !session) return;
    const sending = images;
    setDraft("");
    setImages([]);
    setAttachNote(undefined);
    guard(() => agent.send(message, sending));
  };

  /** 고른 파일: 이미지는 볼 수 있는 모델이면 함께 보내고, 나머지는 경로를 적는다 */
  const attach = async (paths: string[]) => {
    const { images: imagePaths, files } = splitAttachments(paths);
    const asPaths = acceptsImages(model?.input) ? files : paths;
    if (asPaths.length > 0) setDraft((prev) => withAttachments(prev, asPaths));
    if (imagePaths.length === 0) return setAttachNote(undefined);
    if (!acceptsImages(model?.input)) return setAttachNote("이 모델은 이미지를 볼 수 없어 경로만 붙였습니다. 이미지를 보려면 이미지를 받는 모델로 바꾸세요.");
    const read = await window.piAgent.readImages(imagePaths);
    addImages(read);
  };

  const addImages = (read: ImageAttachment[]) => {
    const ok = read.filter((i): i is Required<Pick<ImageAttachment, "name" | "mimeType" | "data">> & ImageAttachment => !!i.data);
    setImages((prev) => [...prev, ...ok.map((i) => ({ name: i.name, mimeType: i.mimeType, data: i.data }))]);
    const failed = read.filter((i) => !i.data);
    setAttachNote(failed.length > 0 ? `붙이지 못한 이미지: ${failed.map((i) => `${i.name} (${i.error})`).join(", ")}` : undefined);
  };

  /** 클립보드의 이미지(화면 캡처 등)를 붙여 넣는다. 글은 그대로 입력창에 들어간다 */
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files].filter((file) => file.type.startsWith("image/"));
    if (files.length === 0 || !session) return;
    e.preventDefault();
    if (!acceptsImages(model?.input)) return setAttachNote("이 모델은 이미지를 볼 수 없습니다. 이미지를 받는 모델로 바꾸세요.");
    void Promise.all(
      files.map(
        (file) =>
          new Promise<ImageAttachment>((resolve) => {
            const name = file.name || "붙여 넣은 이미지";
            if (file.size > MAX_IMAGE_BYTES) return resolve({ name, mimeType: file.type, error: "5MB보다 큽니다" });
            const reader = new FileReader();
            reader.onload = () => resolve({ name, mimeType: file.type, data: String(reader.result).replace(/^data:[^,]*,/, "") });
            reader.onerror = () => resolve({ name, mimeType: file.type, error: "읽지 못했습니다" });
            reader.readAsDataURL(file);
          }),
      ),
    ).then(addImages);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const useExample = (prompt: string) =>
    guard(async () => {
      if (!session) await onNewChat();
      setDraft(prompt);
      input.current?.focus();
    });

  const modelKey = model ? `${model.provider}/${model.id}` : "";
  const empty = chat.items.length === 0;

  return (
    <div className="page chat-page">
      <header className="page-head">
        {session ? (
          <>
            <div className="chat-title">
              {renaming !== undefined ? (
                <input
                  autoFocus
                  className="rename-input"
                  value={renaming}
                  placeholder="대화 이름"
                  onChange={(e) => setRenaming(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) saveName(renaming);
                    if (e.key === "Escape") setRenaming(undefined);
                  }}
                  onBlur={() => saveName(renaming)}
                />
              ) : (
                <span className="chat-name">
                  <strong>{title}</strong>
                  <button className="icon-button" title="대화 이름 바꾸기 (F2)" onClick={() => setRenaming(title ?? "")}>
                    ✎
                  </button>
                </span>
              )}
              <FolderMenu
                className="chat-folder link-button muted small-text"
                label={`📁 ${session.cwd} ▾`}
                title="다른 폴더로 옮겨 이 대화를 이어 갑니다"
                disabled={chat.running}
                heading="이 대화를 이어 갈 폴더 (지금까지의 대화를 가져가고, 원래 대화는 남습니다)"
                recent={recent}
                home={home}
                exclude={session.cwd}
                onPick={onMoveTo}
                onBrowse={onMoveToPicked}
              />
            </div>
            <span className="spacer" />
            <select
              className="model-select"
              value={modelKey}
              title="이 대화의 모델 (기본 모델·프로바이더 설정은 Pi Desktop에서)"
              onChange={(e) => {
                const picked = models.find((m) => `${m.provider}/${m.id}` === e.target.value);
                if (picked) guard(() => agent.changeModel(picked.provider, picked.id));
              }}
            >
              {!model && <option value="">모델 없음</option>}
              {model && !models.some((m) => `${m.provider}/${m.id}` === modelKey) && <option value={modelKey}>{modelKey}</option>}
              {models.map((m) => (
                <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                  {m.provider}/{m.name ?? m.id}
                </option>
              ))}
            </select>
            {kit === "missing" && <span className="badge bad">agent-kit 없음</span>}
            <button className="small" onClick={() => guard(agent.close)} title="이 대화의 Pi를 끝냅니다 (기록은 Pi 세션 폴더에 남음)">
              대화 닫기
            </button>
          </>
        ) : (
          <span className="muted">대화를 열면 Pi와 agent-kit 기능을 쓸 수 있습니다</span>
        )}
      </header>

      {empty ? (
        <div className="welcome">
          <h2>{session ? "무엇을 도와드릴까요?" : "새 대화를 시작하세요"}</h2>
          {!session && (
            <div className="row">
              <button className="primary" disabled={!connected || Boolean(agent.opening)} onClick={() => guard(() => onNewChat())}>
                {agent.opening ? "여는 중…" : "새 대화"}
              </button>
              <button disabled={!connected || Boolean(agent.opening)} onClick={() => guard(onNewChatInFolder)}>
                폴더를 골라 새 대화
              </button>
            </div>
          )}
          <p className="muted">이런 일을 할 수 있습니다. 누르면 입력창에 채워집니다.</p>
          <div className="examples">
            {EXAMPLES.map((example) => (
              <button key={example.title} className="example" disabled={!connected} onClick={() => useExample(example.prompt)}>
                <strong>{example.title}</strong>
                <span>{example.detail}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <ChatView items={chat.items} running={chat.running} onResend={setDraft} actions={{}} />
      )}

      <Widgets ui={ui} placement="aboveEditor" />
      {(images.length > 0 || attachNote) && (
        <div className="attach-tray">
          {images.map((image, i) => (
            <span key={i} className="attach-chip" title={image.name}>
              <img src={`data:${image.mimeType};base64,${image.data}`} alt={image.name} />
              <button className="icon-button" title="빼기" onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}>
                ×
              </button>
            </span>
          ))}
          {attachNote && <span className="muted small-text">{attachNote}</span>}
        </div>
      )}
      <div className="composer">
        <textarea
          ref={input}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          disabled={!session || !connected}
          placeholder={session ? "메시지 입력 (Enter 전송, Shift+Enter 줄바꿈, 이미지는 붙여 넣기도 됩니다)" : "먼저 새 대화를 여세요"}
        />
        <div className="actions">
          {chat.running && <button onClick={() => guard(agent.abort)}>중지</button>}
          <button
            disabled={!session}
            onClick={() =>
              guard(async () => {
                await attach(await window.piAgent.pickFiles());
              })
            }
          >
            파일 첨부
          </button>
          <button className="primary" disabled={!session || (!draft.trim() && images.length === 0)} onClick={submit}>
            보내기
          </button>
        </div>
      </div>
      <Widgets ui={ui} placement="belowEditor" />
      <StatusLine ui={ui} />
    </div>
  );
}
