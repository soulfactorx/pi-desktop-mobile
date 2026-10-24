import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { TerminalOpenRequest } from "../shared/api";
import { clipboardKeyAction } from "./terminal-keys";
import {
  applyModifiers,
  dragToLines,
  InputMirror,
  isPrintable,
  DRAG_THRESHOLD_PX,
  keySequence,
  sgrWheel,
  toTerminalText,
  TOUCH_KEYS,
  type Modifier,
  type SendKey,
} from "./terminal-touch";
import {
  clearDebugLines,
  debugLines,
  debugLog,
  inputDebugEnabled,
  inputMode,
  onInputSettingsChange,
  setInputDebug,
  visible as shown,
} from "./terminal-input-settings";

/** 첫 입력은 Pi 화면이 다 그려지고 출력이 이만큼 잠잠해진 뒤 보낸다 */
const INITIAL_INPUT_QUIET_MS = 1200;
const MAC = /Mac/.test(navigator.platform);
/** 손가락으로 쓰는 기기(휴대폰·태블릿)면 기능키 줄을 보이고 끌기로 스크롤한다 (terminal-touch.ts) */
const TOUCH = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
const NO_MODIFIERS = { ctrl: false, alt: false };
/**
 * 기본 고정폭 글꼴(예전과 같다) 뒤에 흔한 Nerd Font를 둔다. 기본 글꼴에 없는 글자(eza·starship 등의 아이콘, 사설 영역)는
 * 설치된 Nerd Font로 그린다. 하나도 없으면 예전처럼 네모로 보인다.
 */
const TERMINAL_FONTS = [
  "ui-monospace",
  "Consolas",
  "'Cascadia Mono'",
  "monospace",
  "'Symbols Nerd Font Mono'",
  "'JetBrainsMono Nerd Font Mono'",
  "'MesloLGS Nerd Font Mono'",
  "'FiraCode Nerd Font Mono'",
  "'Hack Nerd Font Mono'",
  "'CaskaydiaCove Nerd Font Mono'",
  "'FantasqueSansM Nerd Font Mono'",
].join(", ");

export interface TerminalSpec extends Omit<TerminalOpenRequest, "cols" | "rows"> {
  /** 열린 뒤 대신 입력할 글 (예: "/login anthropic\r") */
  initialInput?: string;
}

/**
 * xterm.js로 그리는 터미널 하나 (설계 §4.12). 프로세스는 main이 node-pty로 띄운다.
 * 화면에서 빠지면 프로세스도 끝낸다. 복사·붙여넣기는 단축키(terminal-keys.ts)와 오른쪽 클릭 메뉴로 한다.
 * 터치 기기에서는 아래에 기능키 줄을 두고, 손가락 끌기를 휠 스크롤로 바꾼다 (terminal-touch.ts).
 */
export function TerminalView({
  spec,
  visible,
  onOpened,
  onExit,
}: {
  spec: TerminalSpec;
  visible: boolean;
  onOpened?: (title: string) => void;
  onExit?: (exitCode: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | undefined>(undefined);
  const termRef = useRef<Terminal | undefined>(undefined);
  /** 오른쪽 클릭 메뉴 (터미널 안 좌표) */
  const [menu, setMenu] = useState<{ x: number; y: number; hasSelection: boolean } | undefined>();
  const callbacks = useRef({ onOpened, onExit });
  callbacks.current = { onOpened, onExit };
  const idRef = useRef<string | undefined>(undefined);
  /** 켜 둔 Ctrl·Alt. 다음 입력 하나에 붙고 꺼진다 */
  const [modifiers, setModifiers] = useState(NO_MODIFIERS);
  const modifiersRef = useRef(NO_MODIFIERS);
  const setMods = (next: typeof NO_MODIFIERS) => {
    modifiersRef.current = next;
    setModifiers(next);
  };
  /** 켜 둔 Ctrl·Alt를 붙여 보내고 끈다 */
  const writeWithModifiers = (data: string) => {
    const id = idRef.current;
    if (!id) return;
    const mods = modifiersRef.current;
    if (mods.ctrl || mods.alt) {
      const out = applyModifiers(data, mods);
      debugLog(`→ ${shown(out)} (${mods.ctrl ? "Ctrl" : ""}${mods.alt ? "Alt" : ""})`);
      window.piDesktop.terminalWrite(id, out);
      setMods(NO_MODIFIERS);
    } else {
      debugLog(`→ ${shown(data)}`);
      window.piDesktop.terminalWrite(id, data);
    }
  };
  const writeRef = useRef(writeWithModifiers);
  writeRef.current = writeWithModifiers;
  /** 메뉴의 붙여넣기처럼 이벤트 없이 xterm으로 보내는 글을 "바로 입력"이 버리지 않게 한다 */
  const allowXtermTextRef = useRef<() => void>(() => {});
  // 입력 진단을 켰으면 기록이 바뀔 때마다 다시 그린다
  const [, setDebugTick] = useState(0);
  useEffect(() => onInputSettingsChange(() => setDebugTick((n) => n + 1)), []);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const styles = getComputedStyle(document.documentElement);
    const color = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
    const term = new Terminal({
      fontFamily: TERMINAL_FONTS,
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: { background: color("--bg", "#16171d"), foreground: color("--text", "#e6e7ec") },
    });
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    termRef.current = term;
    term.open(el);
    term.attachCustomKeyEventHandler((e) => {
      const action = clipboardKeyAction(e, MAC, term.hasSelection());
      if (!action) return true;
      if (e.type === "keydown" && action === "copy") {
        e.preventDefault();
        copySelection(term);
      }
      // 붙여넣기는 막지 않고 브라우저에 맡긴다. 브라우저가 낸 paste 이벤트를 xterm이 받아 입력한다 (괄호 붙여넣기 모드도 지킨다).
      return false;
    });
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      // 터미널 밖으로 넘치지 않게 오른쪽·아래 끝에서는 안으로 당긴다 (메뉴 크기 대략 220×120).
      const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width - 220));
      const y = Math.max(0, Math.min(e.clientY - rect.top, rect.height - 120));
      setMenu({ x, y, hasSelection: term.hasSelection() });
    };
    el.addEventListener("contextmenu", onContextMenu);
    try {
      fit.fit();
    } catch {
      // 숨겨진 상태면 크기를 잴 수 없다. 보일 때 다시 맞춘다.
    }

    let id: string | undefined;
    let disposed = false;
    // 터미널 ID를 받기 전에 온 출력도 버리지 않도록 모아 둔다.
    const early: Array<[string, string]> = [];
    let initialTimer: ReturnType<typeof setTimeout> | undefined;
    let initialSent = !spec.initialInput;
    const scheduleInitial = () => {
      if (initialSent) return;
      if (initialTimer) clearTimeout(initialTimer);
      initialTimer = setTimeout(() => {
        if (id && !initialSent) {
          initialSent = true;
          window.piDesktop.terminalWrite(id, spec.initialInput!);
        }
      }, INITIAL_INPUT_QUIET_MS);
    };

    const offData = window.piDesktop.onTerminalData((tid, data) => {
      if (!id) return void early.push([tid, data]);
      if (tid !== id) return;
      term.write(data);
      scheduleInitial();
    });
    const offExit = window.piDesktop.onTerminalExit((tid, exitCode) => {
      if (tid !== id) return;
      term.write(`\r\n\x1b[2m[종료됨 (코드 ${exitCode})]\x1b[0m\r\n`);
      callbacks.current.onExit?.(exitCode);
    });
    // 화면 키보드 입력 (터치 기기): 입력 칸의 값이 바뀔 때마다 지난 값과 비교해 바로 보낸다 (terminal-touch.ts의 InputMirror).
    // 이벤트는 xterm보다 먼저 받도록 바깥 요소에서 capture로 듣고, xterm의 처리는 막지 않는다.
    // 입력 칸의 글은 모두 여기서 보내므로, xterm이 보내는 글자는 입력 칸을 거치지 않는 진짜 키(블루투스 키보드처럼
    // keyCode가 229가 아닌 키, 붙여넣기)에서 온 것만 통과시킨다. xterm은 입력 칸에서 온 글을 조합 확정·insertText 뒤에
    // 잠깐 지나서(비동기로) 보내기도 해서, "언제 왔나"로는 가려낼 수 없다 (길게 눌러 넣는 기호가 두 번 들어가던 원인).
    // Enter·방향키 같은 제어 입력은 늘 그대로 둔다.
    /** 켜 둔 Ctrl·Alt를 붙이지 않고 그대로 보낸다 */
    const writeRaw = (data: string) => {
      if (!id || !data) return;
      debugLog(`→ ${shown(data)}`);
      window.piDesktop.terminalWrite(id, data);
    };
    /** 바로 입력 방식인지 (⋮ 메뉴에서 바꾸면 열린 터미널에도 바로 적용된다) */
    const live = () => TOUCH && inputMode() === "live";
    const mirror = new InputMirror();
    const textarea = term.textarea;
    let composing = false;
    /** 지금 xterm이 보내는 글자가 진짜 키(입력 칸을 거치지 않음)에서 온 것인지. 그 이벤트를 처리하는 동안만 켠다 */
    let realKey = false;
    let realKeyTimer: ReturnType<typeof setTimeout> | undefined;
    const allowXtermText = () => {
      realKey = true;
      if (realKeyTimer) clearTimeout(realKeyTimer);
      realKeyTimer = setTimeout(() => (realKey = false), 0);
    };
    allowXtermTextRef.current = allowXtermText;
    /** 지금 누른 키로 xterm이 이미 보낸 글자. 곧 입력 칸에도 들어오면 다시 보내지 않는다 (Shift 글자, 길게 눌러 넣는 기호 등). 키마다 새로 시작한다 */
    let keySent = "";
    let keySentConsumed = false;
    let keySentTimer: ReturnType<typeof setTimeout> | undefined;
    const onInput = (e: Event) => {
      if (e.target !== textarea || !textarea) return;
      const ie = e as InputEvent;
      debugLog(`input ${ie.inputType} data=${shown(ie.data ?? "")} value=${shown(textarea.value)}`);
      if (!live()) return;
      const { deletes, add: added } = mirror.update(textarea.value);
      writeRaw("\x7f".repeat(deletes));
      let add = added;
      if (keySent && add.startsWith(keySent)) {
        if (keySentConsumed) mirror.consumeFirstAdded(Array.from(add).length);
        add = add.slice(keySent.length);
        keySent = "";
      }
      if (!add) return;
      const text = toTerminalText(add);
      const mods = modifiersRef.current;
      if (mods.ctrl || mods.alt) {
        // 켜 둔 Ctrl·Alt는 새 글의 첫 글자에 붙이고, 그 글자는 나중에 지워도 DEL을 보내지 않게 한다
        writeRef.current(text[0]!);
        mirror.consumeFirstAdded(Array.from(add).length);
        writeRaw(text.slice(1));
      } else {
        writeRaw(text);
      }
      // 줄바꿈을 보냈으면 입력 칸을 비운다 (xterm이 Enter 키에서 하는 것과 같다)
      if (text.includes("\r") && !composing) {
        textarea.value = "";
        mirror.reset();
      }
    };
    const onCompositionStart = () => {
      debugLog("compositionstart");
      composing = true;
    };
    const onCompositionUpdate = (e: CompositionEvent) => debugLog(`compositionupdate ${shown(e.data ?? "")}`);
    const onCompositionEnd = (e: CompositionEvent) => {
      debugLog(`compositionend ${shown(e.data ?? "")}`);
      composing = false;
    };
    // xterm은 Enter·Ctrl+C 키와 포커스를 잃을 때 입력 칸을 비운다 (input 이벤트 없이). 따라서 비운다.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target !== textarea) return;
      debugLog(`keydown key=${shown(e.key)} code=${e.keyCode}${e.ctrlKey ? " ctrl" : ""}${e.shiftKey ? " shift" : ""}`);
      keySent = "";
      // 화면 키보드는 keyCode 229(조합 중)를 보낸다. 그 밖의 키는 입력 칸을 거치지 않고 xterm이 바로 보낸다.
      if (e.keyCode !== 229 && e.key !== "Unidentified") allowXtermText();
      if (e.key === "Enter" || (e.ctrlKey && (e.key === "c" || e.key === "C"))) {
        setTimeout(() => {
          if (textarea && textarea.value === "") mirror.reset();
        }, 0);
      }
    };
    const onFocusOut = () => mirror.reset();
    // keypress로 처리되는 글자(Shift 글자 등)와 붙여넣기도 xterm이 바로 보낸다
    const onKeyPress = (e: Event) => {
      if (e.target === textarea) allowXtermText();
    };
    const onPaste = () => allowXtermText();
    if (TOUCH) {
      el.addEventListener("input", onInput, true);
      el.addEventListener("keypress", onKeyPress, true);
      el.addEventListener("paste", onPaste, true);
      el.addEventListener("compositionstart", onCompositionStart, true);
      el.addEventListener("compositionupdate", onCompositionUpdate, true);
      el.addEventListener("compositionend", onCompositionEnd, true);
      el.addEventListener("keydown", onKeyDown, true);
      el.addEventListener("focusout", onFocusOut, true);
      // "바로 입력"은 입력한 글자를 셸이 바로 화면에 찍으므로 xterm의 조합 미리보기를 보이지 않게 한다. "단어 단위"는 미리보기가 있어야 한다.
      el.classList.toggle("live-input", live());
    }
    // 입력 칸에서 와서 이미 보낸 글자인지 (진짜 키·붙여넣기에서 온 것이 아니면 모두 그렇다)
    const isEcho = (data: string) => live() && isPrintable(data) && !realKey;
    const offSettings = onInputSettingsChange(() => el.classList.toggle("live-input", live()));
    const input = term.onData((data) => {
      if (isEcho(data)) {
        debugLog(`xterm ${shown(data)} → 버림 (이미 보냄)`);
        return;
      }
      debugLog(`xterm ${shown(data)}`);
      if (live() && isPrintable(data)) {
        const mods = modifiersRef.current;
        keySent = data;
        keySentConsumed = mods.ctrl || mods.alt;
        if (keySentTimer) clearTimeout(keySentTimer);
        keySentTimer = setTimeout(() => (keySent = ""), 100);
      }
      writeRef.current(data);
    });

    // 손가락 끌기 → 스크롤 (terminal-touch.ts). 일반 화면은 지난 출력을 스크롤한다. 마우스 신호를 받는 프로그램(Pi의 전체 화면 TUI 등)에는
    // 휠 신호를, 그 밖의 전체 화면 프로그램(less 등)에는 ↑·↓ 키를 보낸다.
    let touchY: number | undefined;
    let dragging = false;
    let startY = 0;
    let carry = 0;
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return void (touchY = undefined);
      touchY = startY = e.touches[0]!.clientY;
      dragging = false;
      carry = 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (touchY === undefined || e.touches.length !== 1) return;
      const y = e.touches[0]!.clientY;
      if (!dragging && Math.abs(y - startY) < DRAG_THRESHOLD_PX) return;
      dragging = true;
      e.preventDefault();
      const screen = el.querySelector<HTMLElement>(".xterm-screen");
      const lineHeight = screen && term.rows ? screen.clientHeight / term.rows : 17;
      const step = dragToLines(carry, touchY, y, lineHeight);
      touchY = y;
      carry = step.carry;
      if (!step.lines) return;
      const count = Math.abs(step.lines);
      if (term.modes.mouseTrackingMode !== "none") {
        // 손가락이 있는 칸에 휠을 굴린다 (Pi는 휠 아래의 영역을 스크롤한다)
        const rect = (screen ?? el).getBoundingClientRect();
        const col = Math.floor(((e.touches[0]!.clientX - rect.left) / rect.width) * term.cols) + 1;
        const row = Math.floor((y - rect.top) / lineHeight) + 1;
        if (id) window.piDesktop.terminalWrite(id, sgrWheel(step.lines > 0 ? "down" : "up", col, row).repeat(count));
      } else if (term.buffer.active.type === "alternate") {
        if (id) window.piDesktop.terminalWrite(id, keySequence(step.lines > 0 ? "down" : "up", term.modes.applicationCursorKeysMode).repeat(count));
      } else {
        term.scrollLines(step.lines);
      }
    };
    const onTouchEnd = () => {
      touchY = undefined;
    };
    if (TOUCH) {
      el.addEventListener("touchstart", onTouchStart, { passive: true });
      el.addEventListener("touchmove", onTouchMove, { passive: false });
      el.addEventListener("touchend", onTouchEnd);
      el.addEventListener("touchcancel", onTouchEnd);
    }

    void window.piDesktop
      .terminalOpen({ ...spec, cols: term.cols, rows: term.rows })
      .then((opened) => {
        if (disposed) return void window.piDesktop.terminalClose(opened.id);
        id = opened.id;
        idRef.current = id;
        for (const [tid, data] of early.splice(0)) if (tid === id) term.write(data);
        scheduleInitial();
        callbacks.current.onOpened?.(opened.title);
        term.focus();
      })
      .catch((e: unknown) => {
        term.write(`\x1b[31m터미널을 열지 못했습니다: ${e instanceof Error ? e.message : String(e)}\x1b[0m\r\n`);
        callbacks.current.onExit?.(-1);
      });

    // 크기가 바뀌면 열·행을 다시 맞추고 프로세스에 알린다.
    const observer = new ResizeObserver(() => {
      if (!el.offsetWidth || !el.offsetHeight) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      if (id) window.piDesktop.terminalResize(id, term.cols, term.rows);
    });
    observer.observe(el);

    return () => {
      disposed = true;
      if (initialTimer) clearTimeout(initialTimer);
      observer.disconnect();
      el.removeEventListener("contextmenu", onContextMenu);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
      offSettings();
      el.removeEventListener("input", onInput, true);
      el.removeEventListener("keypress", onKeyPress, true);
      el.removeEventListener("paste", onPaste, true);
      if (realKeyTimer) clearTimeout(realKeyTimer);
      if (keySentTimer) clearTimeout(keySentTimer);
      el.removeEventListener("compositionstart", onCompositionStart, true);
      el.removeEventListener("compositionupdate", onCompositionUpdate, true);
      el.removeEventListener("compositionend", onCompositionEnd, true);
      el.removeEventListener("keydown", onKeyDown, true);
      el.removeEventListener("focusout", onFocusOut, true);
      offData();
      offExit();
      input.dispose();
      if (id) window.piDesktop.terminalClose(id);
      termRef.current = undefined;
      term.dispose();
    };
    // 터미널은 처음 연 설정 그대로 유지한다 (spec이 바뀌어도 다시 띄우지 않는다).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!visible) return;
    requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        // 무시
      }
    });
  }, [visible]);

  // 메뉴 밖을 누르거나 Esc면 닫는다.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(undefined);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  const sendKey = (key: SendKey) => {
    const term = termRef.current;
    writeWithModifiers(keySequence(key, term?.modes.applicationCursorKeysMode ?? false));
  };
  const toggleModifier = (modifier: Modifier) => setMods({ ...modifiersRef.current, [modifier]: !modifiersRef.current[modifier] });

  const runMenu = (action: "copy" | "paste" | "selectAll") => {
    setMenu(undefined);
    const term = termRef.current;
    if (!term) return;
    if (action === "copy") copySelection(term);
    else if (action === "paste") void pasteClipboard(term, allowXtermTextRef.current);
    else term.selectAll();
    term.focus();
  };

  return (
    <div className="terminal-view" hidden={!visible}>
      <div className="terminal-screen" ref={host} />
      {TOUCH && inputDebugEnabled() && (
        <div className="terminal-debug" onMouseDown={(e) => e.preventDefault()}>
          <div className="terminal-debug-head">
            <strong>입력 진단</strong>
            <button type="button" className="small" onClick={() => void navigator.clipboard.writeText(debugLines().join("\n")).catch(() => {})}>
              복사
            </button>
            <button type="button" className="small" onClick={clearDebugLines}>
              지우기
            </button>
            <button type="button" className="small" onClick={() => setInputDebug(false)}>
              끄기
            </button>
          </div>
          <pre>{debugLines().slice(-14).join("\n") || "키보드로 몇 글자 입력해 보세요."}</pre>
        </div>
      )}
      {TOUCH && (
        // 버튼을 눌러도 터미널의 입력 칸이 포커스를 잃지 않게(화면 키보드가 닫히지 않게) mousedown을 막는다.
        <div className="terminal-keys" role="toolbar" aria-label="터미널 기능키" onMouseDown={(e) => e.preventDefault()}>
          {TOUCH_KEYS.map((k) =>
            k.kind === "modifier" ? (
              <button
                key={k.label}
                type="button"
                className={modifiers[k.modifier] ? "on" : undefined}
                aria-pressed={modifiers[k.modifier]}
                title={`${k.label}: 다음에 누르는 키 하나에 붙습니다`}
                onClick={() => toggleModifier(k.modifier)}
              >
                {k.label}
              </button>
            ) : (
              <button key={k.label} type="button" title={k.title ?? k.label} onClick={() => sendKey(k.key)}>
                {k.label}
              </button>
            ),
          )}
        </div>
      )}
      {menu && (
        <div className="terminal-menu" role="menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
          <button type="button" role="menuitem" disabled={!menu.hasSelection} onClick={() => runMenu("copy")}>
            복사 <kbd>{MAC ? "⌘C" : "Ctrl+Shift+C"}</kbd>
          </button>
          <button type="button" role="menuitem" onClick={() => runMenu("paste")}>
            붙여넣기 <kbd>{MAC ? "⌘V" : "Ctrl+Shift+V"}</kbd>
          </button>
          <button type="button" role="menuitem" onClick={() => runMenu("selectAll")}>
            모두 선택
          </button>
        </div>
      )}
    </div>
  );
}

function copySelection(term: Terminal): void {
  const text = term.getSelection();
  if (text) void navigator.clipboard.writeText(text).catch(() => {});
}

async function pasteClipboard(term: Terminal, beforePaste: () => void): Promise<void> {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      beforePaste();
      term.paste(text);
    }
  } catch {
    // 클립보드를 읽지 못하면 붙여넣지 않는다 (단축키는 브라우저 붙여넣기라 영향이 없다).
  }
}
