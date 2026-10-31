import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import webpush, { type PushSubscription } from "web-push";

/**
 * 웹 푸시 (설계 DESIGN.md §5.11 "알림"). 브라우저를 닫았거나 백그라운드에 있어도 휴대폰 알림으로 보낸다.
 *
 * - VAPID 키: 처음 쓸 때 만들어 데이터 폴더에 둔다(0600). 브라우저는 공개 키로 구독한다
 * - 구독: 브라우저가 알림을 허용하면 보내 온 구독(브라우저 회사의 푸시 서버 주소와 암호화 키)을 저장한다
 * - 보내기: 알림 내용은 구독 키로 암호화해 푸시 서버(크롬은 구글 FCM)를 거쳐 휴대폰에 닿는다.
 *   그래서 휴대폰이 인터넷에 붙어 있어야 한다. 없어진 구독(404·410)은 지운다
 */

export interface PushPayload {
  title: string;
  body?: string;
  /** 누르면 열 주소 (기본: 앱 첫 화면) */
  url?: string;
  /** 같은 tag의 알림은 바뀌어 하나로 보인다 */
  tag?: string;
}

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export class PushCenter {
  private keys: VapidKeys | undefined;
  private subscriptions: PushSubscription[] | undefined;

  constructor(
    private readonly dataDir: string,
    /** VAPID subject (푸시 서버가 문제가 있을 때 연락할 곳) */
    private readonly subject = "https://github.com/soulfactorx/pi-desktop-mobile",
    private readonly sender: (subscription: PushSubscription, payload: string, options: webpush.RequestOptions) => Promise<unknown> = (s, p, o) =>
      webpush.sendNotification(s, p, o),
  ) {}

  publicKey(): string {
    return this.vapid().publicKey;
  }

  subscribe(subscription: PushSubscription): void {
    if (!isSubscription(subscription)) throw new Error("구독 형식이 아닙니다");
    const list = this.list().filter((s) => s.endpoint !== subscription.endpoint);
    list.push({ endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth } });
    this.save(list);
  }

  unsubscribe(endpoint: string): void {
    this.save(this.list().filter((s) => s.endpoint !== endpoint));
  }

  get count(): number {
    return this.list().length;
  }

  /** 모든 구독에 보낸다. 실패한 것은 넘기고, 없어진 구독은 지운다. 보낸 수를 돌려준다 */
  async send(payload: PushPayload): Promise<number> {
    const list = this.list();
    if (list.length === 0) return 0;
    const keys = this.vapid();
    const options: webpush.RequestOptions = { vapidDetails: { subject: this.subject, ...keys }, TTL: 60 * 60, urgency: "high" };
    const body = JSON.stringify(payload);
    const gone = new Set<string>();
    let sent = 0;
    await Promise.all(
      list.map(async (subscription) => {
        try {
          await this.sender(subscription, body, options);
          sent++;
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) gone.add(subscription.endpoint);
        }
      }),
    );
    if (gone.size > 0) this.save(this.list().filter((s) => !gone.has(s.endpoint)));
    return sent;
  }

  private vapid(): VapidKeys {
    if (this.keys) return this.keys;
    const path = join(this.dataDir, "vapid.json");
    if (existsSync(path)) {
      try {
        const keys = JSON.parse(readFileSync(path, "utf8")) as Partial<VapidKeys>;
        if (typeof keys.publicKey === "string" && typeof keys.privateKey === "string") return (this.keys = { publicKey: keys.publicKey, privateKey: keys.privateKey });
      } catch {
        // 깨졌으면 새로 만든다 (예전 구독은 맞지 않으니 지운다)
      }
    }
    const keys = webpush.generateVAPIDKeys();
    writeSecret(path, `${JSON.stringify(keys, null, 2)}\n`);
    this.save([]);
    return (this.keys = keys);
  }

  private list(): PushSubscription[] {
    if (this.subscriptions) return this.subscriptions;
    try {
      const raw = JSON.parse(readFileSync(join(this.dataDir, "push-subscriptions.json"), "utf8")) as unknown;
      this.subscriptions = Array.isArray(raw) ? raw.filter(isSubscription) : [];
    } catch {
      this.subscriptions = [];
    }
    return this.subscriptions;
  }

  private save(list: PushSubscription[]): void {
    this.subscriptions = list;
    writeSecret(join(this.dataDir, "push-subscriptions.json"), `${JSON.stringify(list, null, 2)}\n`);
  }
}

function writeSecret(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function isSubscription(value: unknown): value is PushSubscription {
  const s = value as Partial<PushSubscription> | undefined;
  return (
    !!s &&
    typeof s.endpoint === "string" &&
    /^https:\/\//.test(s.endpoint) &&
    typeof s.keys?.p256dh === "string" &&
    typeof s.keys?.auth === "string"
  );
}
