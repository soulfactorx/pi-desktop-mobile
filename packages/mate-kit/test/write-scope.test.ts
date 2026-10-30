import { mkdir, mkdtemp, rm, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeScopeError } from "../src/write-scope";

let base: string;
let root: string;
let outside: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "mate-scope-"));
  root = join(base, "wt");
  outside = join(base, "outside");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(root, "src", "a.ts"), "x");
});

afterAll(async () => {
  // 링크(Windows junction)는 재귀 삭제가 따라 들어갈 수 있어 링크만 먼저 끊는다. 대상도 base 안이라 밖은 건드리지 않는다
  const link = join(root, "escape");
  await unlink(link).catch(() => rmdir(link).catch(() => {}));
  await rm(base, { recursive: true, force: true });
});

describe("writeScopeError", () => {
  it("작업 공간 안의 새 파일·기존 파일은 허용한다 (상대·절대·@ 경로)", () => {
    expect(writeScopeError("src/a.ts", root, root)).toBeUndefined();
    expect(writeScopeError("@src/new/b.ts", join(root, "src"), root)).toBeUndefined();
    expect(writeScopeError(join(root, "c.ts"), root, root)).toBeUndefined();
  });

  it("밖·홈·.git은 막는다", () => {
    expect(writeScopeError("../outside/x.ts", root, root)).toMatch(/밖/);
    expect(writeScopeError(join(outside, "x.ts"), root, root)).toMatch(/밖/);
    expect(writeScopeError("~/.bashrc", root, root)).toMatch(/홈/);
    expect(writeScopeError(".git/config", root, root)).toMatch(/\.git/);
    expect(writeScopeError("sub/.GIT/hooks/x", root, root)).toMatch(/\.git/);
    expect(writeScopeError("  ", root, root)).toMatch(/비었/);
  });

  it("밖을 가리키는 링크를 통해서는 쓸 수 없다", async () => {
    try {
      // Windows는 디렉터리 링크로 junction을 쓴다 (관리자 권한 없이 만들 수 있음). 테스트 폴더 안에서만 만들고 지운다
      await symlink(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      return; // 링크를 만들 수 없는 환경
    }
    expect(writeScopeError("escape/x.ts", root, root)).toMatch(/링크/);
  });
});
