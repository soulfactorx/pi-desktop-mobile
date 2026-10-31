import { createPiDesktopApi } from "../shared/api-client";
import { WebPaths } from "../shared/web-protocol";
import { WsTransport, type LinkStatus } from "./ws-transport";
import { onNotificationOpen, reportVisibility, setupNotifications } from "@pi-desktop/web-shell/notify";
import { OPEN_SESSION_EVENT, parseSessionOpen, type SessionTarget } from "../shared/web-files";
import { createWebFiles } from "./web-files";
import "@pi-desktop/web-shell/client.css";
import "../renderer/styles.css";
import "./web.css";

/**
 * 웹(pi-web) 화면의 시작점 (설계 §5.10). 데스크톱 앱의 preload 자리를 맡는다.
 *
 * 1. 토큰: 서버가 알려 준 주소(http://127.0.0.1:8787/#token=…)의 # 뒤에서 읽어 이 브라우저에 기억하고 주소창에서 지운다.
 *    # 뒤는 서버로 가지 않으므로 서버 기록·브라우저 방문 기록에 남지 않는다.
 * 2. 서버에 토큰이 맞는지 묻는다. 없거나 틀리면 토큰을 넣는 화면을 보여 준다.
 * 3. WebSocket API를 window.piDesktop으로 두고 데스크톱과 같은 화면(renderer)을 불러온다.
 */

const TOKEN_KEY = "pi-web-token";

function readStoredToken(): string | undefined {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function storeToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
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

async function tokenWorks(token: string): Promise<boolean> {
  const response = await fetch(WebPaths.auth, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  return response.ok;
}

function showTokenForm(message: string): void {
  const root = document.getElementById("root")!;
  root.innerHTML = `
    <form class="web-token">
      <h1>Pi Web</h1>
      <p class="web-token-message"></p>
      <p>Termux에서 <code>pi-web url</code>을 실행하면 토큰이 들어 있는 주소가 나옵니다. 그 주소를 열거나, 아래에 토큰을 붙여 넣으세요.</p>
      <input name="token" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="토큰" />
      <button type="submit">연결</button>
    </form>`;
  root.querySelector(".web-token-message")!.textContent = message;
  const form = root.querySelector("form")!;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = (new FormData(form).get("token") ?? "").toString().trim();
    if (value) void start(value);
  });
}

/** 서버와의 연결 상태를 화면 위쪽 띠로 보여 준다 (끊겼을 때만) */
function showLink(status: LinkStatus): void {
  let bar = document.querySelector<HTMLDivElement>(".web-link");
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "web-link";
    bar.setAttribute("role", "status");
    document.body.appendChild(bar);
  }
  bar.hidden = status === "open";
  bar.textContent = status === "closed" ? "서버와 연결이 끊겼습니다. 다시 붙는 중…" : "서버에 연결하는 중…";
}

async function start(token: string): Promise<void> {
  let ok: boolean;
  try {
    ok = await tokenWorks(token);
  } catch {
    showTokenForm("서버에 닿지 않습니다. Termux에서 pi-web이 실행 중인지 확인하세요.");
    return;
  }
  if (!ok) {
    showTokenForm("토큰이 맞지 않습니다.");
    return;
  }
  storeToken(token);
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const transport: WsTransport = new WsTransport(`${scheme}//${location.host}${WebPaths.socket}?token=${encodeURIComponent(token)}`, (status) => {
    showLink(status);
    // 다시 붙으면 서버가 이 탭을 새로 보므로 화면이 보이는지 다시 알린다 (보는 탭이 없으면 알림을 웹 푸시로)
    if (status === "open") reportVisibility(transport);
  });
  document.addEventListener("visibilitychange", () => reportVisibility(transport));
  transport.connect();
  window.piDesktop = createPiDesktopApi(transport, "web");
  // 휴대폰 알림을 누르면 그 세션으로 간다. 화면(App)이 뜨기 전이면 맡아 두었다가 App이 읽는다
  let pendingOpen: SessionTarget | undefined;
  let appReady = false;
  window.piWeb = {
    files: createWebFiles((channel, ...args) => transport.invoke(channel, ...args)),
    takeOpenSession: () => {
      appReady = true;
      const target = pendingOpen;
      pendingOpen = undefined;
      return target;
    },
  };
  onNotificationOpen((open) => {
    const target = parseSessionOpen(open);
    if (!target) return;
    if (appReady) window.dispatchEvent(new CustomEvent<SessionTarget>(OPEN_SESSION_EVENT, { detail: target }));
    else pendingOpen = target;
  });
  document.getElementById("root")!.innerHTML = "";
  await import("../renderer/main");
  void setupNotifications(transport, "Pi Web").catch((error: unknown) => console.warn("알림을 준비하지 못했습니다", error));
}

const token = takeTokenFromUrl() ?? readStoredToken();
if (token) void start(token);
else showTokenForm("이 브라우저에 저장된 토큰이 없습니다.");
