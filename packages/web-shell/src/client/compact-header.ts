/**
 * 휴대폰에서 대화창 위의 정보 줄(대시보드)을 접었다 펴기. 가상 키보드가 뜨면 화면이 좁아지므로 저절로 접는다.
 * - 대화창(anchor) 위 가운데에 작은 단추(⌃ 접기 / ⌄ 펴기)를 띄운다. 좁은 화면(720px 이하)에서만 보인다
 * - 접으면 hide에 적은 요소를 감춘다 (body.ws-compact)
 * - 키보드가 열려 있는 동안은 저절로 접고, 닫히면 사용자가 고른 상태로 돌아간다. 키보드가 열린 채 펴면 그대로 둔다
 * 앱 화면을 고치지 않고 웹에서만 덧붙인다.
 */
export function setupCompactHeader(options: { hide: string[]; anchor: string; key: string }): void {
  const style = document.createElement("style");
  style.textContent = `
.ws-compact-toggle {
  display: none;
  position: fixed;
  z-index: 1500;
  transform: translateX(-50%);
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 20px;
  padding: 0;
  border: 1px solid var(--border, #444);
  border-top: none;
  border-radius: 0 0 10px 10px;
  background: var(--panel, #1e2028);
  color: var(--muted, #999);
  font-size: 13px;
  line-height: 1;
  opacity: 0.85;
  cursor: pointer;
}
@media (max-width: 720px) {
  body.ws-compact :is(${options.hide.join(", ")}) { display: none !important; }
  .ws-compact-toggle { display: flex; }
}
.ws-compact-toggle[hidden] { display: none !important; }
`;
  document.head.append(style);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "ws-compact-toggle";
  document.body.append(button);

  let collapsed = read(options.key) === "1";
  let keyboard = false;
  /** 키보드가 열린 채 사용자가 편 경우 (키보드가 닫힐 때까지 펴 둔다) */
  let openWhileKeyboard = false;
  let tallest = window.innerHeight;

  const compact = () => collapsed || (keyboard && !openWhileKeyboard);
  const render = () => {
    const on = compact();
    document.body.classList.toggle("ws-compact", on);
    button.textContent = on ? "⌄" : "⌃";
    button.title = on ? "위쪽 정보 펴기" : "위쪽 정보 접기";
    button.setAttribute("aria-label", button.title);
    place();
  };
  /** 펴 있으면 정보 줄 바로 아래, 접혀 있으면 anchor(정보 줄을 담은 화면) 맨 위에 둔다 */
  const place = () => {
    const visible = (el: HTMLElement) => el.offsetParent !== null;
    const headers = options.hide.flatMap((sel) => [...document.querySelectorAll<HTMLElement>(sel)]).filter(visible);
    const anchor = [...document.querySelectorAll<HTMLElement>(options.anchor)].find(visible);
    let top: number;
    let rect: DOMRect;
    if (headers.length > 0) {
      rect = headers.map((h) => h.getBoundingClientRect()).reduce((a, b) => (b.bottom > a.bottom ? b : a));
      top = rect.bottom;
    } else if (anchor) {
      rect = anchor.getBoundingClientRect();
      top = rect.top;
    } else {
      button.hidden = true;
      return;
    }
    button.hidden = false;
    button.style.top = `${Math.max(0, top)}px`;
    button.style.left = `${rect.left + rect.width / 2}px`;
  };

  button.addEventListener("pointerdown", (event) => event.preventDefault()); // 입력창 초점(키보드)을 지키게
  button.addEventListener("click", () => {
    if (compact()) {
      collapsed = false;
      if (keyboard) openWhileKeyboard = true;
    } else {
      collapsed = true;
      openWhileKeyboard = false;
    }
    write(options.key, collapsed ? "1" : "0");
    render();
  });

  // 키보드: 글 입력칸에 초점이 있고 화면 높이가 크게 줄었으면 열린 것으로 본다
  const checkKeyboard = () => {
    const height = window.visualViewport?.height ?? window.innerHeight;
    tallest = Math.max(tallest, window.innerHeight, height);
    const active = document.activeElement;
    const typing = active instanceof HTMLTextAreaElement || (active instanceof HTMLInputElement && !["checkbox", "radio", "button"].includes(active.type)) || (active as HTMLElement | null)?.isContentEditable === true;
    const open = typing && height < tallest * 0.75;
    if (open !== keyboard) {
      keyboard = open;
      if (!open) openWhileKeyboard = false;
      render();
    }
  };
  window.visualViewport?.addEventListener("resize", checkKeyboard);
  window.addEventListener("resize", checkKeyboard);
  document.addEventListener("focusin", () => setTimeout(checkKeyboard, 300));
  document.addEventListener("focusout", () => setTimeout(checkKeyboard, 300));

  // 화면이 바뀌면(세션을 열거나 닫으면) 단추 자리를 다시 잡는다
  new ResizeObserver(place).observe(document.body);
  new MutationObserver(() => requestAnimationFrame(place)).observe(document.body, { childList: true, subtree: true });
  render();
}

function read(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 저장할 수 없으면 이번만
  }
}
