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

/**
 * 휴대폰 알림 (웹 푸시). 서비스 워커를 올리고, 알림이 허용되어 있으면 구독을 서버에 보낸다.
 * 처음에는 화면 아래에 "알림 켜기"를 한 번 묻는다 (브라우저는 사용자가 누를 때만 허락 창을 띄운다).
 */
export async function setupNotifications(transport: NotifyTransport, title: string): Promise<void> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return;
  await navigator.serviceWorker.register(SERVICE_WORKER_PATH, { scope: "/" });
  if (Notification.permission === "granted") return subscribePush(transport);
  if (Notification.permission === "denied" || readStored(NOTIFY_ASKED_KEY)) return;
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
    store(NOTIFY_ASKED_KEY, "1");
    card.remove();
  };
  later.addEventListener("click", close);
  enable.addEventListener("click", () => {
    close();
    void Notification.requestPermission().then((permission) => (permission === "granted" ? subscribePush(transport) : undefined));
  });
  document.body.append(card);
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
