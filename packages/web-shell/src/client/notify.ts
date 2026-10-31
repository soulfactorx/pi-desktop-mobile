import { SERVICE_WORKER_PATH, ShellChannels } from "../protocol";

/**
 * 휴대폰 알림의 화면 쪽 (설계 DESIGN.md §5.11 "알림"). web-shell 앱(Agent·Mate)과 Pi Web(apps/desktop/src/web)이 함께 쓴다.
 * 서버 연결은 invoke·send만 있으면 된다.
 */
export interface NotifyTransport {
  invoke(channel: string, ...args: unknown[]): Promise<any>;
  send(channel: string, ...args: unknown[]): void;
}

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
    // 저장할 수 없는 브라우저면 이번만
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 이 탭의 화면이 보이는지 서버에 알린다. 보는 탭이 없으면 서버는 알림을 웹 푸시로 보낸다 */
export function reportVisibility(transport: NotifyTransport): void {
  transport.send(ShellChannels.visibility, document.visibilityState === "visible");
}

const NOTIFY_ASKED_KEY = "pi-web-notify-asked";
const ASK_AGAIN_MS = 24 * 60 * 60_000;

/**
 * 휴대폰 알림 (웹 푸시). 서비스 워커를 올리고, 알림이 허용되어 있으면 구독을 서버에 보낸다.
 * 처음에는 화면 아래에 "알림 켜기"를 한 번 묻는다 (브라우저는 사용자가 누를 때만 허락 창을 띄운다).
 */
export async function setupNotifications(transport: NotifyTransport, title: string): Promise<void> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return;
  await navigator.serviceWorker.register(SERVICE_WORKER_PATH, { scope: "/" });
  if (Notification.permission === "granted") return subscribePush(transport);
  // "나중에"를 누른 지 하루가 지나면 다시 묻는다 (앱을 다시 설치하면 허용이 풀리므로 한 번만 묻고 끝내지 않는다)
  const asked = Number(readStored(NOTIFY_ASKED_KEY));
  if (Notification.permission === "denied" || (Number.isFinite(asked) && Date.now() - asked < ASK_AGAIN_MS)) return;
  const card = el("div", "ws-notify-ask");
  card.setAttribute("role", "dialog");
  card.append(
    el("strong", undefined, "휴대폰 알림을 켤까요?"),
    el("p", undefined, `${title} 화면을 보고 있지 않을 때도 답·질문(승인 요청)·작업 결과를 휴대폰 알림으로 알려 드려요.`),
  );
  const actions = el("div", "ws-dialog-actions");
  const later = el("button", undefined, "나중에");
  later.type = "button";
  const enable = el("button", "primary", "알림 켜기");
  enable.type = "button";
  actions.append(later, enable);
  card.append(actions);
  const close = () => {
    store(NOTIFY_ASKED_KEY, String(Date.now()));
    card.remove();
  };
  later.addEventListener("click", close);
  enable.addEventListener("click", () => {
    close();
    void Notification.requestPermission().then((permission) => (permission === "granted" ? subscribePush(transport) : undefined));
  });
  document.body.append(card);
}

/**
 * 메뉴의 "알림 시험": 알림이 오는지 바로 확인한다. 허용을 아직 안 했으면 묻고, 막혀 있으면 켜는 곳을 알려 주고,
 * 허용되어 있으면 구독을 다시 서버에 맡긴 뒤 시험 알림을 보낸다. 결과는 화면 위 안내로 보인다.
 */
export async function checkNotifications(transport: NotifyTransport): Promise<void> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return showPageNote("이 브라우저는 휴대폰 알림(웹 푸시)을 지원하지 않습니다", 8000);
  }
  let permission = Notification.permission;
  if (permission === "default") permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return showPageNote("알림이 꺼져 있습니다. 휴대폰 설정 → 애플리케이션 → 이 앱(또는 Chrome) → 알림에서 켠 뒤 다시 눌러 주세요", 12_000);
  }
  try {
    await subscribePush(transport);
    const result: { sent: number; total: number } = await transport.invoke(ShellChannels.pushTest);
    showPageNote(
      result.sent > 0 ? `시험 알림을 보냈습니다 (기기 ${result.sent}개). 곧 휴대폰 알림이 와야 합니다` : `시험 알림을 보내지 못했습니다 (등록된 기기 ${result.total}개)`,
      8000,
    );
  } catch (error) {
    showPageNote(`알림을 준비하지 못했습니다: ${(error as Error).message}`, 12_000);
  }
}

async function subscribePush(transport: NotifyTransport): Promise<void> {
  const registration = await navigator.serviceWorker.ready;
  const key: string = await transport.invoke(ShellChannels.pushKey);
  const serverKey = base64UrlBytes(key);
  let subscription = await registration.pushManager.getSubscription();
  // 서버가 키를 새로 만들었으면(데이터를 지웠으면) 예전 구독으로는 보낼 수 없다
  const current = subscription?.options.applicationServerKey;
  if (subscription && current && !sameBytes(new Uint8Array(current), serverKey)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverKey });
  await transport.invoke(ShellChannels.pushSubscribe, subscription.toJSON());
}

function base64UrlBytes(text: string): Uint8Array<ArrayBuffer> {
  const base64 = (text + "=".repeat((4 - (text.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

const OPEN_PARAM = "ws-open";

const PENDING_CACHE = "ws-pending";
const PENDING_OPEN = "/ws-pending/open";
/** 알림을 누른 지 이만큼 지난 맡김은 버린다 */
const PENDING_MAX_MS = 3 * 60_000;

/**
 * 휴대폰 알림을 눌러 이 화면이 열리거나 앞으로 왔을 때, 알림의 open 값(서버가 정한다)을 handler에 넘긴다.
 * 세 길로 오고, 같은 값은 한 번만 넘긴다.
 * - 열려 있던 탭: 서비스 워커가 보낸 메시지로
 * - 새로 연 탭: 주소의 ?ws-open= 으로 (읽은 뒤 주소에서 지운다)
 * - 휴대폰이 뒤에 둔 탭을 버렸다가 새로 읽은 경우(메시지를 잃는다): 서비스 워커가 캐시에 맡겨 둔 것을 뜰 때·보일 때 꺼낸다
 */
export function onNotificationOpen(handler: (open: string) => void): void {
  let last = { open: "", at: 0 };
  const deliver = (open: string) => {
    const now = Date.now();
    if (open === last.open && now - last.at < 10_000) return;
    last = { open, at: now };
    handler(open);
  };
  const takePending = async (): Promise<string | undefined> => {
    if (!("caches" in window)) return undefined;
    const cache = await caches.open(PENDING_CACHE);
    const response = await cache.match(PENDING_OPEN);
    if (!response) return undefined;
    await cache.delete(PENDING_OPEN);
    const at = Number(response.headers.get("X-At") ?? 0);
    return Date.now() - at < PENDING_MAX_MS ? response.text() : undefined;
  };
  const checkPending = () =>
    void takePending()
      .then((open) => open && deliver(open))
      .catch(() => undefined);
  try {
    const url = new URL(location.href);
    const open = url.searchParams.get(OPEN_PARAM);
    if (open) {
      url.searchParams.delete(OPEN_PARAM);
      history.replaceState(history.state, "", url.pathname + url.search + url.hash);
      queueMicrotask(() => deliver(open));
    }
  } catch {
    // 주소를 읽을 수 없으면 넘긴다
  }
  checkPending();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkPending();
  });
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { type?: unknown; open?: unknown } | undefined;
    if (data?.type !== "ws-open" || typeof data.open !== "string" || !data.open) return;
    // 메시지로 받았으면 맡겨 둔 것은 지운다 (보일 때 다시 넘기지 않게)
    void takePending().catch(() => undefined);
    deliver(data.open);
  });
  navigator.serviceWorker.startMessages();
}

/** 화면 아래에 잠깐 띄우는 안내 (알림·공유를 받았는지 알려 준다) */
export function showPageNote(text: string, ms = 5000): void {
  const note = el("div", "ws-page-note", text);
  note.setAttribute("role", "status");
  document.body.append(note);
  setTimeout(() => note.remove(), ms);
}
