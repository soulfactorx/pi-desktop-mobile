/**
 * 서비스 워커 (설계 DESIGN.md §5.11 "알림"). 서버가 SERVICE_WORKER_PATH로 내준다.
 * 안드로이드 크롬은 페이지에서 바로 알림을 띄울 수 없고, 닫힌 화면에는 웹 푸시로만 닿는다. 그래서 둘 다 서비스 워커가 맡는다.
 * - push: 서버가 보낸 { title, body, url, tag }로 알림을 띄운다
 * - notificationclick: 열려 있는 이 앱 탭을 앞으로 가져오고(알림의 open 값을 그 탭에 보낸다), 없으면 새로 연다 (?ws-open=)
 * 화면 파일을 미리 받아 두지는 않는다 (서버가 같은 휴대폰에 있어 오프라인일 일이 없다).
 */
export const SERVICE_WORKER_SOURCE = `
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: event.data ? event.data.text() : "" }; }
  const title = data.title || "알림";
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || "",
    icon: "./icon.png",
    badge: "./icon.png",
    tag: data.tag || undefined,
    data: { url: data.url || "./", open: data.open || "" },
  }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = new URL(data.url || "./", self.registration.scope);
  if (data.open) target.searchParams.set("ws-open", data.open);
  event.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const tab of tabs) {
      if (!tab.url.startsWith(self.registration.scope)) continue;
      await tab.focus();
      if (data.open) tab.postMessage({ type: "ws-open", open: data.open });
      return;
    }
    await self.clients.openWindow(target.href);
  })());
});
`;
