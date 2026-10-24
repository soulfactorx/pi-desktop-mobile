import { describe, expect, it } from "vitest";
import { applyModifiers, dragToLines, InputMirror, isPrintable, keySequence, sgrWheel, toTerminalText, TOUCH_KEYS } from "../../src/renderer/terminal-touch";

describe("keySequence", () => {
  it("방향키·Home·End는 응용 커서 키 모드면 ESC O, 아니면 ESC [", () => {
    expect(keySequence("up", false)).toBe("\x1b[A");
    expect(keySequence("up", true)).toBe("\x1bOA");
    expect(keySequence("left", false)).toBe("\x1b[D");
    expect(keySequence("home", false)).toBe("\x1b[H");
    expect(keySequence("end", true)).toBe("\x1bOF");
  });

  it("그 밖의 키", () => {
    expect(keySequence("esc", false)).toBe("\x1b");
    expect(keySequence("tab", true)).toBe("\t");
    expect(keySequence("pageUp", false)).toBe("\x1b[5~");
    expect(keySequence("pageDown", true)).toBe("\x1b[6~");
    expect(keySequence("ctrlC", false)).toBe("\x03");
    expect(keySequence({ text: "|" }, false)).toBe("|");
  });

  it("기능키 줄에 Ctrl·Alt와 방향키가 있다", () => {
    const labels = TOUCH_KEYS.map((k) => k.label);
    for (const l of ["Esc", "Tab", "Ctrl", "Alt", "↑", "↓", "←", "→"]) expect(labels).toContain(l);
  });
});

describe("applyModifiers", () => {
  it("Ctrl은 글자 하나를 제어 문자로 바꾼다", () => {
    expect(applyModifiers("c", { ctrl: true, alt: false })).toBe("\x03");
    expect(applyModifiers("C", { ctrl: true, alt: false })).toBe("\x03");
    expect(applyModifiers("d", { ctrl: true, alt: false })).toBe("\x04");
    expect(applyModifiers("[", { ctrl: true, alt: false })).toBe("\x1b");
    expect(applyModifiers(" ", { ctrl: true, alt: false })).toBe("\x00");
    expect(applyModifiers("?", { ctrl: true, alt: false })).toBe("\x7f");
  });

  it("Ctrl은 바꿀 수 없는 입력(한글, 여러 글자, 기호)을 그대로 둔다", () => {
    expect(applyModifiers("한", { ctrl: true, alt: false })).toBe("한");
    expect(applyModifiers("ls", { ctrl: true, alt: false })).toBe("ls");
    expect(applyModifiers("\x1b[A", { ctrl: true, alt: false })).toBe("\x1b[A");
  });

  it("Alt는 앞에 ESC를 붙이고, Ctrl과 함께 쓸 수 있다", () => {
    expect(applyModifiers("b", { ctrl: false, alt: true })).toBe("\x1bb");
    expect(applyModifiers("x", { ctrl: true, alt: true })).toBe("\x1b\x18");
  });

  it("아무것도 켜지 않았으면 그대로", () => {
    expect(applyModifiers("a", { ctrl: false, alt: false })).toBe("a");
  });
});

describe("dragToLines", () => {
  it("손가락을 내리면 위쪽(음수), 올리면 아래쪽(양수)으로 줄 단위로 넘긴다", () => {
    expect(dragToLines(0, 100, 140, 20)).toEqual({ lines: -2, carry: 0 });
    expect(dragToLines(0, 140, 100, 20)).toEqual({ lines: 2, carry: 0 });
  });

  it("줄 높이에 못 미친 만큼은 모아 두었다가 다음에 넘긴다", () => {
    const first = dragToLines(0, 100, 90, 20);
    expect(first).toEqual({ lines: 0, carry: 10 });
    expect(dragToLines(first.carry, 90, 75, 20)).toEqual({ lines: 1, carry: 5 });
  });
});

describe("sgrWheel", () => {
  it("휠 위·아래를 SGR 마우스 보고로 만든다 (열·행은 1부터)", () => {
    expect(sgrWheel("up", 10, 5)).toBe("\x1b[<64;10;5M");
    expect(sgrWheel("down", 1, 1)).toBe("\x1b[<65;1;1M");
    expect(sgrWheel("down", 0, -3)).toBe("\x1b[<65;1;1M");
  });
});

describe("InputMirror", () => {
  it("입력 칸의 값이 늘면 늘어난 만큼 바로 보낸다 (스페이스·엔터를 기다리지 않는다)", () => {
    const m = new InputMirror();
    expect(m.update("l")).toEqual({ deletes: 0, add: "l" });
    expect(m.update("ls")).toEqual({ deletes: 0, add: "s" });
    expect(m.update("ls ")).toEqual({ deletes: 0, add: " " });
  });

  it("처음 연 입력 칸의 첫 글자도 바로 보낸다", () => {
    const m = new InputMirror();
    expect(m.update("p")).toEqual({ deletes: 0, add: "p" });
  });

  it("지운 글자는 DEL 수로, 키보드가 고친 단어는 달라진 곳부터 지우고 다시 보낸다", () => {
    const m = new InputMirror();
    m.update("teh");
    expect(m.update("te")).toEqual({ deletes: 1, add: "" });
    expect(m.update("the")).toEqual({ deletes: 1, add: "he" });
  });

  it("한글 조합은 바뀔 때마다 지우고 다시 쓴다", () => {
    const m = new InputMirror();
    expect(m.update("ㅎ")).toEqual({ deletes: 0, add: "ㅎ" });
    expect(m.update("하")).toEqual({ deletes: 1, add: "하" });
    expect(m.update("한")).toEqual({ deletes: 1, add: "한" });
    expect(m.update("한ㄱ")).toEqual({ deletes: 0, add: "ㄱ" });
  });

  it("Ctrl·Alt로 보낸 글자는 지워져도 DEL을 보내지 않는다 (두 번째, 세 번째도 같다)", () => {
    const m = new InputMirror();
    m.update("echo a");
    // Ctrl + c
    expect(m.update("echo ac")).toEqual({ deletes: 0, add: "c" });
    m.consumeFirstAdded(1);
    // 키보드가 c를 지움 → DEL 없음
    expect(m.update("echo a")).toEqual({ deletes: 0, add: "" });
    // 다시 Ctrl + d
    expect(m.update("echo ad")).toEqual({ deletes: 0, add: "d" });
    m.consumeFirstAdded(1);
    // 이어서 보통 글자 x, 그리고 단어 전체를 지움 → 보통 글자(echo a, x)만큼만 DEL
    expect(m.update("echo adx")).toEqual({ deletes: 0, add: "x" });
    expect(m.update("")).toEqual({ deletes: 7, add: "" });
  });

  it("밖에서 비운 뒤(reset)에는 새 값만 보낸다", () => {
    const m = new InputMirror();
    m.update("pwd");
    m.reset();
    expect(m.update("l")).toEqual({ deletes: 0, add: "l" });
  });
});

describe("toTerminalText · isPrintable", () => {
  it("줄바꿈은 CR로", () => {
    expect(toTerminalText("ls\n")).toBe("ls\r");
    expect(toTerminalText("a\r\nb")).toBe("a\rb");
  });

  it("글자만 있으면 글자 입력, 제어 입력(Enter·Tab·DEL·ESC)은 아니다", () => {
    expect(isPrintable("ls")).toBe(true);
    expect(isPrintable("한")).toBe(true);
    expect(isPrintable("\r")).toBe(false);
    expect(isPrintable("\x7f")).toBe(false);
    expect(isPrintable("\x1b[A")).toBe(false);
    expect(isPrintable("")).toBe(false);
  });
});
