import { join, normalize } from "node:path";
import { describe, expect, it } from "vitest";
import { contentType, resolveStatic } from "../../src/server/static-files";

const root = normalize("/srv/pi-web/public");

describe("resolveStatic", () => {
  it("/는 index.html, 나머지는 root 안의 파일", () => {
    expect(resolveStatic(root, "/")).toBe(join(root, "index.html"));
    expect(resolveStatic(root, "/assets/a.js?v=1")).toBe(join(root, "assets", "a.js"));
    expect(resolveStatic(root, "/%ED%95%9C.txt")).toBe(join(root, "한.txt"));
  });

  it("root 밖을 가리키면 undefined", () => {
    expect(resolveStatic(root, "/../server.mjs")).toBeUndefined();
    expect(resolveStatic(root, "/%2e%2e/server.mjs")).toBeUndefined();
    expect(resolveStatic(root, "/assets/../../token")).toBeUndefined();
    expect(resolveStatic(root, "/a%00.js")).toBeUndefined();
    expect(resolveStatic(root, "/%E0%A4%A")).toBeUndefined();
  });

  it("확장자로 형식을 정한다", () => {
    expect(contentType("a.js")).toMatch(/javascript/);
    expect(contentType("manifest.webmanifest")).toMatch(/manifest/);
    expect(contentType("x.bin")).toBe("application/octet-stream");
  });
});
