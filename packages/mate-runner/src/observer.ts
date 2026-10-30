import { appendFile, readFile, writeFile } from "node:fs/promises";
import { appendProposal, makeProposal, readInbox } from "@pi-desktop/mate-kit";
import {
  applySessionLine,
  isObserved,
  observedSessions,
  projectCandidates,
  readNewLines,
  readProject,
  recentSessionFiles,
  sessionCandidates,
} from "./activity";
import type { ActivityRecord, Candidate, ObserverState, SessionAggregate } from "./activity-types";
import type { MatePaths } from "./paths";
import { localDateKey } from "./schedule";
import { loadInboxState } from "./store";
import type { Duty, MateConfig, RunnerState } from "./types";
import type { Exec } from "./watchers";

/**
 * 활동 관찰자 (설계 DESIGN-MATE.md §10, M4).
 *
 * 실행기가 확인할 때마다(30초):
 * 1. 사용자의 Pi 세션 파일에 새로 붙은 줄을 읽어 세션 요약을 모은다
 * 2. 세션이 조용해지면(기본 5분) "작업이 끝남"으로 본다 → 활동 기록, "작업을 마치면" 계기, 규칙 후보
 * 3. 10분마다 최근 작업한 저장소의 git 상태를 본다 → push 안 함·커밋 안 함 후보
 * 4. 규칙 후보는 바로 인박스에, 분석이 필요한 후보는 사용자가 쉬는 때 관찰자 실행(모델)으로 넘긴다
 * 사용자가 계속 버리는 주제는 덜 알린다 (인박스 처리 기록에서 배운다).
 */
export const OBSERVER_DUTY_ID = "observer";
export const OBSERVER_NAME = "Mate 관찰자";

const PROJECT_INTERVAL_MS = 10 * 60_000;
const RECENT_KEEP = 50;
const ACTIVITY_KEEP = 1500;

export function emptyObserverState(now: number): ObserverState {
  return { files: {}, projects: {}, today: { date: "", count: 0 }, suggested: {}, queue: [], recent: [], since: now };
}

/** 주제별 사용자 반응: 버림만 세 번 이상이고 받아들인 적이 없으면 그 주제는 쉰다 */
export async function topicFeedback(paths: MatePaths): Promise<Record<string, { shown: number; accepted: number; dismissed: number }>> {
  const [items, state] = await Promise.all([readInbox(paths.inbox), loadInboxState(paths)]);
  const out: Record<string, { shown: number; accepted: number; dismissed: number }> = {};
  for (const item of items) {
    if (!item.topic) continue;
    const f = (out[item.topic] ??= { shown: 0, accepted: 0, dismissed: 0 });
    f.shown += 1;
    const status = state[item.id]?.status;
    if (status === "dismissed") f.dismissed += 1;
    else if (status === "accepted" || status === "applied") f.accepted += 1;
  }
  return out;
}

export function isTopicMuted(f: { accepted: number; dismissed: number } | undefined): boolean {
  return !!f && f.dismissed >= 3 && f.accepted === 0;
}

export interface ObserveResult {
  /** 이번에 끝난 세션 ("작업을 마치면" 계기에 쓴다) */
  ended: SessionAggregate[];
}

export class Observer {
  /** 세션 파일별 bash 호출 id → 명령 (실패 결과와 짝짓기용, 메모리에만) */
  private toolCalls = new Map<string, Map<string, string>>();

  constructor(
    private readonly paths: MatePaths,
    private readonly exec: Exec,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async tick(state: RunnerState, config: MateConfig, now: number): Promise<ObserveResult> {
    if (!config.observe.enabled) {
      // 끄면 기준을 버려, 다시 켰을 때 지난 기록으로 알림이 쏟아지지 않게 한다
      if (state.observer) delete state.observer;
      return { ended: [] };
    }
    const obs = (state.observer ??= emptyObserverState(now));
    const today = localDateKey(now);
    if (obs.today.date !== today) obs.today = { date: today, count: 0 };

    const ended = await this.scanSessions(obs, config, now);
    const candidates: Candidate[] = [];
    for (const session of ended) {
      candidates.push(...sessionCandidates(session, obs.recent, now));
      obs.recent = [...obs.recent, session].slice(-RECENT_KEEP);
      await this.record({ at: now, kind: "session-ended", session });
    }
    if (!obs.projectsAt || now - obs.projectsAt >= PROJECT_INTERVAL_MS) {
      obs.projectsAt = now;
      candidates.push(...(await this.scanProjects(obs, config, now)));
    }
    await this.handle(obs, config, candidates, now);
    return { ended };
  }

  /** 사용자가 쉬는 중이면(진행 중인 세션이 없음) 관찰자에게 넘길 후보 하나를 꺼낸다 */
  nextJob(state: RunnerState, config: MateConfig, now: number): Candidate | undefined {
    const obs = state.observer;
    if (!config.observe.enabled || !obs || obs.queue.length === 0) return undefined;
    if (obs.today.count >= config.observe.dailySuggestionLimit) return undefined;
    const quiet = config.observe.quietMinutes * 60_000;
    const busy = Object.values(obs.files).some((f) => f.aggregate && f.aggregate.prompts > 0 && now - f.aggregate.lastAt < quiet);
    if (busy) return undefined;
    const job = obs.queue.shift()!;
    obs.today.count += 1;
    obs.suggested[job.key] = now;
    return job;
  }

  private async scanSessions(obs: ObserverState, config: MateConfig, now: number): Promise<SessionAggregate[]> {
    const quiet = config.observe.quietMinutes * 60_000;
    const sources = observedSessions(this.env);
    const since = now - 2 * 24 * 3_600_000;
    const files = (await Promise.all(sources.dirs.map((dir) => recentSessionFiles(dir, since)))).flat();
    const excluded = [...config.observe.excluded, ...sources.internal];
    const ended: SessionAggregate[] = [];
    for (const file of files) {
      let entry = obs.files[file.path];
      if (!entry) {
        // 관찰을 켜기 전에 이미 조용해진 세션은 읽지 않고 끝에서부터 본다
        entry = obs.files[file.path] = { offset: file.mtime < obs.since - quiet ? file.size : 0 };
      }
      if (file.size > entry.offset) {
        const calls = this.toolCalls.get(file.path) ?? new Map<string, string>();
        this.toolCalls.set(file.path, calls);
        const { lines, offset } = await readNewLines(file.path, entry.offset, file.size);
        let aggregate = entry.aggregate;
        for (const line of lines) aggregate = applySessionLine(aggregate, line, calls);
        entry.offset = offset;
        if (aggregate) entry.aggregate = aggregate;
      } else if (file.size < entry.offset) {
        entry.offset = 0; // 파일이 새로 쓰였다
      }
      const agg = entry.aggregate;
      if (!agg || agg.prompts === 0 || now - Math.max(agg.lastAt, file.mtime) < quiet) continue;
      if (entry.endedAt && entry.endedAt >= agg.lastAt) continue;
      entry.endedAt = now;
      if (isObserved(agg.cwd, excluded)) ended.push(agg);
      // 같은 세션을 이어 쓰면 다음 작업은 새로 센다
      entry.aggregate = { ...agg, startedAt: agg.lastAt, prompts: 0, firstPrompt: undefined, editedFiles: [], commands: 0, ranTests: false, failures: [], modelErrors: [] };
      delete entry.aggregate.firstPrompt;
    }
    // 이틀 넘게 안 바뀐 파일은 잊는다
    const live = new Set(files.map((f) => f.path));
    for (const path of Object.keys(obs.files)) if (!live.has(path)) delete obs.files[path];
    return ended;
  }

  private async scanProjects(obs: ObserverState, config: MateConfig, now: number): Promise<Candidate[]> {
    const week = now - 7 * 24 * 3_600_000;
    const cwds = [...new Set(obs.recent.filter((s) => s.lastAt >= week).map((s) => s.cwd))]
      .filter((cwd) => isObserved(cwd, config.observe.excluded))
      .slice(-10);
    const out: Candidate[] = [];
    for (const cwd of cwds) {
      const snapshot = await readProject(this.exec, cwd, obs.projects[cwd], now).catch(() => undefined);
      if (!snapshot) continue;
      obs.projects[cwd] = snapshot;
      out.push(...projectCandidates(snapshot, now));
    }
    for (const cwd of Object.keys(obs.projects)) if (!cwds.includes(cwd)) delete obs.projects[cwd];
    return out;
  }

  /** 후보를 걸러 규칙 후보는 바로 인박스에, 분석 후보는 관찰자 대기열에 */
  private async handle(obs: ObserverState, config: MateConfig, candidates: Candidate[], now: number): Promise<void> {
    if (candidates.length === 0) return;
    const feedback = await topicFeedback(this.paths);
    for (const c of candidates) {
      if (obs.suggested[c.key] || obs.queue.some((q) => q.key === c.key)) continue;
      if (isTopicMuted(feedback[c.topic])) continue;
      if (c.via === "observer") {
        obs.queue.push(c);
        continue;
      }
      if (obs.today.count >= config.observe.dailySuggestionLimit) continue;
      const item = makeProposal(
        { title: c.title, summary: c.detail, severity: c.topic === "session-error" ? "warn" : "info", topic: c.topic },
        { dutyId: OBSERVER_DUTY_ID, runId: `rule-${now}` },
        now,
      );
      obs.suggested[c.key] = now;
      if (await appendProposal(this.paths.inbox, item)) {
        obs.today.count += 1;
        await this.record({ at: now, kind: "suggested", topic: c.topic, key: c.key, cwd: c.cwd, title: c.title, via: "rule" });
      }
    }
    // 대기열은 최근 것 위주로 짧게
    obs.queue = obs.queue.slice(-10);
  }

  async record(record: ActivityRecord): Promise<void> {
    await appendFile(this.paths.activity, `${JSON.stringify(record)}\n`, "utf8").catch(() => undefined);
    await pruneActivity(this.paths);
  }
}

/** 관찰자 실행의 지시 (후보 하나를 살펴보고 0~1개 제안) */
export function observerPrompt(job: Candidate): string {
  return [
    "너는 사용자가 방금까지 한 작업을 지켜본 Mate 관찰자다. 아래 관찰을 바탕으로 이 저장소를 읽기만 하며 살펴보고,",
    "사용자에게 실제로 도움이 되는 제안이 있으면 mate_propose로 하나만 남겨라. 확신이 없거나 이미 괜찮으면 아무것도 남기지 마라.",
    "고칠 일이면 followUp에 구체적인 고치기 지시를 넣어라 (사용자가 \"Mate에게 맡기기\"를 누르면 그 지시로 실행된다).",
    "",
    `관찰: ${job.title}`,
    job.detail,
    job.followUp ? `\n참고할 고치기 지시 예: ${job.followUp}` : "",
  ].join("\n");
}

/** 관찰자 실행에 쓰는 임시 임무 (저장하지 않음) */
export function observerDuty(job: Candidate, now: number): Duty {
  return {
    id: OBSERVER_DUTY_ID,
    name: OBSERVER_NAME,
    enabled: true,
    cwd: job.cwd,
    prompt: observerPrompt(job),
    profile: "propose",
    trigger: { kind: "manual" },
    timeoutSec: 180,
    createdAt: now,
  };
}

async function pruneActivity(paths: MatePaths): Promise<void> {
  try {
    const text = await readFile(paths.activity, "utf8");
    const lines = text.split("\n").filter(Boolean);
    if (lines.length > ACTIVITY_KEEP * 1.5) await writeFile(paths.activity, `${lines.slice(-ACTIVITY_KEEP).join("\n")}\n`, "utf8");
  } catch {
    // 없으면 지울 것도 없다
  }
}

export async function readActivity(paths: MatePaths, limit = 200): Promise<ActivityRecord[]> {
  try {
    const lines = (await readFile(paths.activity, "utf8")).split("\n").filter(Boolean).slice(-limit);
    return lines.flatMap((l) => {
      try {
        return [JSON.parse(l) as ActivityRecord];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}
