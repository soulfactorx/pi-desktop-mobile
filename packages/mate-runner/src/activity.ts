import { createHash } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { Candidate, ProjectSnapshot, SessionAggregate } from "./activity-types";
import type { Exec } from "./watchers";

/**
 * 활동 관찰: 사용자의 Pi 세션 기록과 저장소 상태에서 도울 거리를 찾는다 (설계 DESIGN-MATE.md §10).
 * 이 파일의 해석·규칙 함수는 순수 함수다. 파일·git 읽기는 아래 IO 함수가 한다.
 */

const TEXT_LIMIT = 160;
const MAX_FILES = 30;
const MAX_FAILURES = 10;

/** 비밀값처럼 보이는 것을 가린다 (API 키·토큰·비밀번호 인자) */
export function redact(text: string): string {
  return text
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, "[가림]")
    .replace(/\b(ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{12,}/g, "[가림]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[가림]")
    .replace(/\b(xox[abp]-[A-Za-z0-9-]{10,})/g, "[가림]")
    .replace(/((?:password|passwd|pwd|token|secret|api[_-]?key)\s*[=:]\s*)\S+/gi, "$1[가림]")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{12,}/gi, "$1[가림]");
}

function short(text: string): string {
  const one = redact(text.replace(/\s+/g, " ").trim());
  return one.length > TEXT_LIMIT ? `${one.slice(0, TEXT_LIMIT)}…` : one;
}

/** 테스트를 돌리는 명령으로 보이는지 */
export function isTestCommand(command: string): boolean {
  return /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\b(vitest|jest|mocha|pytest|phpunit|rspec)\b|\b(cargo|go|dotnet|mvn|gradle)\s+test\b|\bnpx\s+(vitest|jest)\b/.test(command);
}

/** Windows UTF-8 처리 등 앞에 붙은 줄을 떼고 실제 명령만 */
function lastCommandLine(command: string): string {
  return command.split("\n").filter((l) => l.trim() && !/^chcp(\.com)?\s+65001/.test(l.trim())).join(" ; ");
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((c) => c && typeof c === "object" && (c as { type?: string }).type === "text").map((c) => String((c as { text?: unknown }).text ?? "")).join("");
}

/**
 * 세션 JSONL 줄 하나를 요약에 더한다 (Pi docs/session-format.md). 모르는 줄은 무시한다.
 * 요약이 아직 없으면 세션 머리(type: session)에서 만든다.
 */
export function applySessionLine(aggregate: SessionAggregate | undefined, line: string, toolCalls: Map<string, string>): SessionAggregate | undefined {
  let entry: Record<string, any>;
  try {
    entry = JSON.parse(line) as Record<string, any>;
  } catch {
    return aggregate;
  }
  const at = Date.parse(entry.timestamp ?? "") || Date.now();
  if (entry.type === "session") {
    return {
      sessionId: String(entry.id ?? ""),
      cwd: String(entry.cwd ?? ""),
      startedAt: at,
      lastAt: at,
      prompts: 0,
      editedFiles: [],
      commands: 0,
      ranTests: false,
      failures: [],
      modelErrors: [],
    };
  }
  if (!aggregate || entry.type !== "message") return aggregate;
  const message = entry.message as Record<string, any> | undefined;
  const next: SessionAggregate = { ...aggregate, lastAt: Math.max(aggregate.lastAt, at) };
  switch (message?.role) {
    case "user": {
      const text = textOf(message.content).trim();
      if (!text) break;
      next.prompts += 1;
      next.firstPrompt ??= short(text);
      break;
    }
    case "assistant":
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part?.type !== "toolCall") continue;
        const args = (part.arguments ?? {}) as Record<string, unknown>;
        if ((part.name === "write" || part.name === "edit") && typeof args.path === "string") {
          const file = args.path.replace(/^@/, "").replace(/\\/g, "/");
          if (!next.editedFiles.includes(file) && next.editedFiles.length < MAX_FILES) next.editedFiles = [...next.editedFiles, file];
        } else if (part.name === "bash" && typeof args.command === "string") {
          const command = lastCommandLine(args.command);
          next.commands += 1;
          if (isTestCommand(command)) next.ranTests = true;
          if (typeof part.id === "string") toolCalls.set(part.id, command);
        }
      }
      if (message.stopReason === "error" && message.errorMessage) {
        // 자동 재시도로 같은 오류가 이어지면 한 번만 남긴다
        const error = short(String(message.errorMessage));
        if (next.modelErrors.at(-1) !== error) next.modelErrors = [...next.modelErrors, error].slice(-5);
      }
      break;
    case "toolResult": {
      if (message.toolName !== "bash" || message.isError !== true) break;
      const command = toolCalls.get(String(message.toolCallId)) ?? "";
      const firstError = textOf(message.content).split("\n").find((l) => l.trim()) ?? "";
      const failure = short(`${command} → ${firstError}`);
      if (next.failures.length < MAX_FAILURES) next.failures = [...next.failures, failure];
      break;
    }
  }
  return next;
}

/** 같은 실패로 볼지 정할 때 쓰는 열쇠: 숫자·경로 차이는 무시한다 */
export function failureKey(failure: string): string {
  return failure
    .toLowerCase()
    .replace(/[a-z]:[\\/][^\s]*/gi, "<path>")
    .replace(/\/[^\s]+/g, "<path>")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

function hashKey(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 12);
}

const HOUR = 3_600_000;

/**
 * 끝난 세션과 최근 기록에서 후보를 찾는다 (규칙). 같은 열쇠는 한 번만.
 * - untested-edit: 파일을 고쳤는데 테스트 명령을 안 돌린 세션 → 관찰자가 살펴보고 제안
 * - repeated-failure: 같은 실패가 하루에 세 번 이상(세션을 넘어) → 관찰자가 원인 정리
 * - session-error: 모델 오류로 끝난 세션 (연결 오류 등) → 바로 알림
 */
export function sessionCandidates(ended: SessionAggregate, recent: SessionAggregate[], now: number): Candidate[] {
  const out: Candidate[] = [];
  const where = ended.cwd;
  if (ended.editedFiles.length > 0 && !ended.ranTests) {
    out.push({
      topic: "untested-edit",
      key: hashKey("untested", ended.sessionId),
      cwd: where,
      title: `고친 뒤 테스트를 돌리지 않았습니다 (파일 ${ended.editedFiles.length}개)`,
      detail: `세션 "${ended.firstPrompt ?? "(요청 없음)"}"에서 ${ended.editedFiles.slice(0, 8).join(", ")}을(를) 고쳤지만 테스트 명령을 실행하지 않았습니다.`,
      via: "observer",
      followUp: `방금 고친 파일(${ended.editedFiles.slice(0, 8).join(", ")})과 관련된 테스트를 찾아, 빠진 테스트가 있으면 추가하라.`,
    });
  }
  if (ended.modelErrors.length > 0) {
    const error = ended.modelErrors.at(-1)!;
    const network = /connection|network|timeout|ECONN|ETIMEDOUT|ENOTFOUND|fetch failed|socket/i.test(error);
    out.push({
      topic: "session-error",
      key: hashKey("session-error", ended.sessionId),
      cwd: where,
      title: network ? "Pi 세션이 연결 오류로 끝났습니다" : "Pi 세션이 모델 오류로 끝났습니다",
      detail: network
        ? `마지막 오류: ${error}\nVPN·프록시·방화벽이 모델 API를 막고 있지 않은지 확인하세요. 회사 VPN이 외부 API를 막는 경우가 많습니다.`
        : `마지막 오류: ${error}\n모델·프로바이더 설정이나 사용 한도를 확인하세요.`,
      via: "rule",
    });
  }
  // 하루 동안의 실패를 세션을 넘어 센다
  const since = now - 24 * HOUR;
  const counts = new Map<string, { count: number; sample: string }>();
  for (const s of [...recent.filter((r) => r.sessionId !== ended.sessionId && r.lastAt >= since && r.cwd === ended.cwd), ended]) {
    for (const f of s.failures) {
      const k = failureKey(f);
      const c = counts.get(k) ?? { count: 0, sample: f };
      c.count += 1;
      counts.set(k, c);
    }
  }
  for (const [k, c] of counts) {
    if (c.count < 3 || !ended.failures.some((f) => failureKey(f) === k)) continue;
    out.push({
      topic: "repeated-failure",
      key: hashKey("repeat", where, k),
      cwd: where,
      title: `같은 실패가 오늘 ${c.count}번 났습니다`,
      detail: c.sample,
      via: "observer",
      followUp: `다음 명령이 반복해서 실패한다: ${c.sample}\n원인을 찾아 고쳐라.`,
    });
  }
  return out;
}

/**
 * 저장소 상태에서 후보를 찾는다.
 * - unpushed: upstream보다 앞선 커밋이 하루 넘게 그대로
 * - uncommitted: 커밋하지 않은 변경이 이틀 넘게 그대로
 */
export function projectCandidates(p: ProjectSnapshot, now: number): Candidate[] {
  const out: Candidate[] = [];
  const name = p.cwd.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? p.cwd;
  if (p.ahead && p.ahead > 0 && p.aheadSince !== undefined && now - p.aheadSince >= 24 * HOUR) {
    const days = Math.floor((now - p.aheadSince) / (24 * HOUR));
    out.push({
      topic: "unpushed",
      key: hashKey("unpushed", p.cwd, p.branch, String(p.aheadSince)),
      cwd: p.cwd,
      title: `${name}: ${p.branch}에 push하지 않은 커밋 ${p.ahead}개 (${days}일째)`,
      detail: `${p.cwd}의 ${p.branch} 브랜치에 원격보다 앞선 커밋이 ${p.ahead}개 있습니다. 백업과 리뷰를 위해 push하거나 PR을 여는 것을 고려하세요.`,
      via: "rule",
    });
  }
  if (p.dirty > 0 && p.dirtySince !== undefined && now - p.dirtySince >= 48 * HOUR) {
    const days = Math.floor((now - p.dirtySince) / (24 * HOUR));
    out.push({
      topic: "uncommitted",
      key: hashKey("uncommitted", p.cwd, String(p.dirtySince)),
      cwd: p.cwd,
      title: `${name}: 커밋하지 않은 변경 ${p.dirty}개가 ${days}일째 그대로입니다`,
      detail: `${p.cwd}에 커밋하지 않은 파일이 ${p.dirty}개 있습니다. 잃어버리지 않게 커밋하거나 정리하는 것을 고려하세요.`,
      via: "rule",
    });
  }
  return out;
}

/** 관찰 대상인지: 제외 폴더 안이면 보지 않는다 */
export function isObserved(cwd: string, excluded: string[]): boolean {
  if (!cwd) return false;
  return !excluded.some((ex) => {
    const rel = relative(resolve(ex), resolve(cwd));
    return rel === "" || (!rel.startsWith("..") && !/^[a-zA-Z]:/.test(rel));
  });
}

// ── IO ──

/** 사용자의 Pi 세션 폴더 (Pi Desktop·TUI가 쓰는 곳) */
export function piSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_CODING_AGENT_SESSION_DIR || join(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "sessions");
}

/** Agent의 앱 홈 (agent-kit home.ts와 같은 규칙) */
export function agentHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_DESKTOP_AGENT_HOME || join(homedir(), ".pi-desktop-agent");
}

/**
 * 관찰하는 세션 폴더 (설계 DESIGN-APPS.md §3.3): Pi Desktop·터미널 pi와 Agent. 읽기만 한다.
 * Agent의 예약을 돌리는 스케줄러 세션처럼 앱 홈 안에서 연 세션은 사람의 작업이 아니므로 관찰에서 뺄 폴더로 돌려준다.
 */
export function observedSessions(env: NodeJS.ProcessEnv = process.env): { dirs: string[]; internal: string[] } {
  const agentHome = agentHomeDir(env);
  return { dirs: [piSessionsDir(env), join(agentHome, "sessions")], internal: [agentHome] };
}

/** 최근 바뀐 세션 파일 (sessions/<폴더>/<파일>.jsonl 또는 sessions/<파일>.jsonl) */
export async function recentSessionFiles(dir: string, since: number): Promise<Array<{ path: string; mtime: number; size: number }>> {
  const out: Array<{ path: string; mtime: number; size: number }> = [];
  const visit = async (d: string, depth: number) => {
    let names: string[];
    try {
      names = await readdir(d);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(d, name);
      const info = await stat(path).catch(() => undefined);
      if (!info) continue;
      if (info.isDirectory() && depth < 1) await visit(path, depth + 1);
      else if (info.isFile() && name.endsWith(".jsonl") && info.mtimeMs >= since) out.push({ path, mtime: info.mtimeMs, size: info.size });
    }
  };
  await visit(dir, 0);
  return out;
}

/** 파일의 offset 뒤에 붙은 완성된 줄들을 읽는다 (마지막 줄이 쓰는 중이면 다음에) */
export async function readNewLines(path: string, offset: number, size: number): Promise<{ lines: string[]; offset: number }> {
  if (size <= offset) return { lines: [], offset: size < offset ? 0 : offset };
  const handle = await open(path, "r");
  try {
    const length = Math.min(size - offset, 8 * 1024 * 1024);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, offset);
    const end = buffer.lastIndexOf(0x0a);
    if (end < 0) return { lines: [], offset };
    const text = buffer.subarray(0, end + 1).toString("utf8");
    return { lines: text.split("\n").filter((l) => l.trim()), offset: offset + end + 1 };
  } finally {
    await handle.close();
  }
}

/** 저장소 상태를 읽는다. git 저장소가 아니면 undefined */
export async function readProject(exec: Exec, cwd: string, previous: ProjectSnapshot | undefined, now: number): Promise<ProjectSnapshot | undefined> {
  const status = await exec("git", ["status", "--porcelain=v1", "--branch"], cwd);
  if (status.code !== 0) return undefined;
  const lines = status.stdout.split(/\r?\n/).filter(Boolean);
  const head = lines[0] ?? "";
  const branch = /^## (?:No commits yet on )?([^.\s]+)/.exec(head)?.[1] ?? "?";
  const hasUpstream = head.includes("...");
  const ahead = hasUpstream ? Number(/ahead (\d+)/.exec(head)?.[1] ?? 0) : undefined;
  const dirty = lines.length - 1;
  return {
    cwd,
    branch,
    ...(ahead !== undefined ? { ahead } : {}),
    dirty,
    // 앞선 커밋·변경이 처음 보인 시각을 이어 간다. 사라지면 지운다
    ...(ahead ? { aheadSince: previous?.ahead && previous.branch === branch ? (previous.aheadSince ?? now) : now } : {}),
    ...(dirty > 0 ? { dirtySince: previous?.dirty ? (previous.dirtySince ?? now) : now } : {}),
    checkedAt: now,
  };
}
