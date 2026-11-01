import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isGrant, isProfile, isToolGrant } from "@pi-desktop/mate-kit";
import type { MatePaths } from "./paths";
import { parseTime } from "./schedule";
import { pollCommandError } from "./watchers";
import { moveToTrash } from "./trash";
import {
  DEFAULT_COOLDOWN_MINUTES,
  DEFAULT_QUIET_SECONDS,
  MIN_COOLDOWN_MINUTES,
  DEFAULT_CONFIG,
  MIN_INTERVAL_MINUTES,
  type Duty,
  type InboxState,
  type InboxStatus,
  type MateConfig,
  type RunRecord,
  type RunnerState,
  type RunRequest,
  type Trigger,
} from "./types";

/**
 * ~/.pi-desktop-mate 파일 읽기·쓰기 (설계 DESIGN-MATE.md §2.2).
 * 파일마다 쓰는 쪽이 하나다: config·duties·requests·inbox-state는 앱, state·runs는 실행기.
 * 쓰기는 임시 파일에 쓴 뒤 바꿔 넣어, 읽는 쪽이 반쯤 쓴 파일을 보지 않게 한다.
 */

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  // Windows에서 읽는 쪽이 파일을 잠깐 열고 있으면 바꿔 넣기가 실패할 수 있어 몇 번 다시 시도한다.
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, path);
      return;
    } catch (error) {
      if (attempt >= 5) {
        await rm(tmp, { force: true });
        throw error;
      }
      await new Promise((r) => setTimeout(r, 30 * (attempt + 1)));
    }
  }
}

// ── 설정 ──

export async function loadConfig(paths: MatePaths): Promise<MateConfig> {
  const raw = await readJson<Partial<MateConfig>>(paths.config, {});
  return {
    // 빈 문자열은 "Pi 기본 모델 따르기" (설정 파일에 model이 아예 없으면 Mate 기본값)
    model: typeof raw.model === "string" ? raw.model.trim() : DEFAULT_CONFIG.model,
    paused: raw.paused === true,
    dailyRunLimit:
      typeof raw.dailyRunLimit === "number" && raw.dailyRunLimit >= 0 ? Math.floor(raw.dailyRunLimit) : DEFAULT_CONFIG.dailyRunLimit,
    maxCostUsd: typeof raw.maxCostUsd === "number" && raw.maxCostUsd >= 0 ? raw.maxCostUsd : DEFAULT_CONFIG.maxCostUsd,
    observe: normalizeObserve(raw.observe),
    telegram: normalizeTelegram(raw.telegram),
    chatMcpServers: names(raw.chatMcpServers, isServerName),
    chatGrants: names(raw.chatGrants, isToolGrant),
    desktopNotify: raw.desktopNotify !== false,
  };
}

/** 이름 목록을 검사해 겹치지 않게 남긴다 */
function names(raw: unknown, valid: (name: string) => boolean): string[] {
  return Array.isArray(raw) ? [...new Set(raw.filter((x): x is string => typeof x === "string" && valid(x)))] : [];
}

/** MCP 서버 이름 (Pi mcp.json 규칙) */
export function isServerName(name: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(name);
}

/** 스킬 이름 (Agent Skills 규격: 소문자·숫자·하이픈) */
export function isSkillName(name: string): boolean {
  return name.length <= 64 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name);
}

function normalizeTelegram(raw: unknown): MateConfig["telegram"] {
  const t = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<string, unknown>>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const quiet = t.quiet as { start?: unknown; end?: unknown } | undefined;
  const validQuiet = quiet && typeof quiet.start === "string" && parseTime(quiet.start) && typeof quiet.end === "string" && parseTime(quiet.end);
  return {
    enabled: t.enabled === true,
    ...(str(t.tokenEnc) ? { tokenEnc: str(t.tokenEnc) } : {}),
    ...(str(t.botName) ? { botName: str(t.botName) } : {}),
    ...(str(t.tokenHint) ? { tokenHint: str(t.tokenHint) } : {}),
    ...(str(t.pairingCode) && typeof t.pairingExpires === "number" ? { pairingCode: str(t.pairingCode), pairingExpires: t.pairingExpires } : {}),
    pairEpoch: typeof t.pairEpoch === "number" ? t.pairEpoch : 0,
    notify: t.notify === "all" ? "all" : "action",
    ...(validQuiet ? { quiet: { start: quiet!.start as string, end: quiet!.end as string } } : {}),
    sendDetail: t.sendDetail !== false,
    allowFix: t.allowFix === true,
    mirrorApp: t.mirrorApp === true,
    ...(typeof t.mirrorAppSince === "number" ? { mirrorAppSince: t.mirrorAppSince } : {}),
  };
}

function normalizeObserve(raw: unknown): MateConfig["observe"] {
  const o = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<string, unknown>>;
  const d = DEFAULT_CONFIG.observe;
  const int = (v: unknown, fallback: number, min: number, max: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;
  return {
    enabled: o.enabled === true,
    quietMinutes: int(o.quietMinutes, d.quietMinutes, 1, 120),
    dailySuggestionLimit: int(o.dailySuggestionLimit, d.dailySuggestionLimit, 0, 50),
    excluded: Array.isArray(o.excluded) ? o.excluded.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : [],
  };
}

/** 설정 일부를 바꾼다. 관찰 설정도 일부만 줄 수 있다 */
export type ConfigPatch = Partial<Omit<MateConfig, "observe" | "telegram">> & {
  observe?: Partial<MateConfig["observe"]>;
  telegram?: Partial<MateConfig["telegram"]>;
};

export async function saveConfig(paths: MatePaths, patch: ConfigPatch): Promise<MateConfig> {
  const current = await loadConfig(paths);
  const next = { ...current, ...patch, observe: { ...current.observe, ...patch.observe }, telegram: { ...current.telegram, ...patch.telegram } };
  await writeJsonAtomic(paths.config, next);
  return loadConfig(paths);
}

// ── 임무 ──

const DUTY_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isDutyId(id: unknown): id is string {
  return typeof id === "string" && DUTY_ID.test(id);
}

/** 이름에서 파일 이름으로 쓸 수 있는 id를 만든다 (한글 등은 빼고, 비면 무작위) */
export function dutyIdFrom(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || `duty-${randomUUID().slice(0, 6)}`;
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  return id;
}

const minutesOr = (value: unknown, fallback: number, min: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.round(value)) : fallback;

/** 잘못된 계기는 이유(문자열)를 돌려준다 */
function normalizeTrigger(raw: unknown): Trigger | string {
  const t = raw as Partial<Record<string, unknown>> | undefined;
  if (!t || typeof t !== "object") return "실행 시점이 잘못되었습니다";
  if (t.kind === "git" || t.kind === "files" || t.kind === "session") {
    const cooldownMinutes = minutesOr(t.cooldownMinutes, DEFAULT_COOLDOWN_MINUTES, MIN_COOLDOWN_MINUTES);
    if (t.kind === "git") return { kind: "git", cooldownMinutes };
    if (t.kind === "session") return { kind: "session", cooldownMinutes };
    const quietSeconds = minutesOr(t.quietSeconds, DEFAULT_QUIET_SECONDS, 10);
    return { kind: "files", quietSeconds, cooldownMinutes };
  }
  if (t.kind === "poll") {
    const command = typeof t.command === "string" ? t.command.trim() : "";
    if (!command) return "확인할 명령이 필요합니다";
    const error = pollCommandError(command);
    if (error) return `확인 명령: ${error}`;
    return { kind: "poll", command, minutes: minutesOr(t.minutes, 60, MIN_INTERVAL_MINUTES) };
  }
  if (t.kind === "manual") return { kind: "manual" };
  if (t.kind === "interval" && typeof t.minutes === "number" && Number.isFinite(t.minutes)) {
    const minutes = Math.max(MIN_INTERVAL_MINUTES, Math.round(t.minutes));
    const weekdays = weekdaysOf(t.weekdays);
    const hasWindow = t.from !== undefined || t.to !== undefined;
    if (hasWindow && !(typeof t.from === "string" && parseTime(t.from) && typeof t.to === "string" && parseTime(t.to) && t.from !== t.to)) {
      return "시간대는 시작과 끝 시각(HH:MM)이 모두 필요하고 서로 달라야 합니다";
    }
    return {
      kind: "interval",
      minutes,
      ...(hasWindow ? { from: (t.from as string).padStart(5, "0"), to: (t.to as string).padStart(5, "0") } : {}),
      ...(weekdays ? { weekdays } : {}),
    };
  }
  if (t.kind === "daily" && typeof t.time === "string" && parseTime(t.time)) {
    const weekdays = weekdaysOf(t.weekdays);
    return weekdays ? { kind: "daily", time: t.time, weekdays } : { kind: "daily", time: t.time };
  }
  return "실행 시점이 잘못되었습니다";
}

/** 요일 목록을 정리한다. 없거나 모든 요일이면 undefined (매일) */
function weekdaysOf(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const days = [...new Set(raw.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  return days.length > 0 && days.length < 7 ? days : undefined;
}

/** 파일·화면에서 온 값을 검사해 임무로 만든다. 잘못되면 이유를 돌려준다 */
export function normalizeDuty(raw: unknown): Duty | string {
  const d = raw as Partial<Record<string, unknown>> | undefined;
  if (!d || typeof d !== "object") return "임무 형식이 아닙니다";
  if (!isDutyId(d.id)) return "id는 영문 소문자·숫자·-만 쓸 수 있습니다";
  if (typeof d.name !== "string" || !d.name.trim()) return "이름이 필요합니다";
  if (typeof d.cwd !== "string" || !d.cwd.trim()) return "작업 폴더가 필요합니다";
  if (typeof d.prompt !== "string" || !d.prompt.trim()) return "지시가 필요합니다";
  if (!isProfile(d.profile)) return "권한 단계가 잘못되었습니다";
  const trigger = normalizeTrigger(d.trigger);
  if (typeof trigger === "string") return trigger;
  const duty: Duty = {
    id: d.id,
    name: d.name.trim(),
    enabled: d.enabled !== false,
    cwd: d.cwd.trim(),
    prompt: d.prompt.trim(),
    profile: d.profile,
    trigger,
    createdAt: typeof d.createdAt === "number" ? d.createdAt : Date.now(),
  };
  if (typeof d.model === "string" && d.model.trim()) duty.model = d.model.trim();
  if (typeof d.timeoutSec === "number" && d.timeoutSec > 0) duty.timeoutSec = Math.min(3600, Math.round(d.timeoutSec));
  if (typeof d.maxCostUsd === "number" && d.maxCostUsd > 0) duty.maxCostUsd = d.maxCostUsd;
  const grants = names(d.grants, isGrant);
  if (grants.length) duty.grants = grants;
  // 스킬은 없으면 전부라서 빈 배열(스킬 없음)도 남긴다
  if (Array.isArray(d.skills)) duty.skills = names(d.skills, isSkillName);
  const servers = names(d.mcpServers, isServerName);
  if (servers.length) duty.mcpServers = servers;
  if (typeof d.updatedAt === "number") duty.updatedAt = d.updatedAt;
  return duty;
}

export async function listDuties(paths: MatePaths): Promise<Duty[]> {
  let names: string[];
  try {
    names = await readdir(paths.duties);
  } catch {
    return [];
  }
  const duties: Duty[] = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    const duty = normalizeDuty(await readJson<unknown>(join(paths.duties, name), undefined));
    if (typeof duty !== "string" && `${duty.id}.json` === name) duties.push(duty);
  }
  return duties.sort((a, b) => a.createdAt - b.createdAt);
}

export async function getDuty(paths: MatePaths, id: string): Promise<Duty | undefined> {
  if (!isDutyId(id)) return undefined;
  const duty = normalizeDuty(await readJson<unknown>(join(paths.duties, `${id}.json`), undefined));
  return typeof duty === "string" ? undefined : duty;
}

export async function saveDuty(paths: MatePaths, raw: unknown): Promise<Duty> {
  const duty = normalizeDuty(raw);
  if (typeof duty === "string") throw new Error(duty);
  await writeJsonAtomic(join(paths.duties, `${duty.id}.json`), duty);
  return duty;
}

/** 임무를 휴지통으로 옮긴다 (되살릴 수 있다). 이미 쌓인 제안과 실행 기록은 그대로 둔다 */
export async function deleteDuty(paths: MatePaths, id: string): Promise<void> {
  if (!isDutyId(id)) throw new Error("잘못된 임무 id입니다");
  const duty = await getDuty(paths, id);
  await moveToTrash(paths, { kind: "duty", title: duty?.name ?? id, detail: duty?.cwd ?? "" }, [{ path: join(paths.duties, `${id}.json`) }]);
}

// ── 실행 요청 ("지금 실행") ──

export async function addRequest(paths: MatePaths, dutyId: string, now = Date.now()): Promise<void> {
  if (!isDutyId(dutyId)) throw new Error("잘못된 임무 id입니다");
  const request: RunRequest = { dutyId, requestedAt: now };
  await writeJsonAtomic(join(paths.requests, `${now}-${dutyId}.json`), request);
}

/** 쌓인 요청을 오래된 순으로 꺼내고 파일은 지운다 */
export async function takeRequests(paths: MatePaths): Promise<RunRequest[]> {
  let names: string[];
  try {
    names = (await readdir(paths.requests)).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const requests: RunRequest[] = [];
  for (const name of names) {
    const path = join(paths.requests, name);
    const request = await readJson<RunRequest | undefined>(path, undefined);
    await rm(path, { force: true });
    if (request && isDutyId(request.dutyId)) requests.push(request);
  }
  return requests;
}

export async function pendingRequests(paths: MatePaths): Promise<RunRequest[]> {
  try {
    const names = (await readdir(paths.requests)).filter((n) => n.endsWith(".json")).sort();
    const all = await Promise.all(names.map((n) => readJson<RunRequest | undefined>(join(paths.requests, n), undefined)));
    return all.filter((r): r is RunRequest => !!r);
  } catch {
    return [];
  }
}

// ── 실행기 상태·실행 기록 ──

export async function loadState(paths: MatePaths): Promise<RunnerState> {
  const raw = await readJson<Partial<RunnerState>>(paths.state, {});
  return {
    ...raw,
    duties: raw.duties && typeof raw.duties === "object" ? raw.duties : {},
    today: raw.today && typeof raw.today.date === "string" ? raw.today : { date: "", count: 0 },
  };
}

export async function saveState(paths: MatePaths, state: RunnerState): Promise<void> {
  await writeJsonAtomic(paths.state, state);
}

export async function writeRun(paths: MatePaths, run: RunRecord): Promise<void> {
  await writeJsonAtomic(join(paths.runs, `${run.id}.json`), run);
}

/** 최근 실행 기록 (새것부터). runId가 시각으로 시작하므로 이름순 = 시간순 */
export async function listRuns(paths: MatePaths, limit = 100): Promise<RunRecord[]> {
  let names: string[];
  try {
    names = (await readdir(paths.runs)).filter((n) => n.endsWith(".json")).sort().reverse().slice(0, limit);
  } catch {
    return [];
  }
  const runs = await Promise.all(names.map((n) => readJson<RunRecord | undefined>(join(paths.runs, n), undefined)));
  return runs.filter((r): r is RunRecord => !!r);
}

/** 스킬 폴더를 휴지통으로 옮긴다 (Mate의 스킬 탭) */
export async function deleteSkill(paths: MatePaths, name: string): Promise<void> {
  if (!isSkillName(name)) throw new Error(`스킬 이름이 올바르지 않습니다: ${name}`);
  await moveToTrash(paths, { kind: "skill", title: name }, [{ path: join(paths.skills, name) }]);
}

/** 실행 기록 하나와 그 Pi 세션 파일 (Mate 홈 sessions/ 안에 있을 때만) */
async function runFiles(paths: MatePaths, name: string): Promise<{ files: Array<{ path: string }>; run?: RunRecord }> {
  const path = join(paths.runs, name);
  const run = await readJson<RunRecord | undefined>(path, undefined);
  const files = [{ path }];
  if (run?.sessionFile && dirname(run.sessionFile) === paths.sessions) files.push({ path: run.sessionFile });
  return run ? { files, run } : { files };
}

/** 실행 기록 하나를 휴지통으로 옮긴다 (세션 파일도 함께) */
export async function deleteRun(paths: MatePaths, id: string): Promise<void> {
  if (!/^[0-9A-Za-z-]+$/.test(id)) throw new Error("잘못된 실행 id입니다");
  const { files, run } = await runFiles(paths, `${id}.json`);
  await moveToTrash(paths, { kind: "run", title: run ? `${run.dutyName} 실행` : `실행 ${id}`, ...(run ? { detail: new Date(run.startedAt).toLocaleString() } : {}) }, files);
}

/** 실행 기록이 keep개를 넘으면 오래된 것부터 한 항목으로 묶어 휴지통으로 옮긴다 (DESIGN-APPS.md §6 D2) */
export async function pruneRuns(paths: MatePaths, keep = 200, now = Date.now()): Promise<void> {
  let names: string[];
  try {
    names = (await readdir(paths.runs)).filter((n) => n.endsWith(".json")).sort();
  } catch {
    // 폴더가 없으면 지울 것도 없다
    return;
  }
  const old = names.slice(0, Math.max(0, names.length - keep));
  if (old.length === 0) return;
  const collected = await Promise.all(old.map((n) => runFiles(paths, n)));
  const starts = collected.flatMap((c) => (c.run ? [c.run.startedAt] : []));
  const range = starts.length > 0 ? `${new Date(Math.min(...starts)).toLocaleDateString()} ~ ${new Date(Math.max(...starts)).toLocaleDateString()}` : "";
  await moveToTrash(paths, { kind: "run", title: `오래된 실행 기록 ${old.length}개 정리`, detail: range }, collected.flatMap((c) => c.files), now);
}

/**
 * 대화 기록을 휴지통으로 옮긴다: 대화 줄(chat.jsonl)과 대화의 Pi 세션들. 다음 말부터 새 대화가 된다.
 * 되살리면 그사이 나눈 대화와 시각 순으로 합친다.
 */
export async function clearChat(paths: MatePaths, now = Date.now()): Promise<boolean> {
  const sessions = await readdir(paths.chatSessions).catch(() => [] as string[]);
  const item = await moveToTrash(
    paths,
    { kind: "chat", title: "대화 기록", detail: new Date(now).toLocaleString() },
    [{ path: paths.chat, merge: true }, ...sessions.filter((n) => n.endsWith(".jsonl")).map((n) => ({ path: join(paths.chatSessions, n) }))],
    now,
  );
  return item !== undefined;
}

/** 시각 순으로 정렬되는 실행 id */
export function newRunId(now = Date.now()): string {
  return `${new Date(now).toISOString().replace(/[-:.]/g, "").replace("T", "-").slice(0, 15)}-${randomUUID().slice(0, 6)}`;
}

// ── 인박스 상태 ──

export async function loadInboxState(paths: MatePaths): Promise<InboxState> {
  return readJson<InboxState>(paths.inboxState, {});
}

export async function setInboxStatus(paths: MatePaths, ids: string[], status: InboxStatus | undefined, now = Date.now()): Promise<InboxState> {
  const state = await loadInboxState(paths);
  for (const id of ids) {
    if (status) state[id] = { status, at: now };
    else delete state[id];
  }
  await writeJsonAtomic(paths.inboxState, state);
  return state;
}

/** Pi가 --session-dir에 만든 세션 파일(`<시각>_<id>.jsonl`)을 찾는다 */
export async function findSessionFile(paths: MatePaths, sessionId: string): Promise<string | undefined> {
  try {
    const name = (await readdir(paths.sessions)).find((n) => n.endsWith(`_${sessionId}.jsonl`));
    return name ? join(paths.sessions, name) : undefined;
  } catch {
    return undefined;
  }
}
