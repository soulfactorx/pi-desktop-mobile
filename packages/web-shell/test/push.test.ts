import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PushCenter } from "../src/server/push";
import { hub, notify, onBackgroundNotify, configureShell } from "../src/electron/main";

const sub = (n: number) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, keys: { p256dh: `p${n}`, auth: `a${n}` } });

describe("웹 푸시 (web-shell)", () => {
  it("VAPID 키를 한 번 만들어 0600으로 두고, 구독을 저장해 모두에게 보낸다. 없어진 구독은 지운다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ws-push-"));
    const sent: Array<{ endpoint: string; payload: string; subject?: string }> = [];
    const center = new PushCenter(dir, "https://example.com", async (s, payload, options) => {
      if (s.endpoint.endsWith("/2")) throw Object.assign(new Error("gone"), { statusCode: 410 });
      if (s.endpoint.endsWith("/3")) throw Object.assign(new Error("busy"), { statusCode: 500 });
      sent.push({ endpoint: s.endpoint, payload, ...(options.vapidDetails ? { subject: options.vapidDetails.subject } : {}) });
    });
    const key = center.publicKey();
    expect(key).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    if (process.platform !== "win32") expect(statSync(join(dir, "vapid.json")).mode & 0o777).toBe(0o600);
    expect(new PushCenter(dir).publicKey()).toBe(key);

    center.subscribe(sub(1));
    center.subscribe(sub(1));
    center.subscribe(sub(2));
    center.subscribe(sub(3));
    expect(center.count).toBe(3);
    expect(() => center.subscribe({ endpoint: "http://x", keys: { p256dh: "", auth: "" } } as never)).toThrow();

    expect(await center.send({ title: "임무 완료", body: "서울 맑음" })).toBe(1);
    expect(sent).toEqual([{ endpoint: sub(1).endpoint, payload: JSON.stringify({ title: "임무 완료", body: "서울 맑음" }), subject: "https://example.com" }]);
    // 410은 지우고, 잠깐 실패(500)는 남긴다
    expect(JSON.parse(readFileSync(join(dir, "push-subscriptions.json"), "utf8")).map((s: { endpoint: string }) => s.endpoint)).toEqual([
      sub(1).endpoint,
      sub(3).endpoint,
    ]);
    center.unsubscribe(sub(3).endpoint);
    expect(center.count).toBe(1);
  });

  it("알림: 보는 탭이 없을 때만 웹 푸시로 보낸다", () => {
    configureShell({ name: "t", version: "1", dataDir: mkdtempSync(join(tmpdir(), "ws-n-")), appPath: ".", packaged: true });
    const pushed: unknown[] = [];
    onBackgroundNotify((note) => pushed.push(note));
    expect(hub.anyVisible()).toBe(false);
    notify("Mate의 질문", "웹 검색을 켤까요?");
    expect(pushed).toEqual([{ title: "Mate의 질문", body: "웹 검색을 켤까요?" }]);
  });
});
