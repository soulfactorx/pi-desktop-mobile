/**
 * 서비스 워커 (설계 DESIGN.md §5.11 "알림"). 서버가 SERVICE_WORKER_PATH로 내준다.
 * 안드로이드 크롬은 페이지에서 바로 알림을 띄울 수 없고, 닫힌 화면에는 웹 푸시로만 닿는다. 그래서 둘 다 서비스 워커가 맡는다.
 * - push: 서버가 보낸 { title, body, url, tag }로 알림을 띄운다
 * - fetch POST /ws-share: 설치한 앱으로 "공유"한 이미지(Web Share Target, manifest의 share_target)를 캐시(ws-share)에 두고
 *   화면(/?ws-share=)으로 보낸다. 화면이 꺼내 입력창에 붙인다 (client/share.ts). 그 밖의 요청은 건드리지 않는다
 * - notificationclick: 알림의 open 값을 캐시(ws-pending)에 맡겨 두고, 열려 있는 이 앱 탭에 보내며 앞으로 가져온다. 없으면 새로 연다 (?ws-open=).
 *   휴대폰은 뒤에 둔 탭을 버렸다가 앞으로 올 때 새로 읽어 메시지를 잃으므로, 화면은 뜰 때·보일 때 캐시도 확인한다 (client/notify.ts)
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
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "POST" || url.pathname !== "/ws-share") return;
  event.respondWith((async () => {
    // 무엇을 받았는지 화면이 보여 줄 수 있게 남긴다 (못 받았을 때 원인을 찾게)
    const info = { at: Date.now(), fields: [], error: "" };
    try {
      const cache = await caches.open("ws-share");
      for (const key of await cache.keys()) await cache.delete(key);
      const form = await event.request.formData();
      let i = 0;
      // 항목 이름(images)에 기대지 않고 모든 파일을 본다. 형식이 비었으면 파일 이름의 확장자로 본다
      for (const [field, value] of form.entries()) {
        if (typeof value === "string") {
          info.fields.push(field + ":text");
          continue;
        }
        const ext = (/\.([a-z0-9]+)$/i.exec(value.name || "") || [])[1] || "";
        const byExt = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic" }[ext.toLowerCase()];
        const type = String(value.type || "").startsWith("image/") ? value.type : byExt || "";
        info.fields.push(field + ":" + (value.type || "?") + ":" + value.size);
        if (!type || i >= 10) continue;
        await cache.put(new Request("/ws-share/" + i++), new Response(value, { headers: { "Content-Type": type, "X-File-Name": encodeURIComponent(value.name || "") } }));
      }
      await cache.put(new Request("/ws-share-info"), new Response(JSON.stringify(info), { headers: { "Content-Type": "application/json" } }));
    } catch (error) {
      info.error = String(error && error.message || error);
      try {
        const cache = await caches.open("ws-share");
        await cache.put(new Request("/ws-share-info"), new Response(JSON.stringify(info), { headers: { "Content-Type": "application/json" } }));
      } catch (e) {
        // 남기지 못하면 넘긴다
      }
    }
    return Response.redirect("/?ws-share=" + Date.now(), 303);
  })());
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = new URL(data.url || "./", self.registration.scope);
  if (data.open) target.searchParams.set("ws-open", data.open);
  event.waitUntil((async () => {
    if (data.open) {
      try {
        const cache = await caches.open("ws-pending");
        await cache.put(new Request("/ws-pending/open"), new Response(data.open, { headers: { "X-At": String(Date.now()) } }));
      } catch (error) {
        // 맡기지 못하면 메시지·주소로만 넘긴다
      }
    }
    const tabs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const tab of tabs) {
      if (!tab.url.startsWith(self.registration.scope)) continue;
      if (data.open) tab.postMessage({ type: "ws-open", open: data.open });
      try {
        await tab.focus();
        return;
      } catch (error) {
        // 앞으로 가져오지 못하면 새로 연다
      }
    }
    await self.clients.openWindow(target.href);
  })());
});
`;
