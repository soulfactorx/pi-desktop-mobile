import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

/**
 * 휴대폰에 설치한 웹앱으로 "공유"한 이미지 받기 (Web Share Target, manifest의 share_target → POST /ws-share).
 * 서비스 워커가 공유 요청을 읽으면 갤럭시 스크린샷처럼 다른 앱의 파일은 "Failed to fetch"로 읽지 못해서,
 * 서비스 워커는 건드리지 않고 브라우저가 서버로 바로 올리게 한다. 서버는 이미지를 잠깐(2분, 한 번) 맡아 두고
 * 화면을 /?ws-share-id=<id> 로 연다. 화면이 GET /ws-share/<id> 로 가져가 입력창에 붙인다 (client/share.ts).
 * 공유 요청에는 토큰이 없어(다른 앱이 보낸다) 꺼낼 때 맞혀야 하는 긴 무작위 id로 지킨다.
 */

export const SHARE_PATH = "/ws-share";
const MAX_BYTES = 30 * 1024 * 1024;
const MAX_FILES = 10;
const KEEP_MS = 2 * 60_000;
const IMAGE_EXT: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic" };

interface SharedFile {
  name: string;
  type: string;
  data: string;
}

interface Inbox {
  files: SharedFile[];
  fields: string[];
  error?: string;
  expires: number;
}

const inbox = new Map<string, Inbox>();

/** 공유 받기 요청이면 처리하고 true. allowHost: 이 서버의 주소로 온 요청인지 (Origin은 보지 않는다) */
export function handleShareRequest(req: IncomingMessage, res: ServerResponse, allowHost: boolean): boolean {
  const path = (req.url ?? "/").split("?")[0]!;
  if (req.method === "POST" && path === SHARE_PATH) {
    if (!allowHost) {
      res.writeHead(403).end();
      return true;
    }
    void receive(req).then((entry) => {
      const id = randomBytes(18).toString("base64url");
      for (const [key, value] of inbox) if (value.expires < Date.now()) inbox.delete(key);
      inbox.set(id, entry);
      res.writeHead(303, { Location: `/?ws-share-id=${id}`, "Cache-Control": "no-store" }).end();
    });
    return true;
  }
  if (req.method === "GET" && path.startsWith(`${SHARE_PATH}/`)) {
    const id = path.slice(SHARE_PATH.length + 1);
    const entry = inbox.get(id);
    inbox.delete(id);
    if (!entry || entry.expires < Date.now()) {
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(JSON.stringify({ files: [], fields: [], error: "지난 공유입니다" }));
      return true;
    }
    const { expires: _expires, ...body } = entry;
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(JSON.stringify(body));
    return true;
  }
  return false;
}

async function receive(req: IncomingMessage): Promise<Inbox> {
  const entry: Inbox = { files: [], fields: [], expires: Date.now() + KEEP_MS };
  try {
    const length = Number(req.headers["content-length"] ?? 0);
    if (length > MAX_BYTES) throw new Error(`${(length / 1024 / 1024).toFixed(1)}MB라 너무 큽니다 (30MB까지)`);
    const request = new Request("http://localhost/ws-share", {
      method: "POST",
      headers: { "content-type": String(req.headers["content-type"] ?? "") },
      body: Readable.toWeb(req) as ReadableStream,
      duplex: "half",
    } as RequestInit);
    const form = await request.formData();
    for (const [field, value] of form.entries()) {
      if (typeof value === "string") {
        entry.fields.push(`${field}:text`);
        continue;
      }
      entry.fields.push(`${field}:${value.type || "?"}:${value.size}`);
      const ext = /\.([a-z0-9]+)$/i.exec(value.name || "")?.[1]?.toLowerCase() ?? "";
      const type = value.type.startsWith("image/") ? value.type : IMAGE_EXT[ext];
      if (!type || entry.files.length >= MAX_FILES) continue;
      entry.files.push({ name: value.name || "", type, data: Buffer.from(await value.arrayBuffer()).toString("base64") });
    }
  } catch (error) {
    entry.error = (error as Error).message;
    req.resume();
  }
  return entry;
}
