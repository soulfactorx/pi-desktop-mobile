import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleShareRequest, parseMultipart } from "../src/server/share-inbox";

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

  it("multipart를 너그럽게 읽는다: UTF-8 파일 이름, LF 줄바꿈, 끝 경계 없음", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
    const body = Buffer.concat([
      Buffer.from('--b\nContent-Disposition: form-data; name="title"\n\n제목\n--b\nContent-Disposition: form-data; name="images"; filename="스크린샷.png"\nContent-Type: image/png\n\n'),
      png,
      Buffer.from("\n--b\r\nContent-Disposition: form-data; name=\"f\"; filename*=UTF-8''%EC%82%AC%EC%A7%84\r\n\r\n"),
      png,
    ]);
    const parts = parseMultipart(body, "b");
    expect(parts.map((p) => [p.name, p.filename, p.type, p.data.length])).toEqual([
      ["title", undefined, "", 6],
      ["images", "스크린샷.png", "image/png", 10],
      ["f", "사진", "", 10],
    ]);
  });

  it("형식·확장자가 없는 파일도 내용으로 이미지인지 본다", async () => {
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
    const body = Buffer.concat([Buffer.from('--x\r\nContent-Disposition: form-data; name="images"; filename="blob"\r\nContent-Type: application/octet-stream\r\n\r\n'), jpg, Buffer.from("\r\n--x--\r\n")]);
    const posted = await fetch(`${base}/ws-share`, { method: "POST", body, headers: { "content-type": "multipart/form-data; boundary=x" }, redirect: "manual" });
    const id = new URL(posted.headers.get("location")!, base).searchParams.get("ws-share-id")!;
    const got = (await (await fetch(`${base}/ws-share/${id}`)).json()) as { files: Array<{ type: string; data: string }> };
    expect(got.files.map((f) => [f.type, Buffer.from(f.data, "base64").length])).toEqual([["image/jpeg", 6]]);
  });
});
