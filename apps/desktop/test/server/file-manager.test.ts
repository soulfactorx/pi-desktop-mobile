import { mkdtempSync, readFileSync, symlinkSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { FileManager } from "../../src/server/file-manager";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "pw-files-"));
  return { root, files: new FileManager(root) };
}

describe("Pi Web 파일 관리자", () => {
  it("홈 아래만 다루고, 폴더를 먼저 보이며, 위 폴더는 홈에서 멈춘다", async () => {
    const { root, files } = setup();
    writeFileSync(join(root, "b.txt"), "b");
    mkdirSync(join(root, "a-dir"));
    const listing = await files.list();
    expect(listing.path).toBe(root);
    expect(listing.parent).toBeUndefined();
    expect(listing.entries.map((e) => [e.name, e.dir])).toEqual([["a-dir", true], ["b.txt", false]]);
    expect((await files.list("~/a-dir")).parent).toBe(root);
    await expect(files.list(join(root, ".."))).rejects.toThrow("홈 폴더");
    await expect(files.list("../../etc")).rejects.toThrow("홈 폴더");
  });

  it("만들기·이름 바꾸기·복사·이동·지우기. 같은 이름은 덮어쓰지 않는다", async () => {
    const { root, files } = setup();
    const dir = await files.makeDir(root, "proj");
    const file = await files.makeFile(dir, "note.md");
    await expect(files.makeFile(dir, "note.md")).rejects.toThrow();
    await expect(files.makeDir(root, "a/b")).rejects.toThrow("/");
    const renamed = await files.rename(file, "readme.md");
    expect(renamed).toBe(join(dir, "readme.md"));
    const other = await files.makeDir(root, "other");
    const [copied] = await files.transfer([renamed], other, "copy");
    expect(existsSync(renamed) && existsSync(copied!)).toBe(true);
    await expect(files.transfer([renamed], other, "copy")).rejects.toThrow("같은 이름");
    await expect(files.transfer([dir], join(dir), "move")).rejects.toThrow("자기 안");
    const [moved] = await files.transfer([dir], other, "move");
    expect(moved).toBe(join(other, "proj"));
    expect(existsSync(dir)).toBe(false);
    expect(await files.remove([moved!])).toBe(1);
    expect(existsSync(moved!)).toBe(false);
    await expect(files.remove([root])).rejects.toThrow("홈 폴더");
  });

  it("링크를 지우면 링크만 지운다", async () => {
    const { root, files } = setup();
    const target = await files.makeDir(root, "real");
    writeFileSync(join(target, "keep.txt"), "x");
    symlinkSync(target, join(root, "link"));
    const link = (await files.list()).entries.find((e) => e.name === "link")!;
    expect(link).toMatchObject({ dir: true, link: true });
    await files.remove([link.path]);
    expect(existsSync(join(target, "keep.txt"))).toBe(true);
  });

  it("글 읽기·쓰기: 다른 곳에서 바뀌었으면 덮어쓰지 않고, 이진 파일은 열지 않는다", async () => {
    const { root, files } = setup();
    const path = join(root, "a.txt");
    writeFileSync(path, "안녕");
    const { text, mtime } = await files.readText(path);
    expect(text).toBe("안녕");
    const next = await files.writeText(path, "고침", mtime);
    expect(readFileSync(path, "utf8")).toBe("고침");
    await expect(files.writeText(path, "늦은 저장", mtime - 10_000)).rejects.toThrow("바뀌었습니다");
    expect(await files.writeText(path, "다시", next)).toBeGreaterThan(0);
    writeFileSync(join(root, "bin"), Buffer.from([0, 1, 2]));
    await expect(files.readText(join(root, "bin"))).rejects.toThrow("글 파일");
  });

  it("올리기는 같은 이름이면 번호를 붙이고, 내려받기 티켓은 한 번만 쓴다", async () => {
    const { root, files } = setup();
    const first = await files.upload(root, "photo.jpg", Buffer.from("1").toString("base64"));
    const second = await files.upload(root, "../photo.jpg", Buffer.from("2").toString("base64"));
    expect(first).toBe(join(root, "photo.jpg"));
    expect(second).toBe(join(root, "photo (1).jpg"));
    const ticket = await files.downloadTicket(second);
    const body: Buffer[] = [];
    const res = Object.assign(new PassThrough(), { headersSent: false, writeHead(this: { headers?: unknown }, _s: number, h: unknown) { this.headers = h; return this; } });
    res.on("data", (c: Buffer) => body.push(c));
    expect(await files.serveDownload(ticket, res as unknown as ServerResponse)).toBe(true);
    await new Promise((r) => res.on("end", r));
    expect(Buffer.concat(body).toString()).toBe("2");
    expect((res as unknown as { headers: Record<string, string> }).headers["Content-Disposition"]).toContain("photo%20(1).jpg");
    expect(await files.serveDownload(ticket, res as unknown as ServerResponse)).toBe(false);
    await expect(files.downloadTicket(root)).rejects.toThrow("파일만");
  });
});
