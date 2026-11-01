import { packageDirs } from "@pi-desktop/pi-resources";
import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { appendProposal, extensionEntries, makeProposal } from "@pi-desktop/mate-kit";
import { askPermission } from "./permission";
import { installHints } from "./install";
import { isolationDirOf, runPi, type PiLaunch, type RunOutcome } from "./executor";
import type { MatePaths } from "./paths";
import { isDue, localDateKey } from "./schedule";
import { ChangeWatchers, execCommand, notePending, type Exec } from "./watchers";
import { Observer, observerDuty } from "./observer";
import { TELEGRAM_TOKEN_ENV } from "./remote/telegram-api";
import { TelegramRemote } from "./remote/telegram-remote";
import { ChatAgent } from "./chat/chat-agent";
import type { SessionAggregate } from "./activity-types";
import { collectChange, prepareWorkspace, removeWorkspace, type Workspace } from "./workspace";
import {
  findSessionFile,
  getDuty,
  listDuties,
  loadConfig,
  loadState,
  newRunId,
  pruneRuns,
  saveState,
  takeRequests,
  writeRun,
} from "./store";
import { DEFAULT_TIMEOUT_SEC, isChangeTrigger, type Duty, type RunRecord, type RunnerState } from "./types";

// 테스트에서는 PI_DESKTOP_MATE_TICK_MS로 줄인다
const TICK_MS = Number(process.env.PI_DESKTOP_MATE_TICK_MS) || 30_000;
const LOG_LIMIT = 1_000_000;

export interface RunnerOptions {
  paths: MatePaths;
  /** mate-kit 폴더 */
  kitDir: string;
  /** 실행마다 Pi 위치를 찾는다 (사용자가 Pi를 업데이트해도 따라가도록) */
  locatePi: () => Promise<PiLaunch>;
  build?: string;
  now?: () => number;
  /** 변화 계기의 git·poll 명령 실행 (테스트에서 바꿔 끼움) */
  exec?: Exec;
}

interface Pick {
  duty: Duty;
  reason: RunRecord["reason"];
  cause?: string;
  /** 관찰자 실행: 제안에 붙일 주제 */
  topic?: string;
}

/** 끝난 Pi 세션을, 그 폴더(또는 상위 폴더)의 "작업을 마치면" 임무에 기다리는 변화로 남긴다 */
export function markSessionEnds(duties: Duty[], state: RunnerState, ended: SessionAggregate[], now: number): void {
  for (const session of ended) {
    for (const duty of duties) {
      if (!duty.enabled || duty.trigger.kind !== "session") continue;
      if (!isSameOrInside(session.cwd, duty.cwd)) continue;
      const entry = (state.duties[duty.id] ??= {});
      if (!entry.watch) continue; // 감시가 아직 자리 잡지 않음 (다음 확인부터)
      const edits = session.editedFiles.length;
      const cause = `Pi 세션이 끝남: "${session.firstPrompt ?? ""}"${edits ? ` (파일 ${edits}개 고침)` : ""}`;
      entry.watch = notePending(entry.watch, cause, now);
    }
  }
}

function isSameOrInside(child: string, parent: string): boolean {
  const norm = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  const rel = relative(norm(parent), norm(child));
  return rel === "" || (!rel.startsWith("..") && !/^[a-zA-Z]:/.test(rel));
}


export async function log(paths: MatePaths, message: string): Promise<void> {
  try {
    await mkdir(paths.runDir, { recursive: true });
    const size = await stat(paths.log).then((s) => s.size, () => 0);
    if (size > LOG_LIMIT) await writeFile(paths.log, "", "utf8");
    await appendFile(paths.log, `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch {
    // 로그 실패로 실행을 멈추지 않는다
  }
}

/**
 * act 실행의 변경을 "승인 대기" 제안으로 인박스에 올린다. 올렸으면 true (작업 공간을 남김).
 * 변경이 없거나, 같은 패치를 이미 올렸으면 false (작업 공간을 지움).
 */
async function offerChange(options: RunnerOptions, duty: Duty, runId: string, ws: Workspace, outcome: RunOutcome): Promise<boolean> {
  const change = await collectChange(options.exec ?? execCommand, ws).catch(() => undefined);
  if (!change) return false;
  const n = change.info.files.length;
  const item = makeProposal(
    {
      title: `${duty.name}: 파일 ${n}개 고침`,
      summary: outcome.summary ?? "작업 공간에서 파일을 고쳤습니다. 내용을 보고 적용할지 정하세요.",
      detail: `\`\`\`\n${change.stat}\n\`\`\`\n\n\`\`\`diff\n${change.patch}\n\`\`\``,
      severity: "action",
    },
    { dutyId: duty.id, runId },
  );
  item.hash = createHash("sha256").update(`${duty.id}\n${change.patch}`).digest("hex").slice(0, 16);
  item.change = change.info;
  if (!(await appendProposal(options.paths.inbox, item))) return false;
  outcome.proposals += 1;
  outcome.changeFiles = n;
  return true;
}

/**
 * 임무 한 번을 실행하고 기록을 남긴다.
 * observe 단계는 제안 도구가 없으므로 마지막 답변을 인박스에 결과로 남긴다 (실행마다 한 건, 같은 내용은 중복 제거).
 */
export async function runDuty(
  options: RunnerOptions,
  duty: Duty,
  run: { reason: RunRecord["reason"]; cause?: string; runId?: string; topic?: string },
  signal?: AbortSignal,
): Promise<RunRecord> {
  const { paths } = options;
  const now = options.now ?? Date.now;
  const { reason, cause } = run;
  const runId = run.runId ?? newRunId(now());
  const config = await loadConfig(paths);
  const record: RunRecord = {
    id: runId,
    dutyId: duty.id,
    dutyName: duty.name,
    reason,
    ...(cause ? { cause } : {}),
    status: "running",
    startedAt: now(),
    model: duty.model ?? config.model,
    profile: duty.profile,
    ...(duty.id.startsWith("phone-") ? { remote: true } : {}),
  };
  await writeRun(paths, record);
  await log(paths, `run start ${runId} duty=${duty.id} reason=${reason} model=${record.model}`);

  const exec = options.exec ?? execCommand;
  let outcome: RunOutcome;
  let workspace: Workspace | undefined;
  const blockedPath = join(paths.runDir, "blocked", `${runId}.jsonl`);
  try {
    // act는 사용자 폴더 대신 별도 작업 공간에서 돈다
    if (duty.profile === "act") workspace = await prepareWorkspace(exec, duty.cwd, paths.worktrees, runId);
    const [launch, extensions] = await Promise.all([options.locatePi(), extensionEntries(options.kitDir)]);
    outcome = await runPi(
      launch,
      {
        duty,
        ...(cause ? { cause } : {}),
        ...(run.topic ? { topic: run.topic } : {}),
        runId,
        model: record.model,
        extensions,
        packages: packageDirs(paths.home),
        home: paths.home,
        isolationDir: isolationDirOf(options.kitDir),
        ...(duty.profile !== "observe" ? { installHints: await installHints(paths).catch(() => []) } : {}),
        inboxPath: paths.inbox,
        chatPath: paths.chat,
        blockedPath,
        sessionsDir: paths.sessions,
        timeoutSec: duty.timeoutSec ?? DEFAULT_TIMEOUT_SEC,
        maxCostUsd: duty.maxCostUsd ?? config.maxCostUsd,
        ...(workspace ? { workspace: { cwd: workspace.cwd, root: workspace.worktree } } : {}),
      },
      signal,
    );
  } catch (error) {
    outcome = { status: "failed", error: (error as Error).message, costUsd: 0, tokens: 0, proposals: 0 };
  }

  if (workspace) {
    const kept = outcome.status === "done" && (await offerChange(options, duty, runId, workspace, outcome));
    if (!kept) await removeWorkspace(exec, workspace.repo, workspace.worktree).catch(() => undefined);
  }

  if (duty.profile === "observe" && outcome.status === "done" && outcome.summary) {
    const item = makeProposal({ title: `${duty.name} 결과`, summary: outcome.summary }, { dutyId: duty.id, runId });
    if (await appendProposal(paths.inbox, item)) outcome.proposals += 1;
  }

  await askPermission(paths, duty, runId, blockedPath, now()).catch((error: Error) => log(paths, `permission ask error ${error.message}`));

  const sessionFile = outcome.sessionId ? await findSessionFile(paths, outcome.sessionId) : undefined;
  const finished: RunRecord = { ...record, ...outcome, ...(sessionFile ? { sessionFile } : {}), endedAt: now() };
  await writeRun(paths, finished);
  await pruneRuns(paths);
  await log(paths, `run end ${runId} status=${finished.status}${finished.error ? ` error=${finished.error.split("\n")[0]}` : ""}`);
  return finished;
}

/**
 * 상주 실행기 (설계 DESIGN-MATE.md §2.3).
 * 30초마다(그리고 실행 요청 폴더가 바뀌면 바로) 요청과 시간표를 확인하고, 한 번에 하나씩 실행한다.
 */
export class Runner {
  private state: RunnerState = { duties: {}, today: { date: "", count: 0 } };
  private busy = false;
  private again = false;
  private timer: NodeJS.Timeout | undefined;
  private watcher: FSWatcher | undefined;
  private abort = new AbortController();
  /** "지금 실행" 요청 중 아직 실행하지 않은 임무 */
  private queue: string[] = [];
  private readonly watchers: ChangeWatchers;
  private readonly observer: Observer;
  private remote: TelegramRemote | undefined;
  private telegramToken: string | undefined;
  private chat: ChatAgent | undefined;

  constructor(private readonly options: RunnerOptions) {
    this.watchers = new ChangeWatchers(options.exec, (message) => void log(options.paths, message));
    this.observer = new Observer(options.paths, options.exec ?? execCommand);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  async start(): Promise<void> {
    const { paths } = this.options;
    await mkdir(paths.requests, { recursive: true });
    this.state = await loadState(paths);
    // 지난번 실행기가 실행 도중 끝났다면 그 실행은 실패로 남긴다
    delete this.state.current;
    this.state = { ...this.state, pid: process.pid, build: this.options.build, startedAt: this.now(), heartbeatAt: this.now() };
    await saveState(paths, this.state);
    await log(paths, `runner start pid=${process.pid}`);
    try {
      this.watcher = watch(paths.requests, () => void this.tick());
    } catch {
      // 감시를 못 해도 주기 확인으로 처리된다
    }
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    // Mate 대화: 임무 실행과 따로 돌아, 임무가 도는 중에도 답한다
    const exec = this.options.exec ?? execCommand;
    this.chat = new ChatAgent({ paths, kitDir: this.options.kitDir, locatePi: this.options.locatePi, exec, log: (message) => void log(paths, message), ...(this.options.now ? { now: this.options.now } : {}) });
    await this.chat.start();
    // 휴대폰 연결: 앱이 봇 토큰을 넘겼을 때만. 임무 실행과 따로 돌아 버튼에 바로 답한다
    this.setTelegramToken(process.env[TELEGRAM_TOKEN_ENV]);
    await this.tick();
  }

  /**
   * 휴대폰 연결을 이 봇 토큰으로 켜거나(바뀌었으면 다시) 끈다.
   * 로컬은 실행기를 띄울 때 환경 변수로, 원격은 앱이 붙은 뒤 RPC로 넘긴다. 토큰은 메모리에만 두고 디스크에 쓰지 않는다
   * (설계 DESIGN-MATE-REMOTE.md §5). 그래서 원격 실행기가 다시 뜨면 앱이 붙을 때까지 휴대폰 연결이 쉰다.
   */
  setTelegramToken(token: string | undefined): void {
    if (token === this.telegramToken || !this.chat) return;
    this.remote?.stop();
    this.remote = undefined;
    this.telegramToken = token || undefined;
    if (!this.telegramToken) return;
    const { paths } = this.options;
    this.remote = new TelegramRemote(paths, this.telegramToken, this.options.exec ?? execCommand, (message) => void log(paths, message), this.chat);
    this.remote.start();
  }

  /** 휴대폰 연결(텔레그램 폴링)이 켜져 있는가 */
  get phoneActive(): boolean {
    return !!this.remote;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.watcher?.close();
    this.watchers.dispose();
    this.remote?.stop();
    this.chat?.stop();
    // 도는 실행이 있으면 abort 신호로 Pi 프로세스 트리를 끝낸다
    this.abort.abort();
    await log(this.options.paths, `runner stop pid=${process.pid}`);
  }

  /**
   * 할 일이 없을 때까지 요청 → 시간표 순으로 하나씩 실행한다.
   * 확인하는 동안 다시 깨우는 신호가 오면(요청 파일이 막 생김) 할 일이 없었어도 한 번 더 확인한다.
   * 그러지 않으면 그 요청이 다음 주기 확인(30초)까지 밀린다.
   */
  async tick(): Promise<void> {
    if (this.busy) {
      this.again = true;
      return;
    }
    this.busy = true;
    try {
      do {
        this.again = false;
        const next = await this.pickNext();
        await this.heartbeat();
        if (next) {
          await this.execute(next);
          this.again = true;
        }
      } while (this.again && !this.abort.signal.aborted);
    } catch (error) {
      await log(this.options.paths, `tick error ${(error as Error).stack ?? error}`);
    } finally {
      this.busy = false;
    }
  }

  private async pickNext(): Promise<Pick | undefined> {
    const { paths } = this.options;
    const requests = await takeRequests(paths);
    for (const request of requests) this.queue.push(request.dutyId);
    while (this.queue.length > 0) {
      const duty = await getDuty(paths, this.queue.shift()!);
      if (duty) return { duty, reason: "manual" };
    }
    const today = localDateKey(this.now());
    if (this.state.today.date !== today) this.state.today = { date: today, count: 0, costUsd: 0 };
    const duties = await listDuties(paths);
    // 일시 정지·상한 중에도 변화는 기록해 둔다 (기준이 어긋나지 않게)
    await this.watchers.refresh(duties, () => this.state, this.now());
    const config = await loadConfig(paths);
    // 활동 관찰: 끝난 Pi 세션을 "작업을 마치면" 임무에 변화로 알린다
    const observed = await this.observer.tick(this.state, config, this.now()).catch(async (error: Error) => {
      await log(paths, `observe error ${error.stack ?? error.message}`);
      return { ended: [] };
    });
    markSessionEnds(duties, this.state, observed.ended, this.now());
    if (config.paused || this.state.today.count >= config.dailyRunLimit) return undefined;
    for (const duty of duties) {
      const entry = this.state.duties[duty.id];
      if (!isDue(duty, entry?.lastRunAt, this.now(), entry?.watch)) continue;
      if (!isChangeTrigger(duty.trigger)) return { duty, reason: "schedule" };
      return { duty, reason: "change", ...(entry?.watch?.pending ? { cause: entry.watch.pending.cause } : {}) };
    }
    // 할 임무가 없고 사용자가 쉬는 중이면 관찰자가 후보 하나를 살펴본다
    const job = this.observer.nextJob(this.state, config, this.now());
    if (job) return { duty: observerDuty(job, this.now()), reason: "observe", cause: job.title, topic: job.topic };
    return undefined;
  }

  private async execute({ duty, reason, cause, topic }: Pick): Promise<void> {
    const { paths } = this.options;
    const startedAt = this.now();
    // 실패해도 마지막 실행 시각을 남겨, 같은 임무를 곧바로 다시 돌리지 않는다
    this.state.duties[duty.id] = { ...this.state.duties[duty.id], lastRunAt: startedAt };
    if (reason !== "manual") this.state.today.count += 1;
    const runId = newRunId(startedAt);
    this.state.current = { runId, dutyId: duty.id, startedAt };
    await saveState(paths, this.state);
    const record = await runDuty(this.options, duty, { reason, ...(cause ? { cause } : {}), ...(topic ? { topic } : {}), runId }, this.abort.signal);
    // 실행하는 동안 생긴 변화는 남기고, 실행 전 변화만 처리한 것으로 본다
    const entry = this.state.duties[duty.id] ?? {};
    const watch = entry.watch && entry.watch.pending && entry.watch.pending.lastAt <= startedAt ? { ...entry.watch, pending: undefined } : entry.watch;
    this.state.duties[duty.id] = { ...entry, lastRunAt: startedAt, lastStatus: record.status, ...(watch ? { watch } : {}) };
    this.state.today.costUsd = (this.state.today.costUsd ?? 0) + (record.costUsd ?? 0);
    delete this.state.current;
    await saveState(paths, this.state);
  }

  private async heartbeat(): Promise<void> {
    this.state.heartbeatAt = this.now();
    await saveState(this.options.paths, this.state);
  }
}

// ── 하나만 돌기 ──

export function isAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: 있지만 신호를 보낼 권한이 없음 (살아 있음)
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function readPid(paths: MatePaths): Promise<number | undefined> {
  const text = await readFile(paths.pid, "utf8").catch(() => "");
  const pid = Number(text.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** 다른 실행기가 살아 있으면 false. 아니면 자기 pid를 기록한다 */
export async function acquirePid(paths: MatePaths): Promise<boolean> {
  await mkdir(paths.runDir, { recursive: true });
  const existing = await readPid(paths);
  if (existing && existing !== process.pid && isAlive(existing)) return false;
  await writeFile(paths.pid, String(process.pid), "utf8");
  // 동시에 둘이 떴다면 나중에 쓴 쪽만 남는다
  await new Promise((r) => setTimeout(r, 50));
  return (await readPid(paths)) === process.pid;
}

export async function releasePid(paths: MatePaths): Promise<void> {
  if ((await readPid(paths)) === process.pid) await rm(paths.pid, { force: true });
}

/**
 * 실행기를 끝내고, 끝난 것을 확인하면 pid 파일을 지운다. 끝났으면 true.
 * Windows의 kill은 강제 종료라 실행기가 releasePid를 못 하고 pid 파일이 남는다.
 * 남은 pid가 다른 프로세스에 재사용되면 다음 start·acquirePid가 그 프로세스를 실행기로 알고
 * 새 실행기를 띄우지 않는다 (start는 "started"라 답하지만 아무 실행기도 돌지 않음).
 */
export async function killRunner(paths: MatePaths, pid: number, waitMs = 5_000): Promise<boolean> {
  try {
    process.kill(pid);
  } catch {
    // 이미 끝남
  }
  for (const end = Date.now() + waitMs; isAlive(pid) && Date.now() < end; ) await new Promise((r) => setTimeout(r, 100));
  if (isAlive(pid)) return false;
  // 그사이 새 실행기가 자기 pid를 썼으면 건드리지 않는다
  if ((await readPid(paths)) === pid) await rm(paths.pid, { force: true });
  return true;
}

export async function fileHash(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex").slice(0, 16);
}
