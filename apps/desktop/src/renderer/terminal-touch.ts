/**
 * 터치 기기(휴대폰 브라우저로 연 pi-web)의 내장 터미널 보조 (설계 §4.12, §5.10). 화면과 분리한 순수 함수.
 *
 * - 기능키 줄: 화면 키보드에 없는 Esc·Tab·방향키 등을 버튼으로 보낸다. 방향키·Home·End는 터미널이
 *   "응용 커서 키" 모드(DECCKM, vim·less·Pi TUI 등이 켠다)면 ESC O 형식으로 보낸다 (xterm과 같다).
 * - Ctrl·Alt는 한 번 누르면 켜져 다음에 입력하는 키 하나에 붙는다 (Termux의 추가 키와 같은 방식).
 * - 손가락 끌기는 스크롤로 바꾼다. 몇 픽셀 이상 움직여야 끌기로 보고, 그보다 짧으면 탭(키보드 열기)으로 둔다.
 *   일반 화면은 지난 출력을 스크롤하고, 전체 화면 프로그램(대체 화면: pi TUI·less·vim)에는 ↑·↓ 키를 보낸다
 *   (xterm이 대체 화면에서 마우스 휠을 처리하는 방식과 같다).
 */

export type TouchKey =
  | { kind: "send"; label: string; key: SendKey; title?: string }
  | { kind: "modifier"; label: string; modifier: Modifier };

export type Modifier = "ctrl" | "alt";

export type SendKey =
  | "esc"
  | "tab"
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "pageUp"
  | "pageDown"
  | "ctrlC"
  | { text: string };

export const TOUCH_KEYS: TouchKey[] = [
  { kind: "send", label: "Esc", key: "esc" },
  { kind: "send", label: "Tab", key: "tab" },
  { kind: "modifier", label: "Ctrl", modifier: "ctrl" },
  { kind: "modifier", label: "Alt", modifier: "alt" },
  { kind: "send", label: "←", key: "left", title: "왼쪽" },
  { kind: "send", label: "↓", key: "down", title: "아래" },
  { kind: "send", label: "↑", key: "up", title: "위" },
  { kind: "send", label: "→", key: "right", title: "오른쪽" },
  { kind: "send", label: "Home", key: "home" },
  { kind: "send", label: "End", key: "end" },
  { kind: "send", label: "PgUp", key: "pageUp" },
  { kind: "send", label: "PgDn", key: "pageDown" },
  { kind: "send", label: "^C", key: "ctrlC", title: "Ctrl+C (멈추기)" },
  { kind: "send", label: "/", key: { text: "/" } },
  { kind: "send", label: "-", key: { text: "-" } },
  { kind: "send", label: "|", key: { text: "|" } },
  { kind: "send", label: "~", key: { text: "~" } },
];

const CURSOR: Record<"up" | "down" | "right" | "left" | "home" | "end", string> = {
  up: "A",
  down: "B",
  right: "C",
  left: "D",
  home: "H",
  end: "F",
};

/** 버튼 하나가 보낼 글. applicationCursor는 터미널의 DECCKM 상태 */
export function keySequence(key: SendKey, applicationCursor: boolean): string {
  if (typeof key === "object") return key.text;
  switch (key) {
    case "esc":
      return "\x1b";
    case "tab":
      return "\t";
    case "pageUp":
      return "\x1b[5~";
    case "pageDown":
      return "\x1b[6~";
    case "ctrlC":
      return "\x03";
    default:
      return `\x1b${applicationCursor ? "O" : "["}${CURSOR[key]}`;
  }
}

/**
 * 켜 둔 Ctrl·Alt를 입력에 붙인다.
 * - Ctrl: 글자 하나(영문자, @ [ \ ] ^ _ ?, 공백)를 제어 문자로 바꾼다. 그 밖(한글, 여러 글자, 이미 제어 문자)은 그대로
 * - Alt: 앞에 ESC를 붙인다 (Meta를 ESC로 보내는 터미널 관례)
 */
export function applyModifiers(data: string, modifiers: { ctrl: boolean; alt: boolean }): string {
  let out = data;
  if (modifiers.ctrl && out.length === 1) {
    const c = out;
    if (/^[a-zA-Z]$/.test(c)) out = String.fromCharCode(c.toUpperCase().charCodeAt(0) & 0x1f);
    else if (c === " " || c === "@") out = "\x00";
    else if ("[\\]^_".includes(c)) out = String.fromCharCode(c.charCodeAt(0) & 0x1f);
    else if (c === "?") out = "\x7f";
  }
  if (modifiers.alt) out = `\x1b${out}`;
  return out;
}

/** 끌기로 보는 최소 이동 (px). 이보다 짧으면 탭으로 둔다 */
export const DRAG_THRESHOLD_PX = 8;

/**
 * 손가락 끌기를 스크롤 줄 수로 바꾼다. 손가락을 내리면 위쪽(지난 출력)을 보므로 음수, 올리면 양수.
 * 줄 높이에 못 미친 나머지(carry)는 다음 움직임에 더한다.
 */
export function dragToLines(carry: number, previousY: number, currentY: number, lineHeight: number): { lines: number; carry: number } {
  const total = carry + (previousY - currentY);
  const lines = lineHeight > 0 ? Math.trunc(total / lineHeight) : 0;
  return { lines, carry: total - lines * lineHeight };
}

/**
 * 마우스 휠 한 칸을 SGR 마우스 보고(ESC [ < 64/65 ; 열 ; 행 M)로 만든다. 열·행은 1부터.
 * 마우스 신호를 받겠다고 켠 프로그램(Pi의 전체 화면 TUI 등)은 ↑·↓ 키 대신 이것으로 스크롤한다.
 * 요즘 프로그램은 거의 SGR 형식(1006)을 켜므로 이 형식만 쓴다.
 */
export function sgrWheel(direction: "up" | "down", col: number, row: number): string {
  return `\x1b[<${direction === "up" ? 64 : 65};${Math.max(1, col)};${Math.max(1, row)}M`;
}

/**
 * 화면 키보드의 단어 조합 중 바로 보낼 글을 정한다.
 *
 * 삼성·Gboard 키보드는 영어도 단어 단위로 조합하다가 스페이스·엔터에서 확정하고, xterm은 확정될 때만 입력을 보낸다.
 * 그래서 조합 중인 글이 출력 가능한 ASCII뿐이면 바뀐 만큼을 바로 보낸다(지운 글자는 DEL). 한글처럼 ASCII가 아니면
 * 자모를 조합해야 하므로 바로 보내지 않고(eager: false) 확정을 기다린다.
 */
export function compositionStep(sent: string, composing: string): { send: string; sent: string; eager: boolean } {
  if (!/^[\x20-\x7e]*$/.test(composing)) return { send: "", sent, eager: false };
  let common = 0;
  while (common < sent.length && common < composing.length && sent[common] === composing[common]) common++;
  return { send: "\x7f".repeat(sent.length - common) + composing.slice(common), sent: composing, eager: true };
}

/**
 * 조합이 끝나 xterm이 확정된 글을 보낼 때, 이미 바로 보낸 부분(sent)을 빼고 보낼 글.
 * 키보드가 확정하며 단어를 고쳤으면(자동 수정) 보낸 만큼 지우고 확정된 글을 다시 보낸다.
 */
export function committedRemainder(sent: string, committed: string): string {
  if (committed.startsWith(sent)) return committed.slice(sent.length);
  return "\x7f".repeat(sent.length) + committed;
}
