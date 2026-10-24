/**
 * 터치 기기 터미널의 입력 설정과 입력 진단 (설계 §5.10). 웹(pi-web)의 ⋮ 메뉴에서 바꾼다.
 *
 * - 입력 방식: "live"(입력 칸의 값을 따라가 바로 보낸다, InputMirror)와 "xterm"(xterm 기본: 화면 키보드의 단어가 확정될 때 보낸다).
 *   키보드마다 이벤트가 달라 live가 맞지 않는 기기가 있으면 다시 설치하지 않고 xterm으로 돌릴 수 있게 한다.
 * - 입력 진단: 켜면 터미널 위에 키보드 이벤트와 셸에 보낸 글자를 보여 준다. 실제 기기에서 무엇이 오는지 알아내는 데 쓴다.
 *
 * 둘 다 이 브라우저에만 기억한다 (localStorage). 바꾸면 열린 터미널에도 바로 적용된다.
 */

export type InputMode = "live" | "xterm";

const MODE_KEY = "pi-web-terminal-input";
const DEBUG_KEY = "pi-web-input-debug";
const MAX_LINES = 60;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // 저장할 수 없으면 이번 화면에서만 쓴다
  }
}

let mode: InputMode = read(MODE_KEY) === "xterm" ? "xterm" : "live";
let debug = read(DEBUG_KEY) === "1";
const lines: string[] = [];
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function inputMode(): InputMode {
  return mode;
}

export function setInputMode(next: InputMode): void {
  mode = next;
  write(MODE_KEY, next === "live" ? null : next);
  debugLog(`입력 방식: ${next === "live" ? "바로 입력" : "단어 단위(xterm)"}`);
  notify();
}

export function inputDebugEnabled(): boolean {
  return debug;
}

export function setInputDebug(on: boolean): void {
  debug = on;
  write(DEBUG_KEY, on ? "1" : null);
  if (!on) lines.length = 0;
  notify();
}

/** 진단이 켜져 있을 때만 한 줄 남긴다. 글자는 눈에 보이게 바꾼다 (제어 문자 → \x1b 등) */
export function debugLog(line: string): void {
  if (!debug) return;
  const time = new Date().toISOString().slice(17, 23);
  lines.push(`${time} ${line}`);
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
  notify();
}

export function debugLines(): readonly string[] {
  return lines;
}

export function clearDebugLines(): void {
  lines.length = 0;
  notify();
}

/** 설정·진단이 바뀌면 알린다. 해제 함수를 돌려준다 */
export function onInputSettingsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 진단 기록용: 보이지 않는 글자를 읽을 수 있게 */
export function visible(text: string): string {
  return JSON.stringify(text);
}
