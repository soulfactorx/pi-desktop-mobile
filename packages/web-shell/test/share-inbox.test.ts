import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleShareRequest } from "../src/server/share-inbox";

describe("공유 받기 (server/share-inbox)", () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (!handleShareRequest(req, res, true)) res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it("공유한 이미지를 맡아 두고 화면으로 보내며, 한 번만 꺼내 준다 (항목 이름·형식이 달라도 확장자로 본다)", async () => {
    const form = new FormData();
    form.append("title", "스크린샷");
    form.append("images", new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" }));
    form.append("file", new File([new Uint8Array([4, 5])], "Screenshot_1.jpg", { type: "application/octet-stream" }));
    form.append("other", new File([new Uint8Array([6])], "note.txt", { type: "text/plain" }));
    const posted = await fetch(`${base}/ws-share`, { method: "POST", body: form, redirect: "manual" });
    expect(posted.status).toBe(303);
    const location = posted.headers.get("location")!;
    expect(location).toMatch(/^\/\?ws-share-id=[\w-]{20,}$/);
    const id = new URL(location, base).searchParams.get("ws-share-id")!;
    const body = (await (await fetch(`${base}/ws-share/${id}`)).json()) as { files: Array<{ name: string; type: string; data: string }>; fields: string[] };
    expect(body.files.map((f) => [f.name, f.type, Buffer.from(f.data, "base64").length])).toEqual([
      ["a.png", "image/png", 3],
      ["Screenshot_1.jpg", "image/jpeg", 2],
    ]);
    expect(body.fields).toEqual(["title:text", "images:image/png:3", "file:application/octet-stream:2", "other:text/plain:1"]);
    expect((await fetch(`${base}/ws-share/${id}`)).status).toBe(404);
  });
});
