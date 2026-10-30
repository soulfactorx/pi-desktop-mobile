import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execCommand } from "../src/watchers";
import { applyChange, collectChange, isInside, prepareWorkspace, removeWorkspace } from "../src/workspace";

const run = promisify(execFile);
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

let base: string;
let repo: string;
let worktrees: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "mate-ws-"));
  repo = join(base, "repo");
  worktrees = join(base, "home", "worktrees");
  await mkdir(join(repo, "pkg"), { recursive: true });
  await writeFile(join(repo, "pkg", "a.txt"), "one\n");
  const git = (...args: string[]) => run("git", args, { cwd: repo, env: gitEnv });
  await git("init", "-q", "-b", "main");
  await git("config", "core.autocrlf", "false");
  await git("add", ".");
  await git("commit", "-qm", "first");
});

afterEach(async () => {
  await run("git", ["worktree", "prune"], { cwd: repo }).catch(() => undefined);
  await rm(base, { recursive: true, force: true });
});

describe("act 작업 공간", () => {
  it("HEAD에서 브랜치 없이 만들고, 하위 폴더 임무는 그 폴더에서 시작한다", async () => {
    const ws = await prepareWorkspace(execCommand, join(repo, "pkg"), worktrees, "r1");
    expect(isInside(ws.worktree, worktrees)).toBe(true);
    expect(ws.cwd).toBe(join(ws.worktree, "pkg"));
    expect(await readFile(join(ws.cwd, "a.txt"), "utf8")).toBe("one\n");
    const { stdout: branches } = await run("git", ["branch", "--list"], { cwd: repo });
    expect(branches.trim()).toBe("* main");
    // 변경이 없으면 undefined
    expect(await collectChange(execCommand, ws)).toBeUndefined();
    await removeWorkspace(execCommand, ws.repo, ws.worktree);
    expect(existsSync(ws.worktree)).toBe(false);
  });

  it("git 저장소가 아니면 이유를 알린다", async () => {
    const plain = join(base, "plain");
    await mkdir(plain);
    await expect(prepareWorkspace(execCommand, plain, worktrees, "r0")).rejects.toThrow(/git 저장소에서만/);
  });

  it("고친 내용(새 파일 포함)을 모아 사용자 폴더에 커밋하지 않은 변경으로 적용한다", async () => {
    const ws = await prepareWorkspace(execCommand, repo, worktrees, "r2");
    await writeFile(join(ws.worktree, "pkg", "a.txt"), "one\ntwo\n");
    await writeFile(join(ws.worktree, "new.txt"), "새 파일\n");
    const change = await collectChange(execCommand, ws);
    expect(change?.info.files.sort()).toEqual(["new.txt", "pkg/a.txt"]);
    expect(change?.patch).toContain("+two");
    // 사용자 폴더는 적용 전까지 그대로
    expect(await readFile(join(repo, "pkg", "a.txt"), "utf8")).toBe("one\n");

    await applyChange(execCommand, change!.info, join(base, "p.patch"));
    expect(await readFile(join(repo, "pkg", "a.txt"), "utf8")).toBe("one\ntwo\n");
    expect(await readFile(join(repo, "new.txt"), "utf8")).toBe("새 파일\n");
    const { stdout: log } = await run("git", ["log", "--oneline"], { cwd: repo });
    expect(log.trim().split("\n")).toHaveLength(1);
  });

  it("그사이 사용자가 같은 줄을 바꿨으면 적용하지 않고 이유를 알린다", async () => {
    const ws = await prepareWorkspace(execCommand, repo, worktrees, "r3");
    await writeFile(join(ws.worktree, "pkg", "a.txt"), "mate\n");
    const change = await collectChange(execCommand, ws);
    await writeFile(join(repo, "pkg", "a.txt"), "user\n");
    await expect(applyChange(execCommand, change!.info, join(base, "p.patch"))).rejects.toThrow(/그대로 적용할 수 없습니다/);
    expect(await readFile(join(repo, "pkg", "a.txt"), "utf8")).toBe("user\n");
  });
});
