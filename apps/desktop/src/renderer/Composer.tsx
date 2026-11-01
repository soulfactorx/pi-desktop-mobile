import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { formatBytes, parseDataUrl, rejectReason, toDataUrl, type ImageAttachment } from "./attachments";
import { canReadClipboard, enterHint, isSendKey, readClipboardImages, transferFiles, useDraftImages, useSharedImages } from "./clipboard-images";
import { ImagePasteBox } from "./ImagePasteBox";
import { ComposerGrip, useComposerSize } from "./composer-size";
import {
  atQuery,
  fileMention,
  filterCommands,
  parseInput,
  pushHistory,
  replaceRange,
  shouldNavigateHistory,
  slashQuery,
  stepHistory,
  type ParsedInput,
  type PiCommand,
} from "./composer-input";

const HISTORY_KEY = "pi-desktop.inputHistory";

const SOURCE_LABELS: Record<string, string> = { prompt: "프롬프트", skill: "스킬", extension: "확장" };

interface ComposerProps {
  value: string;
  onChange: (text: string) => void;
  /** 세션이 없거나 입력을 잠가야 할 때 */
  disabled: boolean;
  placeholder: string;
  running: boolean;
  /** `/` 자동완성 목록. 아직 안 읽었으면 undefined */
  commands: PiCommand[] | undefined;
  /** `/`를 쳤는데 목록이 없으면 불린다 */
  onNeedCommands: () => void;
  /** `@` 파일 피커: 작업 폴더에서 파일을 찾는다. 없으면 파일 피커를 쓰지 않는다 */
  onSearchFiles?: (query: string) => Promise<string[]>;
  /** 실행 중이면 behavior로 steer·followUp을 고른다. images는 질문(prompt)에만 붙는다 */
  onSubmit: (
    input: Exclude<ParsedInput, { kind: "empty" }>,
    behavior: "steer" | "followUp" | undefined,
    images: ImageAttachment[],
  ) => void;
  /** 지금 모델이 이미지를 받는지. 아니면 첨부에 안내를 붙인다 */
  acceptsImages: boolean;
  onAbort: () => void;
  /** 붙여 둔 이미지를 보관할 이름 (탭·세션). 없으면 보관하지 않는다 */
  draftKey?: string;
}

/**
 * 입력창 (설계 §4.1).
 * - Enter 보내기, Shift+Enter 줄바꿈. 실행 중 Enter는 Follow-up
 * - `!명령`·`!!명령`은 셸 명령 (`!!`는 결과를 컨텍스트에 넣지 않음)
 * - ↑·↓로 이전에 보낸 입력 불러오기 (모든 탭·세션 공통)
 * - `/`로 시작하면 Pi 명령(프롬프트 템플릿, 스킬, 확장 명령) 자동완성
 * - 이미지는 붙여넣기(Ctrl+V)나 끌어 놓기로 첨부한다. 질문과 함께 보내고, 셸 명령에는 붙이지 않는다
 * - `@`를 치면 작업 폴더의 파일 자동완성. 고르면 `@경로`를 넣는다 (Pi TUI와 같이 경로만 넣고, 모델이 필요하면 읽는다)
 */

/** 자동완성 목록 한 줄 */
interface Suggestion {
  key: string;
  label: string;
  kind: string;
  detail?: string;
  apply: () => void;
}
export function Composer(props: ComposerProps) {
  const { value, onChange, disabled, placeholder, running, commands, onNeedCommands, onSearchFiles, onSubmit, onAbort, acceptsImages } =
    props;
  const [images, setImages] = useState<ImageAttachment[]>([]);
  // 붙여 둔 이미지를 보관해, 화면이 새로 열려도(휴대폰 공유 등) 남긴다
  useDraftImages(props.draftKey, images, setImages);
  const [attachError, setAttachError] = useState<string | undefined>();
  const [dragging, setDragging] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const { gripProps } = useComposerSize(textarea, value, "pi-desktop:composer-height");
  const imageInput = useRef<HTMLInputElement>(null);
  const [pasteBox, setPasteBox] = useState(false);
  // 휴대폰 웹앱으로 공유한 이미지(스크린샷 등)는 지금 보이는 탭의 입력창에 붙인다
  useSharedImages((files) => void attach(files), !disabled, () => Boolean(textarea.current?.offsetParent));
  // 히스토리를 보는 중이면 그 위치와, 보기 전에 쓰던 초안
  const browsing = useRef<{ index: number; draft: string; history: string[] } | undefined>(undefined);
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  // 커서 위치 (`@` 파일 피커는 커서 바로 앞의 낱말을 본다)
  const [caret, setCaret] = useState(0);
  // `@` 검색 결과와 그 검색어. 새 결과가 올 때까지는 직전 결과를 보여준다 (글자마다 깜박이지 않게)
  const [files, setFiles] = useState<{ query: string; paths: string[] } | undefined>();

  const query = disabled ? undefined : slashQuery(value);
  const at = disabled || query !== undefined || !onSearchFiles ? undefined : atQuery(value, caret);
  const mode = query !== undefined ? "slash" : at ? "file" : undefined;
  const trigger = mode === "slash" ? `/${query}` : at ? `@${at.start}:${at.query}` : undefined;

  useEffect(() => {
    if (query !== undefined && !commands) onNeedCommands();
  }, [query !== undefined, commands, onNeedCommands]);

  // `@` 검색어가 바뀌면 잠시 기다렸다가 찾는다 (글자마다 요청하지 않게).
  const atText = at?.query;
  useEffect(() => {
    if (atText === undefined || !onSearchFiles) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      onSearchFiles(atText)
        .then((paths) => {
          if (!cancelled) setFiles({ query: atText, paths });
        })
        .catch(() => {
          if (!cancelled) setFiles({ query: atText, paths: [] });
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [atText, onSearchFiles]);

  // `@` 낱말을 벗어나면 결과를 비운다 (다음 `@`에서 옛 결과가 보이지 않게).
  useEffect(() => {
    if (atText === undefined) setFiles(undefined);
  }, [atText === undefined]);

  // 검색어가 바뀌면 첫 항목을 고르고, 자동완성 대상이 사라지면 닫힘 상태를 푼다.
  useEffect(() => setSelected(0), [trigger]);
  useEffect(() => {
    if (trigger === undefined) setDismissed(false);
  }, [trigger === undefined]);

  function setTextAndCaret(text: string, nextCaret: number) {
    onChange(text);
    setCaret(nextCaret);
    // 바뀐 값이 그려진 뒤 커서를 옮긴다.
    requestAnimationFrame(() => {
      const el = textarea.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(nextCaret, nextCaret);
    });
  }

  let suggestions: Suggestion[] = [];
  if (!dismissed && mode === "slash" && commands) {
    suggestions = filterCommands(commands, query!).map((command) => ({
      key: command.name,
      label: `/${command.name}`,
      kind: SOURCE_LABELS[command.source] ?? command.source,
      ...(command.description ? { detail: command.description } : {}),
      apply: () => setTextAndCaret(`/${command.name} `, command.name.length + 2),
    }));
  } else if (!dismissed && mode === "file" && at && files) {
    suggestions = files.paths.map((path) => ({
      key: path,
      label: path,
      kind: path.endsWith("/") ? "폴더" : "파일",
      apply: () => {
        const next = replaceRange(value, at.start, caret, fileMention(path));
        setTextAndCaret(next.text, next.caret);
      },
    }));
  }
  const showSuggestions = suggestions.length > 0;
  // 첫 검색은 파일 목록을 만드느라 오래 걸릴 수 있어 기다리는 동안 안내를 보여준다.
  const searchingFiles = !dismissed && mode === "file" && files === undefined;

  const parsed = parseInput(value);

  function submit(behavior?: "steer" | "followUp") {
    if (parsed.kind === "empty") return;
    writeHistory(pushHistory(readHistory(), value));
    browsing.current = undefined;
    if (parsed.kind === "prompt") {
      onSubmit(parsed, behavior, images);
      setImages([]);
    } else {
      // 셸 명령에는 이미지를 붙일 수 없으므로 첨부는 다음 질문을 위해 남겨 둔다.
      onSubmit(parsed, undefined, []);
    }
    setAttachError(undefined);
  }

  /** 붙여넣기·끌어 놓기로 받은 파일을 첨부한다. 받지 않는 파일은 이유를 보여준다 */
  async function attach(files: File[]) {
    const errors: string[] = [];
    let count = images.length;
    const added: ImageAttachment[] = [];
    for (const file of files) {
      const reason = rejectReason(file, count);
      if (reason) {
        errors.push(reason);
        continue;
      }
      const parsedUrl = parseDataUrl(await readAsDataUrl(file));
      if (!parsedUrl) {
        errors.push(`${file.name || "이미지"}: 읽지 못했습니다`);
        continue;
      }
      added.push({ id: crypto.randomUUID(), name: file.name || "붙여넣은 이미지", mimeType: parsedUrl.mimeType, data: parsedUrl.data, size: file.size });
      count++;
    }
    if (added.length > 0) setImages((prev) => [...prev, ...added]);
    setAttachError(errors.length > 0 ? errors.join("\n") : undefined);
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = transferFiles(e.clipboardData);
    if (files.length === 0) return; // 글 붙여넣기는 그대로
    e.preventDefault();
    void attach(files);
  }

  /**
   * 📋 버튼: 붙여넣기 칸을 열고(키보드의 클립보드에 있는 스크린샷은 이 칸으로만 들어온다),
   * 브라우저가 클립보드를 읽게 해 주면 거기 있는 이미지는 바로 붙이고 칸을 닫는다
   */
  async function pasteFromClipboard() {
    setPasteBox(true);
    if (!canReadClipboard()) return;
    const files = await readClipboardImages().catch(() => []);
    if (files.length === 0) return;
    setPasteBox(false);
    await attach(files);
  }

  function onDrop(e: DragEvent<HTMLElement>) {
    setDragging(false);
    const files = [...e.dataTransfer.files];
    if (files.length === 0 || disabled) return;
    e.preventDefault();
    void attach(files);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing) return;
    if (showSuggestions) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setSelected((i) => (i + step + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        (suggestions[selected] ?? suggestions[0]!).apply();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(true);
        return;
      }
    }
    // PC는 Enter로 보내고, 휴대폰은 Enter가 줄바꿈이다 (보내기 버튼·Ctrl+Enter로 보낸다)
    if (isSendKey(e.nativeEvent)) {
      e.preventDefault();
      submit(running ? "followUp" : undefined);
      return;
    }
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const step = e.key === "ArrowUp" ? -1 : 1;
      const el = e.currentTarget;
      if (el.selectionStart !== el.selectionEnd || !shouldNavigateHistory(value, el.selectionStart, step)) return;
      const state = browsing.current ?? { history: readHistory(), index: -1, draft: value };
      if (state.index < 0) state.index = state.history.length;
      const next = stepHistory(state.history, state.index, step);
      if (next === undefined) return;
      e.preventDefault();
      state.index = next;
      browsing.current = state;
      onChange(next === state.history.length ? state.draft : state.history[next]!);
    }
  }

  return (
    <footer
      className={`composer${dragging ? " dragging" : ""}`}
      onDragOver={(e) => {
        if (disabled || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      {showSuggestions && (
        <ul className="suggestions" role="listbox" aria-label={mode === "file" ? "파일" : "Pi 명령"}>
          {suggestions.map((item, i) => (
            <li
              key={item.key}
              role="option"
              aria-selected={i === selected}
              className={i === selected ? "selected" : undefined}
              onMouseDown={(e) => {
                // 입력창 포커스를 잃지 않도록 mousedown에서 처리한다.
                e.preventDefault();
                item.apply();
              }}
            >
              <span className="suggestion-name">{item.label}</span>
              <span className="suggestion-source">{item.kind}</span>
              {item.detail && <span className="suggestion-desc">{item.detail}</span>}
            </li>
          ))}
        </ul>
      )}
      {searchingFiles && (
        <ul className="suggestions" aria-live="polite">
          <li className="suggestion-loading">파일 찾는 중…</li>
        </ul>
      )}
      <div className="composer-input">
        {(images.length > 0 || attachError) && (
          <div className="attachments">
            {images.map((image) => (
              <figure key={image.id} className="attachment" title={`${image.name} · ${formatBytes(image.size)}`}>
                <img src={toDataUrl(image)} alt={image.name} />
                <button
                  type="button"
                  className="attachment-remove"
                  aria-label={`${image.name} 빼기`}
                  onClick={() => setImages((prev) => prev.filter((i) => i.id !== image.id))}
                >
                  ×
                </button>
              </figure>
            ))}
            {images.length > 0 && !acceptsImages && (
              <span className="attachment-note">지금 모델은 이미지를 받지 않아, 이미지 대신 "생략됨" 안내가 전달됩니다</span>
            )}
            {attachError && <span className="attachment-error">{attachError}</span>}
          </div>
        )}
      {pasteBox && !disabled && (
        <ImagePasteBox
          onFiles={(files) => {
            setPasteBox(false);
            void attach(files);
          }}
          onClose={() => setPasteBox(false)}
        />
      )}
      <ComposerGrip {...gripProps} />
      <textarea
        ref={textarea}
        placeholder={enterHint(placeholder)}
        value={value}
        onChange={(e) => {
          browsing.current = undefined;
          setCaret(e.target.selectionStart);
          onChange(e.target.value);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        disabled={disabled}
        rows={3}
        aria-autocomplete="list"
      />
      </div>
      <div className="actions">
        <div className="image-buttons">
          <button type="button" className="image-button" disabled={disabled} onClick={() => void pasteFromClipboard()} title="클립보드의 이미지 붙이기" aria-label="클립보드의 이미지 붙이기">
            📋
          </button>
          <button type="button" className="image-button" disabled={disabled} onClick={() => imageInput.current?.click()} title="이미지 고르기" aria-label="이미지 고르기">
            🖼
          </button>
          <input
            ref={imageInput}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            hidden
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = "";
              if (files.length > 0) void attach(files);
            }}
          />
        </div>
        {running && parsed.kind !== "bash" ? (
          <>
            <button type="button" disabled={parsed.kind === "empty"} onClick={() => submit("steer")} title="현재 턴이 끝나면 바로 끼워 넣기">
              Steer
            </button>
            <button type="button" disabled={parsed.kind === "empty"} onClick={() => submit("followUp")} title="작업이 모두 끝난 뒤 보내기">
              Follow-up
            </button>
          </>
        ) : (
          <button
            type="button"
            className="primary"
            disabled={disabled || parsed.kind === "empty"}
            onClick={() => submit()}
            title={parsed.kind === "bash" ? "셸 명령 실행" : undefined}
          >
            {parsed.kind === "bash" ? "실행" : "보내기"}
          </button>
        )}
        {running && (
          <button type="button" className="danger" onClick={onAbort}>
            중단
          </button>
        )}
      </div>
    </footer>
  );
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("파일을 읽지 못했습니다"));
    reader.readAsDataURL(file);
  });
}

function readHistory(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeHistory(history: string[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    // 저장하지 못해도 입력은 보낸다.
  }
}
