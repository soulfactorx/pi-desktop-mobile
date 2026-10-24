import { describe, expect, it } from "vitest";
import { applyModifiers, committedRemainder, compositionStep, dragToLines, keySequence, sgrWheel, TOUCH_KEYS } from "../../src/renderer/terminal-touch";

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

describe("compositionStep", () => {
  it("영문 조합은 늘어난 만큼 바로 보낸다", () => {
    let state = compositionStep("", "l");
    expect(state).toEqual({ send: "l", sent: "l", eager: true });
    state = compositionStep(state.sent, "ls");
    expect(state).toEqual({ send: "s", sent: "ls", eager: true });
  });

  it("조합 중 지운 글자는 DEL로, 바뀐 글자는 지우고 다시 보낸다", () => {
    expect(compositionStep("ls", "l")).toEqual({ send: "\x7f", sent: "l", eager: true });
    expect(compositionStep("teh", "the")).toEqual({ send: "\x7f\x7fhe", sent: "the", eager: true });
  });

  it("한글처럼 ASCII가 아니면 바로 보내지 않는다", () => {
    expect(compositionStep("", "ㅎ")).toEqual({ send: "", sent: "", eager: false });
    expect(compositionStep("a", "a한")).toEqual({ send: "", sent: "a", eager: false });
  });
});

describe("committedRemainder", () => {
  it("확정된 글에서 이미 보낸 부분을 뺀다", () => {
    expect(committedRemainder("ls", "ls")).toBe("");
    expect(committedRemainder("a", "a한")).toBe("한");
  });

  it("키보드가 확정하며 고쳤으면 지우고 다시 보낸다", () => {
    expect(committedRemainder("teh", "the")).toBe("\x7f\x7f\x7fthe");
  });
});
