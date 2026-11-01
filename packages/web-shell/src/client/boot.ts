import { CLICK_OPEN, ShellChannels, WebPaths, type Control, type DialogRequest, type DirListing, type MenuGroup } from "../protocol";
import { useTransport } from "./electron-renderer";
import { checkNotifications, onNotificationOpen, reportVisibility, setupNotifications } from "./notify";
import { watchSharedImages } from "./share";
import { showVersion } from "./version";
import { ResumableTransport, type LinkStatus } from "./transport";
import "./shell.css";

/**
 * 웹 껍데기 화면의 시작점 (설계 DESIGN.md §5.11). Electron 앱의 창 자리를 맡는다.
 *
 * 1. 토큰: 서버가 알려 준 주소(http://127.0.0.1:<포트>/#token=…)의 # 뒤에서 읽어 이 브라우저에 기억하고 주소창에서 지운다
 * 2. 서버에 토큰이 맞는지 묻는다. 없거나 틀리면 토큰을 넣는 화면을 보여 준다
 * 3. 이어지는 연결을 열고, 앱의 preload와 화면을 불러온다 (loadApp)
 * 4. 서버가 시키는 일(메뉴, 대화상자, 알림, 새로 읽기, 링크 열기)을 화면 위에 띄운다
 */

export interface BootOptions {
  /** 토큰 화면 등에 보일 이름 */
  title: string;
  /** 토큰 주소를 다시 볼 명령 (예: pi-web agent url) */
  urlCommand: string;
  /** 연결이 열린 뒤 앱의 preload와 화면을 불러온다 */
  loadApp: () => Promise<unknown>;
  /**
   * 좁은 화면(휴대폰)에서 옆 메뉴를 서랍으로 연다. 위쪽 띠에 ☰와 이름을 두고, body에 ws-has-bar·ws-drawer-open을 붙인다.
   * 서랍 모양(위치·숨기기)은 앱별 web.css가 panel 선택자로 정한다
   */
  drawer?: {
    /** 서랍이 될 옆 메뉴 (예: .nav) */
    panel: string;
    /** 서랍 안에서 눌러도 서랍을 닫지 않을 것 (하위 메뉴를 여는 단추 등) */
    keepOpen?: string;
  };
  /** 웹앱 버전을 붙일 자리 (첫 화면의 앱 이름 등). 서랍 띠의 이름 옆에는 늘 붙인다 */
  versionTarget?: string;
}

const TOKEN_KEY = "pi-web-token";

function readStored(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 저장할 수 없는 브라우저(사생활 보호 모드 등)면 이번만 쓴다
  }
}

/** 주소의 #token=…을 꺼내고 주소창에서 지운다 */
function takeTokenFromUrl(): string | undefined {
  const match = /(?:^#|&)token=([^&]+)/.exec(location.hash);
  if (!match) return undefined;
  history.replaceState(null, "", location.pathname + location.search);
  return decodeURIComponent(match[1]!);
}

/**
 * 화면을 읽을 때마다 새 client id. 이 화면이 살아 있는 동안 다시 붙으면 서버가 같은 세션으로 알아보고 놓친 것을 보낸다.
 * 새로 읽은 화면은 상태가 없으므로 새 세션으로 시작해야 한다 (예전 알림을 다시 받지 않게).
 */
function newClientId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function bootWebApp(options: BootOptions): void {
  const token = takeTokenFromUrl() ?? readStored(TOKEN_KEY);
  if (token) void start(options, token);
  else showTokenForm(options, "이 브라우저에 저장된 토큰이 없습니다.");
}

function showTokenForm(options: BootOptions, message: string): void {
  const root = document.getElementById("root")!;
  root.replaceChildren();
  const form = el("form", "ws-token");
  form.append(
    el("h1", undefined, options.title),
    el("p", "ws-token-message", message),
    el("p", undefined, `Termux에서 ${options.urlCommand}을 실행하면 토큰이 들어 있는 주소가 나옵니다. 그 주소를 열거나, 아래에 토큰을 붙여 넣으세요.`),
  );
  const input = el("input");
  Object.assign(input, { name: "token", autocomplete: "off", spellcheck: false, placeholder: "토큰" });
  input.setAttribute("autocapitalize", "off");
  const button = el("button", undefined, "연결");
  button.type = "submit";
  form.append(input, button);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = input.value.trim();
    if (value) void start(options, value);
  });
  root.append(form);
}

async function start(options: BootOptions, token: string): Promise<void> {
  let ok: boolean;
  let version: string | undefined;
  try {
    const response = await fetch(WebPaths.auth, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    ok = response.ok;
    version = ok ? ((await response.json().catch(() => ({}))) as { version?: string }).version : undefined;
  } catch {
    showTokenForm(options, "서버에 닿지 않습니다. Termux에서 서버가 실행 중인지 확인하세요.");
    return;
  }
  if (!ok) {
    showTokenForm(options, "토큰이 맞지 않습니다.");
    return;
  }
  store(TOKEN_KEY, token);
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const client = newClientId();
  const shell = new ShellUi();
  const transport = new ResumableTransport(
    (last) => `${scheme}//${location.host}${WebPaths.socket}?token=${encodeURIComponent(token)}&client=${client}&last=${last}`,
    {
      onStatus: (status) => {
        shell.link(status);
        // 다시 붙으면 서버가 이 탭을 새로 보므로 화면이 보이는지 다시 알린다
        if (status === "open") reportVisibility(transport);
      },
      onControl: (control) => shell.control(control),
      onReset: () => location.reload(),
    },
  );
  shell.bind(transport);
  // 다른 앱에서 공유한 이미지로 열렸으면 꺼내 둔다 (입력창이 가져간다)
  watchSharedImages();
  // 휴대폰 알림을 눌러 열렸으면 그 알림의 click 처리를 부른다 (연결되면 보낸다)
  onNotificationOpen((open) => {
    if (open.startsWith(CLICK_OPEN)) shell.clickNotification(open.slice(CLICK_OPEN.length));
  });
  transport.watchPage();
  transport.connect();
  useTransport(transport);
  document.addEventListener("visibilitychange", () => reportVisibility(transport));
  document.getElementById("root")!.replaceChildren();
  await options.loadApp();
  if (options.drawer) installDrawer(options.title, options.drawer);
  showVersion(version, [".ws-bar-title", options.versionTarget].filter(Boolean).join(", "));
  void setupNotifications(transport, options.title).catch((error: unknown) => console.warn("알림을 준비하지 못했습니다", error));
}


/** 좁은 화면의 위쪽 띠(☰ 이름)와 옆 메뉴 서랍. 서랍 안의 단추를 누르면 (그 일을 한 뒤) 닫는다 */
function installDrawer(title: string, drawer: NonNullable<BootOptions["drawer"]>): void {
  const body = document.body;
  body.classList.add("ws-has-bar");
  const bar = el("div", "ws-bar");
  const toggle = el("button", "ws-bar-toggle", "☰");
  toggle.type = "button";
  toggle.setAttribute("aria-label", "메뉴 열기");
  bar.append(toggle, el("span", "ws-bar-title", title));
  const backdrop = el("div", "ws-drawer-backdrop");
  const set = (open: boolean) => {
    body.classList.toggle("ws-drawer-open", open);
    toggle.setAttribute("aria-expanded", String(open));
  };
  toggle.addEventListener("click", () => set(!body.classList.contains("ws-drawer-open")));
  backdrop.addEventListener("click", () => set(false));
  body.append(bar, backdrop);
  document.addEventListener(
    "click",
    (event) => {
      if (!body.classList.contains("ws-drawer-open")) return;
      const target = event.target as Element | null;
      const button = target?.closest("button, a, [role=menuitem]");
      if (!button || !button.closest(drawer.panel)) return;
      if (drawer.keepOpen && button.closest(drawer.keepOpen)) return;
      // 앱이 클릭을 처리한 뒤 닫는다
      setTimeout(() => set(false), 0);
    },
    true,
  );
}

/** 서버가 시키는 일을 화면 위에 띄운다 (앱 화면과 섞이지 않게 body 끝에 둔다) */
class ShellUi {
  private transport: ResumableTransport | undefined;
  private menuButton: HTMLButtonElement | undefined;
  private menuGroups: MenuGroup[] = [];
  private readonly dialogs = new Map<number, HTMLElement>();
  private toasts: HTMLDivElement | undefined;

  bind(transport: ResumableTransport): void {
    this.transport = transport;
    this.setMenu(this.menuGroups);
  }

  link(status: LinkStatus): void {
    let bar = document.querySelector<HTMLDivElement>(".ws-link");
    if (!bar) {
      bar = el("div", "ws-link");
      bar.setAttribute("role", "status");
      document.body.append(bar);
    }
    bar.hidden = status === "open";
    bar.textContent = status === "closed" ? "서버와 연결이 끊겼습니다. 다시 붙는 중…" : "서버에 연결하는 중…";
  }

  control(control: Control): void {
    switch (control.kind) {
      case "reload":
        location.reload();
        return;
      case "open":
        window.open(control.url, "_blank", "noopener");
        return;
      case "notify":
        this.toast(control.title, control.body, control.level, control.clickId);
        return;
      case "menu":
        this.setMenu(control.groups);
        return;
      case "dialog":
        this.dialog(control.id, control.request);
        return;
      case "dialog-done":
        this.dialogs.get(control.id)?.remove();
        this.dialogs.delete(control.id);
        return;
    }
  }

  // ── 알림 ──

  /** 알림을 눌렀다고 서버에 알린다 (그 알림의 click 처리, 예: 그 대화로 가기) */
  clickNotification(id: string): void {
    this.transport?.send(ShellChannels.notificationClick, id);
  }

  private toast(title: string, body?: string, level?: "info" | "error", clickId?: string): void {
    if (!this.toasts) {
      this.toasts = el("div", "ws-toasts");
      document.body.append(this.toasts);
    }
    const item = el("div", `ws-toast${level === "error" ? " error" : ""}`);
    item.setAttribute("role", "status");
    item.append(el("strong", undefined, title));
    if (body) item.append(el("p", undefined, body));
    const close = el("button", "ws-toast-close", "닫기");
    close.type = "button";
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      item.remove();
    });
    item.append(close);
    if (clickId) {
      item.classList.add("clickable");
      item.addEventListener("click", () => {
        item.remove();
        this.clickNotification(clickId);
      });
    }
    this.toasts.append(item);
    setTimeout(() => item.remove(), level === "error" ? 15_000 : 8_000);
  }

  // ── 메뉴 ──

  private setMenu(groups: MenuGroup[]): void {
    this.menuGroups = groups;
    // 앱 메뉴가 없어도 "알림 켜기·시험"이 있어 메뉴 단추는 늘 둔다
    if (this.menuButton) return;
    const button = el("button", "ws-menu-button", "⋮");
    button.type = "button";
    button.title = "메뉴";
    button.setAttribute("aria-label", "메뉴");
    button.setAttribute("aria-haspopup", "menu");
    button.addEventListener("click", () => this.openMenu());
    document.body.append(button);
    this.menuButton = button;
  }

  private openMenu(): void {
    const backdrop = el("div", "ws-backdrop");
    const panel = el("div", "ws-menu");
    panel.setAttribute("role", "menu");
    const close = () => backdrop.remove();
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) close();
    });
    for (const group of this.menuGroups) {
      const section = el("section");
      if (group.label) section.append(el("h3", undefined, group.label));
      for (const item of group.items) {
        const button = el("button");
        button.type = "button";
        button.setAttribute("role", item.checked === undefined ? "menuitem" : "menuitemcheckbox");
        if (item.checked !== undefined) button.setAttribute("aria-checked", String(item.checked));
        button.disabled = item.enabled === false;
        button.append(el("span", undefined, item.label), el("span", "ws-menu-check", item.checked ? "✓" : ""));
        button.addEventListener("click", () => {
          close();
          void this.transport?.invoke(ShellChannels.menuClick, item.id).catch((error: Error) => this.toast("메뉴", cleanError(error), "error"));
        });
        section.append(button);
      }
      panel.append(section);
    }
    // 웹 껍데기가 직접 다는 항목: 알림 시험 (앱 메뉴와 상관없이)
    const phone = el("section");
    phone.append(el("h3", undefined, "휴대폰"));
    const test = el("button");
    test.type = "button";
    test.setAttribute("role", "menuitem");
    test.append(el("span", undefined, "알림 켜기·시험"), el("span", "ws-menu-check", ""));
    test.addEventListener("click", () => {
      close();
      if (this.transport) void checkNotifications(this.transport);
    });
    phone.append(test);
    panel.append(phone);
    const closeButton = el("button", "ws-menu-close", "닫기");
    closeButton.type = "button";
    closeButton.addEventListener("click", close);
    panel.append(closeButton);
    backdrop.append(panel);
    document.body.append(backdrop);
  }

  // ── 대화상자 ──

  private dialog(id: number, request: DialogRequest): void {
    const backdrop = el("div", "ws-backdrop");
    const box = el("div", "ws-dialog");
    box.setAttribute("role", "dialog");
    backdrop.append(box);
    this.dialogs.set(id, backdrop);
    let answered = false;
    const answer = (value: unknown) => {
      if (answered) return;
      answered = true;
      backdrop.remove();
      this.dialogs.delete(id);
      this.transport?.answer(id, value);
    };
    if (request.kind === "message") this.messageBox(box, request, answer);
    else if (request.kind === "save") this.saveBox(box, request, answer);
    else void this.openBox(box, request, answer);
    document.body.append(backdrop);
  }

  private messageBox(box: HTMLElement, request: Extract<DialogRequest, { kind: "message" }>, answer: (value: unknown) => void): void {
    if (request.title) box.append(el("h2", undefined, request.title));
    box.append(el("p", "ws-dialog-message", request.message));
    if (request.detail) box.append(el("p", "ws-dialog-detail", request.detail));
    const actions = el("div", "ws-dialog-actions");
    request.buttons.forEach((label, index) => {
      const button = el("button", index === 0 ? "primary" : undefined, label);
      button.type = "button";
      button.addEventListener("click", () => answer(index));
      actions.append(button);
    });
    box.append(actions);
  }

  private saveBox(box: HTMLElement, request: Extract<DialogRequest, { kind: "save" }>, answer: (value: unknown) => void): void {
    box.append(el("h2", undefined, request.title ?? "저장할 곳"), el("p", "ws-dialog-detail", "서버(휴대폰의 Termux) 안의 경로입니다."));
    const input = el("input", "ws-path");
    input.value = request.defaultPath ?? "";
    const actions = el("div", "ws-dialog-actions");
    const save = el("button", "primary", "저장");
    save.type = "button";
    save.addEventListener("click", () => answer(input.value.trim() || undefined));
    const cancel = el("button", undefined, "취소");
    cancel.type = "button";
    cancel.addEventListener("click", () => answer(undefined));
    actions.append(save, cancel);
    box.append(input, actions);
  }

  /** 서버의 폴더를 훑어 고른다. 파일을 고를 때는 휴대폰의 파일을 서버에 올려 고를 수도 있다 */
  private async openBox(box: HTMLElement, request: Extract<DialogRequest, { kind: "open" }>, answer: (value: unknown) => void): Promise<void> {
    box.classList.add("ws-browser");
    box.append(el("h2", undefined, request.title ?? (request.directory ? "폴더 고르기" : "파일 고르기")));
    const pathRow = el("div", "ws-path-row");
    const pathInput = el("input", "ws-path");
    const go = el("button", undefined, "이동");
    go.type = "button";
    pathRow.append(pathInput, go);
    const error = el("p", "ws-dialog-error");
    const list = el("ul", "ws-entries");
    const picked = new Set<string>();
    const actions = el("div", "ws-dialog-actions");
    const choose = el("button", "primary", request.directory ? "이 폴더 고르기" : "고르기");
    choose.type = "button";
    const cancel = el("button", undefined, "취소");
    cancel.type = "button";
    cancel.addEventListener("click", () => answer(undefined));
    box.append(pathRow, error, list);

    if (!request.directory) {
      const upload = el("label", "ws-upload");
      upload.append(el("span", undefined, "휴대폰에서 올리기…"));
      const file = el("input");
      file.type = "file";
      file.multiple = request.multiple;
      upload.append(file);
      file.addEventListener("change", () => {
        void (async () => {
          const files = [...(file.files ?? [])];
          if (files.length === 0) return;
          error.textContent = "올리는 중…";
          try {
            const paths: string[] = [];
            for (const f of files) paths.push(await this.transport!.invoke(ShellChannels.upload, f.name, await base64(f)));
            answer(paths);
          } catch (e) {
            error.textContent = cleanError(e);
          }
        })();
      });
      // 휴대폰에서는 사진·문서를 올리는 일이 많아 맨 위에 둔다
      box.insertBefore(upload, pathRow);
    }
    actions.append(choose, cancel);
    box.append(actions);

    let current = "";
    const refreshChoose = () => {
      choose.disabled = !request.directory && picked.size === 0;
      if (!request.directory) choose.textContent = picked.size > 0 ? `${picked.size}개 고르기` : "고르기";
    };
    const load = async (path?: string) => {
      error.textContent = "";
      try {
        const listing: DirListing = await this.transport!.invoke(ShellChannels.listDir, path);
        current = listing.path;
        pathInput.value = listing.path;
        list.replaceChildren();
        if (listing.parent) list.append(entry("⬆ 위 폴더", () => void load(listing.parent)));
        for (const item of listing.entries) {
          if (item.dir) list.append(entry(`📁 ${item.name}`, () => void load(item.path)));
          else if (!request.directory) {
            const li = entry(`📄 ${item.name}`, () => {
              if (!request.multiple) picked.clear();
              if (picked.has(item.path)) picked.delete(item.path);
              else picked.add(item.path);
              for (const node of list.querySelectorAll("[data-path]")) node.classList.toggle("picked", picked.has((node as HTMLElement).dataset.path!));
              refreshChoose();
            });
            li.dataset.path = item.path;
            list.append(li);
          }
        }
      } catch (e) {
        error.textContent = cleanError(e);
      }
    };
    go.addEventListener("click", () => void load(pathInput.value));
    pathInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void load(pathInput.value);
    });
    choose.addEventListener("click", () => answer(request.directory ? [current] : [...picked]));
    refreshChoose();
    await load(request.defaultPath);
  }
}

function entry(label: string, onClick: () => void): HTMLLIElement {
  const li = el("li");
  const button = el("button", undefined, label);
  button.type = "button";
  button.addEventListener("click", onClick);
  li.append(button);
  return li;
}

function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

function base64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("파일을 읽지 못했습니다"));
    reader.readAsDataURL(file);
  });
}
