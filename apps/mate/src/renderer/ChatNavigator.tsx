import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";

/**
 * 긴 대화 찾아가기: 맨 위·맨 아래, 이전·다음 질문, 질문 목록에서 골라 가기, 단어 찾기.
 * 대화 스크롤 칸(scroller)의 맨 끝에 두면 오른쪽 아래에 떠 있다 (position: sticky).
 * 질문(대화 턴)은 turnSelector로 고른 요소다. 찾기는 화면의 글자를 그대로 훑고, 찾은 곳은 CSS Highlight로 칠한다
 * (화면 요소를 건드리지 않아 React와 부딪히지 않는다. 지원하지 않는 브라우저는 칠하지 않고 위치만 옮긴다).
 */
export function ChatNavigator({
  scroller,
  turnSelector,
  textSelector,
}: {
  scroller: RefObject<HTMLElement | null>;
  turnSelector: string;
  /** 질문 목록에 보일 글이 질문 요소 안의 일부(시각 등 제외)면 그 선택자 */
  textSelector?: string;
}) {
  const [panel, setPanel] = useState<"turns" | "search" | undefined>();
  const [scrollable, setScrollable] = useState(false);
  const [turns, setTurns] = useState<Array<{ index: number; text: string }>>([]);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Range[]>([]);
  const [current, setCurrent] = useState(-1);
  /** 접어 두면 작은 단추 하나만 보인다 (화면을 가리지 않게). 처음엔 접혀 있다 */
  const [open, setOpen] = useState(false);
  /** 지금 보고 있는 질문 (질문 목록에서 칠한다) */
  const [currentTurn, setCurrentTurn] = useState(-1);
  const turnList = useRef<HTMLOListElement>(null);
  const self = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);

  // 길어서 스크롤이 생길 때만 보인다
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const check = () => setScrollable(el.scrollHeight > el.clientHeight * 1.5);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    const mutations = new MutationObserver(check);
    mutations.observe(el, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      mutations.disconnect();
    };
  }, [scroller]);

  const turnElements = () => [...(scroller.current?.querySelectorAll<HTMLElement>(turnSelector) ?? [])];

  /** 스크롤 칸 안에서 요소(또는 범위)의 위쪽 위치 */
  const topOf = (rect: DOMRect) => {
    const el = scroller.current!;
    return rect.top - el.getBoundingClientRect().top + el.scrollTop;
  };

  const scrollTo = (top: number) => scroller.current?.scrollTo({ top: Math.max(0, top - 12), behavior: "smooth" });

  const flash = (el: HTMLElement) => {
    el.classList.add("chat-nav-flash");
    setTimeout(() => el.classList.remove("chat-nav-flash"), 1200);
  };

  const goTurn = (direction: -1 | 1) => {
    const el = scroller.current;
    if (!el) return;
    const tops = turnElements().map((t) => ({ t, top: topOf(t.getBoundingClientRect()) }));
    const now = el.scrollTop + 12;
    const target = direction < 0 ? tops.filter((x) => x.top < now - 4).at(-1) : tops.find((x) => x.top > now + 4);
    if (!target) return direction < 0 ? scrollTo(0) : scrollTo(el.scrollHeight);
    scrollTo(target.top);
    flash(target.t);
    setCurrentTurn(tops.indexOf(target));
  };

  const openTurns = () => {
    setTurns(
      turnElements().map((t, index) => {
        const source = (textSelector && t.querySelector(textSelector)) || t;
        return { index, text: (source.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || "(이미지)" };
      }),
    );
    setPanel((p) => (p === "turns" ? undefined : "turns"));
  };

  const jumpToTurn = (index: number) => {
    const target = turnElements()[index];
    if (!target) return;
    setPanel(undefined);
    scrollTo(topOf(target.getBoundingClientRect()));
    flash(target);
    setCurrentTurn(index);
  };

  // 찾기: 스크롤 칸의 글자에서 찾는다 (이 도구 자신은 빼고)
  const find = (text: string): Range[] => {
    const root = scroller.current;
    const needle = text.trim().toLowerCase();
    if (!root || !needle) return [];
    const found: Range[] = [];
    // 숨긴 요소(display: none 등) 안의 글자는 찾지 않는다. 접힌 칸(details) 안은 찾고, 그리로 갈 때 편다
    const hidden = new Map<Element, boolean>();
    const isHidden = (el: Element | null): boolean => {
      if (!el || el === root) return false;
      const known = hidden.get(el);
      if (known !== undefined) return known;
      const style = getComputedStyle(el);
      const result = style.display === "none" || style.visibility === "hidden" || isHidden(el.parentElement);
      hidden.set(el, result);
      return result;
    };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => (self.current?.contains(node) || isHidden(node.parentElement) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const value = (node.nodeValue ?? "").toLowerCase();
      for (let at = value.indexOf(needle); at !== -1 && found.length < 1000; at = value.indexOf(needle, at + needle.length)) {
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + needle.length);
        found.push(range);
      }
    }
    return found;
  };

  const paint = (ranges: Range[], index: number) => {
    const highlights = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
    const HighlightCtor = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
    if (!highlights || !HighlightCtor) return;
    highlights.delete("chat-search");
    highlights.delete("chat-search-current");
    if (ranges.length === 0) return;
    highlights.set("chat-search", new HighlightCtor(...ranges));
    if (ranges[index]) highlights.set("chat-search-current", new HighlightCtor(ranges[index]));
  };

  /** 찾은 곳이 접힌 칸(details) 안이면 펴고, 옆으로 스크롤되는 칸(코드 등) 안이면 옆으로 옮겨 보이게 한다 */
  const reveal = (range: Range) => {
    const el = scroller.current;
    let node: Node | null = range.startContainer;
    for (; node && node !== el; node = node.parentNode) {
      if (node instanceof HTMLDetailsElement && !node.open && !node.querySelector(":scope > summary")?.contains(range.startContainer)) node.open = true;
    }
    for (let box = range.startContainer.parentElement; box && box !== el; box = box.parentElement) {
      if (box.scrollWidth <= box.clientWidth + 1) continue;
      const outer = box.getBoundingClientRect();
      const rect = range.getBoundingClientRect();
      if (rect.left < outer.left || rect.right > outer.right) box.scrollLeft += rect.left - outer.left - box.clientWidth / 3;
    }
  };

  const show = (ranges: Range[], index: number) => {
    setMatches(ranges);
    setCurrent(index);
    paint(ranges, index);
    const range = ranges[index];
    const el = scroller.current;
    if (!range || !el) return;
    reveal(range);
    // 이미 보이는 곳이면 움직이지 않는다 (글자를 지우거나 고칠 때 화면이 튀지 않게)
    const box = el.getBoundingClientRect();
    const rect = range.getBoundingClientRect();
    if (rect.top >= box.top + 8 && rect.bottom <= box.bottom - 56) return;
    scrollTo(topOf(rect) - el.clientHeight / 3);
  };

  const search = (text: string) => {
    setQuery(text);
    const ranges = find(text);
    // 지금 보이는 곳의 첫 결과부터 (보이는 결과가 있으면 화면은 그대로)
    const el = scroller.current;
    const now = el ? el.scrollTop : 0;
    const first = ranges.findIndex((r) => topOf(r.getBoundingClientRect()) >= now - 2);
    show(ranges, ranges.length === 0 ? -1 : first === -1 ? 0 : first);
  };

  const step = (direction: -1 | 1) => {
    // 대화가 바뀌어 범위가 끊겼으면 다시 찾는다
    let ranges = matches;
    if (ranges.some((r) => !r.startContainer.isConnected)) ranges = find(query);
    if (ranges.length === 0) return show([], -1);
    show(ranges, (Math.max(current, 0) + direction + ranges.length) % ranges.length);
  };

  const closePanel = () => {
    setPanel(undefined);
    paint([], -1);
    setMatches([]);
    setCurrent(-1);
  };

  useEffect(() => {
    if (panel === "search") searchInput.current?.focus();
  }, [panel]);

  // 질문 목록이 열려 있으면 스크롤할 때마다 지금 보는 질문을 칠한다
  useEffect(() => {
    const el = scroller.current;
    if (panel !== "turns" || !el) return;
    const update = () => {
      const now = el.scrollTop + 24;
      const tops = turnElements().map((t) => topOf(t.getBoundingClientRect()));
      let index = -1;
      for (let i = 0; i < tops.length; i++) if (tops[i]! <= now) index = i;
      setCurrentTurn(index === -1 && tops.length ? 0 : index);
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    return () => el.removeEventListener("scroll", update);
  }, [panel]);

  // 칠한 질문이 목록에서 보이게. scrollIntoView는 대화 칸까지 움직이므로 목록만 직접 옮긴다
  useEffect(() => {
    const list = turnList.current;
    const item = list?.querySelector<HTMLElement>(`[data-turn="${currentTurn}"]`);
    if (!list || !item) return;
    if (item.offsetTop < list.scrollTop) list.scrollTop = item.offsetTop;
    else if (item.offsetTop + item.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = item.offsetTop + item.offsetHeight - list.clientHeight;
  }, [currentTurn, panel]);

  // 화면을 떠나면 칠한 것을 지운다
  useEffect(() => () => paint([], -1), []);

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closePanel();
    }
  };

  if (!scrollable && !panel) return null;

  return (
    <div className="chat-nav" ref={self}>
      <div className="chat-nav-inner">
        {panel === "turns" && (
          <div
            className="chat-nav-panel"
            role="dialog"
            aria-label="질문 목록"
            // 대화 칸 높이를 넘지 않게 (넘으면 위가 잘려 누를 수 없다)
            style={{ maxHeight: Math.max(120, (scroller.current?.clientHeight ?? 400) - 64) }}
          >
            <div className="chat-nav-panel-head">
              <strong>질문 {turns.length}개</strong>
              <button type="button" onClick={closePanel} aria-label="닫기">
                ×
              </button>
            </div>
            {turns.length === 0 ? (
              <p className="chat-nav-empty">아직 질문이 없습니다</p>
            ) : (
              <ol className="chat-nav-turns" ref={turnList}>
                {turns.map((t) => (
                  <li key={t.index} data-turn={t.index} className={t.index === currentTurn ? "current" : undefined}>
                    <button type="button" onClick={() => jumpToTurn(t.index)}>
                      <span className="chat-nav-turn-no">{t.index + 1}</span>
                      <span className="chat-nav-turn-text">{t.text}</span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
        {panel === "search" && (
          <div className="chat-nav-search" role="search">
            <input
              ref={searchInput}
              value={query}
              placeholder="대화에서 찾기"
              aria-label="대화에서 찾기"
              onChange={(e) => search(e.target.value)}
              onKeyDown={onSearchKey}
            />
            <span className="chat-nav-count">{query.trim() ? (matches.length ? `${current + 1}/${matches.length}` : "0/0") : ""}</span>
            <button type="button" onClick={() => step(-1)} disabled={matches.length === 0} title="이전 찾은 곳 (Shift+Enter)" aria-label="이전 찾은 곳">
              ↑
            </button>
            <button type="button" onClick={() => step(1)} disabled={matches.length === 0} title="다음 찾은 곳 (Enter)" aria-label="다음 찾은 곳">
              ↓
            </button>
            <button type="button" onClick={closePanel} aria-label="찾기 닫기">
              ×
            </button>
          </div>
        )}
        {!open && !panel ? (
          <div className="chat-nav-bar collapsed">
            <button type="button" onClick={() => setOpen(true)} title="대화 이동 도구" aria-label="대화 이동 도구 펴기">
              ⇅
            </button>
          </div>
        ) : (
        <div className="chat-nav-bar">
          <button type="button" onClick={() => scrollTo(0)} title="맨 위로" aria-label="맨 위로">
            ⤒
          </button>
          <button type="button" onClick={() => goTurn(-1)} title="이전 질문" aria-label="이전 질문">
            ↑
          </button>
          <button type="button" onClick={() => goTurn(1)} title="다음 질문" aria-label="다음 질문">
            ↓
          </button>
          <button type="button" onClick={() => scrollTo(scroller.current?.scrollHeight ?? 0)} title="맨 아래로" aria-label="맨 아래로">
            ⤓
          </button>
          <button type="button" className={panel === "turns" ? "on" : ""} onClick={openTurns} title="질문 목록" aria-label="질문 목록">
            ☰
          </button>
          <button
            type="button"
            className={panel === "search" ? "on" : ""}
            onClick={() => (panel === "search" ? closePanel() : setPanel("search"))}
            title="대화에서 찾기"
            aria-label="대화에서 찾기"
          >
            🔍
          </button>
          <button
            type="button"
            onClick={() => {
              closePanel();
              setOpen(false);
            }}
            title="접기"
            aria-label="대화 이동 도구 접기"
          >
            ›
          </button>
        </div>
        )}
      </div>
    </div>
  );
}
