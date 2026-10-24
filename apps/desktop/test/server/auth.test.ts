import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bearerToken, isLoopbackAddress, loadOrCreateToken, requestAllowed, tokenMatches } from "../../src/server/auth";

describe("웹 서버 토큰", () => {
  it("처음에 만들어 0600으로 두고, 다음에는 같은 토큰을 읽는다", () => {
    const path = join(mkdtempSync(join(tmpdir(), "pi-web-")), "data", "token");
    const token = loadOrCreateToken(path);
    expect(token.length).toBeGreaterThanOrEqual(16);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadOrCreateToken(path)).toBe(token);
  });

  it("너무 짧은 토큰 파일은 새로 만든다", () => {
    const path = join(mkdtempSync(join(tmpdir(), "pi-web-")), "token");
    writeFileSync(path, "abc\n");
    const token = loadOrCreateToken(path);
    expect(token).not.toBe("abc");
    expect(readFileSync(path, "utf8").trim()).toBe(token);
  });

  it("토큰을 견준다", () => {
    expect(tokenMatches("secret-token-123456", "secret-token-123456")).toBe(true);
    expect(tokenMatches("secret-token-123456", "secret-token-12345")).toBe(false);
    expect(tokenMatches("secret-token-123456", undefined)).toBe(false);
    expect(tokenMatches("secret-token-123456", "")).toBe(false);
  });

  it("Authorization 머리글에서 Bearer 토큰을 꺼낸다", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("bearer  abc")).toBe("abc");
    expect(bearerToken("Basic abc")).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });
});

describe("requestAllowed", () => {
  it("localhost에만 열었으면 다른 이름으로 온 요청(DNS rebinding)을 막는다", () => {
    expect(requestAllowed({ host: "127.0.0.1:8787" }, true)).toBe(true);
    expect(requestAllowed({ host: "localhost:8787" }, true)).toBe(true);
    expect(requestAllowed({ host: "[::1]:8787" }, true)).toBe(true);
    expect(requestAllowed({ host: "evil.example:8787" }, true)).toBe(false);
    expect(requestAllowed({ host: "192.168.0.5:8787" }, true)).toBe(false);
    expect(requestAllowed({}, true)).toBe(false);
  });

  it("다른 기기에도 열었으면 Host는 받되, Origin은 Host와 같아야 한다", () => {
    expect(requestAllowed({ host: "192.168.0.5:8787" }, false)).toBe(true);
    expect(requestAllowed({ host: "192.168.0.5:8787", origin: "http://192.168.0.5:8787" }, false)).toBe(true);
    expect(requestAllowed({ host: "192.168.0.5:8787", origin: "http://evil.example" }, false)).toBe(false);
  });

  it("교차 출처 Origin을 막는다", () => {
    expect(requestAllowed({ host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787" }, true)).toBe(true);
    expect(requestAllowed({ host: "127.0.0.1:8787", origin: "http://localhost:8787" }, true)).toBe(false);
    expect(requestAllowed({ host: "127.0.0.1:8787", origin: "null" }, true)).toBe(false);
  });

  it("주소가 이 기기 안인지", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("0.0.0.0")).toBe(false);
  });
});
