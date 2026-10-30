import { mkdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { ChangeInfo } from "@pi-desktop/mate-kit";
import type { Exec } from "./watchers";

/**
 * act 단계의 작업 공간 (설계 DESIGN-MATE.md §4).
 *
 * 사용자 저장소의 HEAD에서 브랜치 없는(detached) git worktree를 Mate 홈 worktrees/ 아래에 만든다.
 * Pi는 그 안에서만 고치고, 변경은 커밋하지 않고 남긴다. 사용자가 인박스에서 "적용"하면 diff를 자기 작업 폴더에 적용한다.
 * 브랜치·커밋을 만들지 않으므로 사용자 저장소의 브랜치 목록과 커밋 훅을 건드리지 않는다.
 * 사용자의 커밋하지 않은 변경은 작업 공간에 없다 (HEAD 기준).
 */
export interface Workspace {
  repo: string;
  worktree: string;
  base: string;
  /** 임무 폴더에 해당하는 작업 공간 안 폴더 (임무가 저장소의 하위 폴더일 때) */
  cwd: string;
}

const PATCH_LIMIT = 200_000;

async function git(exec: Exec, cwd: string, ...args: string[]): Promise<string> {
  const result = await exec("git", args, cwd);
  if (result.code !== 0) throw new Error(`git ${args[0]} 실패`);
  return result.stdout.trim();
}

export async function prepareWorkspace(exec: Exec, dutyCwd: string, worktreesDir: string, runId: string): Promise<Workspace> {
  let repo: string;
  try {
    repo = resolve(await git(exec, dutyCwd, "rev-parse", "--show-toplevel"));
  } catch {
    throw new Error("고치기(act) 단계는 git 저장소에서만 쓸 수 있습니다");
  }
  const base = await git(exec, repo, "rev-parse", "HEAD");
  // 임무 폴더가 저장소의 어느 하위 폴더인지는 git에게 묻는다. 경로끼리 계산하면 Windows 짧은 이름(RUNNER~1)과
  // git이 돌려주는 긴 이름이 달라 엉뚱한 상대 경로가 나온다
  const prefix = await git(exec, dutyCwd, "rev-parse", "--show-prefix");
  await mkdir(worktreesDir, { recursive: true });
  const worktree = join(worktreesDir, runId);
  await git(exec, repo, "worktree", "add", "--detach", worktree, base);
  return { repo, worktree, base, cwd: prefix ? join(worktree, prefix.replace(/\/$/, "")) : worktree };
}

/** 작업 공간의 변경(새 파일 포함)을 모은다. 없으면 undefined */
export async function collectChange(exec: Exec, ws: Workspace): Promise<{ info: ChangeInfo; stat: string; patch: string } | undefined> {
  await git(exec, ws.worktree, "add", "-A");
  const names = await git(exec, ws.worktree, "diff", "--cached", "--name-only", ws.base);
  const files = names.split(/\r?\n/).filter(Boolean);
  if (files.length === 0) return undefined;
  const stat = await git(exec, ws.worktree, "diff", "--cached", "--stat", ws.base);
  const full = await exec("git", ["diff", "--cached", ws.base], ws.worktree);
  const patch = full.stdout.length > PATCH_LIMIT ? `${full.stdout.slice(0, PATCH_LIMIT)}\n… (diff가 길어 잘랐습니다)` : full.stdout;
  return { info: { repo: ws.repo, worktree: ws.worktree, base: ws.base, files }, stat, patch };
}

/** 작업 공간의 변경을 사용자 작업 폴더에 적용한다 (커밋하지 않은 변경으로 남는다) */
export async function applyChange(exec: Exec, change: ChangeInfo, patchFile: string): Promise<void> {
  // 바이너리 포함 전체 diff를 파일로 받아 사용자 저장소에 적용한다. 먼저 --check로 깨끗이 들어가는지 본다
  const diff = await exec("git", ["diff", "--cached", "--binary", `--output=${patchFile}`, change.base], change.worktree);
  if (diff.code !== 0) throw new Error("작업 공간의 변경을 읽지 못했습니다");
  const check = await exec("git", ["apply", "--check", "--whitespace=nowarn", patchFile], change.repo);
  if (check.code !== 0) {
    throw new Error(`내 작업 폴더가 그사이 바뀌어 그대로 적용할 수 없습니다. 작업 공간(${change.worktree})에서 직접 확인해 주세요`);
  }
  await git(exec, change.repo, "apply", "--whitespace=nowarn", patchFile);
}

/** 작업 공간을 지운다. git이 만든 worktree라 git으로 지우고, 기록이 남지 않게 prune한다 */
export async function removeWorkspace(exec: Exec, repo: string, worktree: string): Promise<void> {
  await exec("git", ["worktree", "remove", "--force", worktree], repo);
  await exec("git", ["worktree", "prune"], repo);
}

export function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== "" && !rel.startsWith("..") && !/^[a-zA-Z]:/.test(rel);
}
