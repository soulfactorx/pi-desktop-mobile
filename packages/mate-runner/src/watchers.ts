import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { checkCommand, splitCommand } from "@pi-desktop/mate-kit";
import { isChangeTrigger, type Duty, type RunnerState, type WatchState } from "./types";

/**
 * 변화 계기 감시 (설계 DESIGN-MATE.md §3, M2).
 *
 * - git: 실행기가 확인할 때마다(30초) `git rev-parse`로 브랜치·커밋을 본다.
 * - poll: 정한 간격마다 읽기 명령을 돌려 출력 해시를 본다.
 * - files: 작업 폴더를 fs.watch로 지켜보고, 저장이 잠잠해지면 실행한다.
 * 처음 본 값은 기준으로만 삼는다. 임무를 만들자마자, 또는 실행기를 다시 띄우자마자 돌지 않게 하기 위해서다.
 */

/** 파일 계기에서 무시하는 폴더 (빌드 결과·의존성·git 내부) */
const IGNORED = /(^|[\\/])(\.git|node_modules|dist|out|build|coverage|\.dev|\.vite|\.next|\.turbo|\.cache)([\\/]|$)/;

/** 계기 종류·폴더·명령이 같으면 같은 감시로 본다. 바뀌면 기준부터 다시 잡는다 */
export function watchKey(duty: Duty): string {
  const t = duty.trigger;
  return `${t.kind}|${duty.cwd}|${t.kind === "poll" ? t.command : ""}`;
}

export function isIgnoredPath(relative: string): boolean {
  return IGNORED.test(relative);
}

/** 본 값(signature)을 기록한다. 처음이면 기준만 남기고, 바뀌었으면 실행을 기다리는 변화로 둔다 */
export function noteSignature(watch: WatchState, signature: string, cause: string, now: number): WatchState {
  if (watch.signature === undefined) return { ...watch, signature };
  if (watch.signature === signature) return watch;
  return { ...watch, signature, pending: addPending(watch.pending, cause, now) };
}

function addPending(pending: WatchState["pending"], cause: string, now: number): NonNullable<WatchState["pending"]> {
  return pending ? { ...pending, lastAt: now, cause, count: pending.count + 1 } : { since: now, lastAt: now, cause, count: 1 };
}

const MAX_FILES = 20;

/** 바깥(예: 활동 관찰)에서 알린 변화를 기다리는 변화로 더한다 */
export function notePending(watch: WatchState, cause: string, now: number): WatchState {
  return { ...watch, pending: addPending(watch.pending, cause, now) };
}

/** 파일 변경 하나를 기록한다 (잦은 저장은 묶임: 마지막 변경 시각만 늦추고, 같은 파일은 한 번만 센다) */
export function noteFileChange(watch: WatchState, relative: string, now: number): WatchState {
  const known = watch.pending?.files ?? [];
  const seen = known.includes(relative);
  const files = seen || known.length >= MAX_FILES ? known : [...known, relative];
  const count = (watch.pending?.count ?? 0) + (seen ? 0 : 1);
  const shown = files.slice(0, 3).join(", ") + (count > 3 ? " 등" : "");
  const cause = count === 1 ? `파일 바뀜: ${relative}` : `파일 ${count}개 바뀜 (${shown})`;
  return { ...watch, pending: { ...addPending(watch.pending, cause, now), cause, count, files } };
}

/** poll 명령으로 쓸 수 있는지: 읽기 허용 목록을 통과하는 단일 명령 (파이프·&& 없이) */
export function pollCommandError(command: string): string | undefined {
  const verdict = checkCommand(command);
  if (!verdict.allowed) return verdict.reason;
  const split = splitCommand(command);
  if ("reason" in split || split.segments.length !== 1) return "명령 하나만 쓸 수 있습니다 (|, &&, ; 없이)";
  return undefined;
}

export type Exec = (command: string, args: string[], cwd: string) => Promise<{ code: number; stdout: string }>;

/** 셸 없이 실행한다. Windows의 .cmd(npm 등)는 셸이 필요해, 찾지 못하면 셸로 한 번 더 시도한다 */
export const execCommand: Exec = (command, args, cwd) =>
  new Promise((resolve) => {
    const run = (shell: boolean) =>
      execFile(
        command,
        shell ? args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : args,
        { cwd, timeout: 60_000, windowsHide: true, shell, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout) => {
          const code = (error as NodeJS.ErrnoException | null)?.code;
          if (code === "ENOENT" && !shell && process.platform === "win32") return run(true);
          resolve({ code: error ? (typeof code === "number" ? code : 1) : 0, stdout: String(stdout ?? "") });
        },
      );
    run(false);
  });

export async function gitSignature(exec: Exec, cwd: string): Promise<{ signature: string; cause: string } | undefined> {
  const head = await exec("git", ["rev-parse", "--short", "HEAD"], cwd);
  if (head.code !== 0) return undefined;
  const branch = await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const sha = head.stdout.trim();
  const name = branch.code === 0 ? branch.stdout.trim() : "?";
  return { signature: `${name}@${sha}`, cause: `커밋 ${sha} (${name})` };
}

export class ChangeWatchers {
  private files = new Map<string, { cwd: string; watcher: FSWatcher }>();

  constructor(
    private readonly exec: Exec = execCommand,
    private readonly onError: (message: string) => void = () => {},
  ) {}

  /**
   * 임무 목록에 맞춰 감시를 고치고, git·poll 계기를 확인해 state에 기록한다.
   * 파일 변경은 fs.watch 콜백이 state에 바로 기록한다 (getState로 최신 state를 얻음).
   */
  async refresh(duties: Duty[], getState: () => RunnerState, now: number): Promise<void> {
    const active = duties.filter((d) => d.enabled && isChangeTrigger(d.trigger));
    const keys = new Map(active.map((d) => [d.id, watchKey(d)]));
    // 지워지거나 꺼지거나 계기가 바뀐 임무는 기다리던 변화·기준을 버린다
    for (const [id, entry] of Object.entries(getState().duties)) {
      if (entry.watch && entry.watch.key !== keys.get(id)) delete entry.watch;
    }
    this.syncFileWatchers(active.filter((d) => d.trigger.kind === "files"), getState);

    for (const duty of active) {
      const state = getState();
      const entry = (state.duties[duty.id] ??= {});
      const current: WatchState = entry.watch ?? { key: keys.get(duty.id)! };
      entry.watch = current;
      const t = duty.trigger;
      try {
        if (t.kind === "git") {
          const seen = await gitSignature(this.exec, duty.cwd);
          if (seen) entry.watch = noteSignature(current, seen.signature, seen.cause, now);
        } else if (t.kind === "poll") {
          if (current.polledAt !== undefined && now - current.polledAt < t.minutes * 60_000) continue;
          const error = pollCommandError(t.command);
          if (error) {
            this.onError(`poll ${duty.id}: ${error}`);
            continue;
          }
          const words = (splitCommand(t.command) as { segments: string[][] }).segments[0]!;
          const result = await this.exec(words[0]!, words.slice(1), duty.cwd);
          const hash = createHash("sha256").update(`${result.code}\n${result.stdout.trim()}`).digest("hex").slice(0, 16);
          entry.watch = { ...noteSignature(current, hash, `"${t.command}" 결과가 바뀜`, now), polledAt: now };
        }
      } catch (error) {
        this.onError(`watch ${duty.id}: ${(error as Error).message}`);
      }
    }
  }

  private syncFileWatchers(duties: Duty[], getState: () => RunnerState): void {
    const wanted = new Map(duties.map((d) => [d.id, d.cwd]));
    for (const [id, entry] of this.files) {
      if (wanted.get(id) !== entry.cwd) {
        entry.watcher.close();
        this.files.delete(id);
      }
    }
    for (const [id, cwd] of wanted) {
      if (this.files.has(id)) continue;
      try {
        const watcher = watch(cwd, { recursive: true }, (_event, name) => {
          const relative = name ? String(name) : "";
          if (!relative || isIgnoredPath(relative)) return;
          const entry = (getState().duties[id] ??= {});
          if (!entry.watch) return;
          entry.watch = noteFileChange(entry.watch, relative.replace(/\\/g, "/"), Date.now());
        });
        watcher.on("error", (error) => this.onError(`files ${id}: ${error.message}`));
        this.files.set(id, { cwd, watcher });
      } catch (error) {
        this.onError(`files ${id}: ${(error as Error).message}`);
      }
    }
  }

  dispose(): void {
    for (const entry of this.files.values()) entry.watcher.close();
    this.files.clear();
  }
}
