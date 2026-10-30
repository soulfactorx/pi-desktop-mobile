import { mkdir, mkdtemp, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readInbox } from "@pi-desktop/mate-kit";
import { applySessionLine, failureKey, isObserved, isTestCommand, projectCandidates, redact, sessionCandidates } from "../src/activity";
import type { SessionAggregate } from "../src/activity-types";
import { markSessionEnds } from "../src/daemon";
import { Observer, readActivity } from "../src/observer";
import { matePaths, type MatePaths } from "../src/paths";
import { DEFAULT_CONFIG, type Duty, type MateConfig, type RunnerState } from "../src/types";
import type { Exec } from "../src/watchers";

const H = 3_600_000;
const line = (o: unknown) => JSON.stringify(o);
const ts = (ms: number) => new Date(ms).toISOString();

function sessionLines(cwd: string, at: number, opts: { edit?: boolean; test?: boolean; fail?: string; modelError?: string } = {}): string[] {
  const out = [
    line({ type: "session", version: 3, id: "s1", timestamp: ts(at), cwd }),
    line({ type: "message", timestamp: ts(at), message: { role: "user", content: [{ type: "text", text: "로그인 버그 고쳐줘 token=abc123secretvalue" }] } }),
  ];
  const calls = [];
  if (opts.edit) calls.push({ type: "toolCall", id: "c1", name: "edit", arguments: { path: "src/auth.ts" } });
  if (opts.test) calls.push({ type: "toolCall", id: "c2", name: "bash", arguments: { command: "chcp.com 65001 > /dev/null 2>&1\nnpm test" } });
  if (opts.fail) calls.push({ type: "toolCall", id: "c3", name: "bash", arguments: { command: opts.fail } });
  out.push(line({ type: "message", timestamp: ts(at + 1000), message: { role: "assistant", content: calls, stopReason: "toolUse" } }));
  if (opts.fail) {
    out.push(line({ type: "message", timestamp: ts(at + 2000), message: { role: "toolResult", toolCallId: "c3", toolName: "bash", isError: true, content: [{ type: "text", text: "error TS2304: Cannot find name 'x'\nmore" }] } }));
  }
  if (opts.modelError) {
    out.push(line({ type: "message", timestamp: ts(at + 3000), message: { role: "assistant", content: [], stopReason: "error", errorMessage: opts.modelError } }));
  }
  return out;
}

function aggregateOf(lines: string[]): SessionAggregate {
  const calls = new Map<string, string>();
  let agg: SessionAggregate | undefined;
  for (const l of lines) agg = applySessionLine(agg, l, calls);
  return agg!;
}

describe("세션 요약", () => {
  it("요청·고친 파일·테스트·실패·모델 오류를 모으고 비밀값은 가린다", () => {
    const agg = aggregateOf(sessionLines("/repo", 0, { edit: true, test: true, fail: "npm run build", modelError: "Connection error." }));
    expect(agg).toMatchObject({ sessionId: "s1", cwd: "/repo", prompts: 1, editedFiles: ["src/auth.ts"], commands: 2, ranTests: true });
    expect(agg.firstPrompt).toBe("로그인 버그 고쳐줘 token=[가림]");
    expect(agg.failures).toEqual(["npm run build → error TS2304: Cannot find name 'x'"]);
    expect(agg.modelErrors).toEqual(["Connection error."]);
  });

  it("자동 재시도로 이어진 같은 모델 오류는 한 번만 남긴다", () => {
    const lines = sessionLines("/repo", 0, { modelError: "529 overloaded" });
    const again = lines.at(-1)!;
    expect(aggregateOf([...lines, again, again]).modelErrors).toEqual(["529 overloaded"]);
  });

  it("비밀값 패턴과 테스트 명령을 알아본다", () => {
    expect(redact("key sk-ant-abcdefghijklmnop and ghp_abcdefghijklmnopqrst Bearer abcdefghijklmnop")).toBe("key [가림] and [가림] Bearer [가림]");
    expect(isTestCommand("npx vitest run src")).toBe(true);
    expect(isTestCommand("pnpm test")).toBe(true);
    expect(isTestCommand("git status")).toBe(false);
    expect(failureKey("npm run build → C:\\a\\b.ts(12,3) error")).toBe(failureKey("npm run build → C:\\c\\d.ts(99,1) error"));
  });
});

describe("규칙 후보", () => {
  it("고치고 테스트를 안 돌리면 관찰자에게, 연결 오류는 바로 알린다", () => {
    const ended = aggregateOf(sessionLines("/repo", 0, { edit: true, modelError: "fetch failed: ECONNRESET" }));
    const c = sessionCandidates(ended, [], 0);
    expect(c.map((x) => [x.topic, x.via])).toEqual([
      ["untested-edit", "observer"],
      ["session-error", "rule"],
    ]);
    expect(c[1]!.detail).toMatch(/VPN/);
    expect(c[0]!.followUp).toMatch(/src\/auth.ts/);
    // 테스트를 돌렸으면 알리지 않는다
    expect(sessionCandidates(aggregateOf(sessionLines("/repo", 0, { edit: true, test: true })), [], 0)).toEqual([]);
  });

  it("같은 실패가 하루에 세 번 이상이면 (세션을 넘어)", () => {
    const fail = (id: string) => ({ ...aggregateOf(sessionLines("/repo", 0, { fail: "npm run build" })), sessionId: id });
    expect(sessionCandidates(fail("b"), [fail("a")], H).filter((c) => c.topic === "repeated-failure")).toEqual([]);
    const found = sessionCandidates(fail("c"), [fail("a"), fail("b")], H).find((c) => c.topic === "repeated-failure");
    expect(found).toMatchObject({ title: "같은 실패가 오늘 3번 났습니다", via: "observer" });
  });

  it("push 안 한 커밋은 하루, 커밋 안 한 변경은 이틀이 지나야", () => {
    const p = { cwd: "/w/app", branch: "feat/x", ahead: 2, dirty: 5, aheadSince: 0, dirtySince: 0, checkedAt: 0 };
    expect(projectCandidates(p, 23 * H)).toEqual([]);
    expect(projectCandidates(p, 25 * H).map((c) => c.topic)).toEqual(["unpushed"]);
    expect(projectCandidates(p, 49 * H).map((c) => c.title)).toEqual([
      "app: feat/x에 push하지 않은 커밋 2개 (2일째)",
      "app: 커밋하지 않은 변경 5개가 2일째 그대로입니다",
    ]);
  });

  it("제외한 폴더 안은 보지 않는다", () => {
    expect(isObserved(join("C:", "work", "secret", "x"), [join("C:", "work", "secret")])).toBe(false);
    expect(isObserved(join("C:", "work", "app"), [join("C:", "work", "secret")])).toBe(true);
    expect(isObserved("", [])).toBe(false);
  });
});

describe("Observer", () => {
  let base: string;
  let sessions: string;
  let paths: MatePaths;
  const noGit: Exec = async () => ({ code: 1, stdout: "" });
  const config = (patch: Partial<MateConfig["observe"]> = {}): MateConfig => ({
    ...DEFAULT_CONFIG,
    observe: { ...DEFAULT_CONFIG.observe, enabled: true, quietMinutes: 5, ...patch },
  });

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "mate-observe-"));
    sessions = join(base, "pi-sessions", "--repo--");
    paths = matePaths(join(base, "home"));
    await mkdir(sessions, { recursive: true });
    await mkdir(paths.home, { recursive: true });
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });
  /** 사용자 홈의 세션을 보지 않도록 Pi·Agent 세션 폴더를 모두 임시 폴더로 */
  const sessionEnv = () => ({ PI_CODING_AGENT_SESSION_DIR: join(base, "pi-sessions"), PI_DESKTOP_AGENT_HOME: join(base, "agent-home") });

  it("세션이 조용해지면 끝난 것으로 기록하고, 규칙 후보는 인박스에, 분석 후보는 쉬는 때 관찰자에게", async () => {
    const observer = new Observer(paths, noGit, sessionEnv());
    const state: RunnerState = { duties: {}, today: { date: "", count: 0 } };
    const now = Date.now();
    const file = join(sessions, "2026_s1.jsonl");
    await writeFile(file, `${sessionLines("/repo", now, { edit: true, modelError: "Connection error." }).join("\n")}\n`);

    // 아직 진행 중: 끝나지 않음, 관찰자도 기다림
    expect((await observer.tick(state, config(), now + 60_000)).ended).toEqual([]);
    expect(observer.nextJob(state, config(), now + 60_000)).toBeUndefined();

    // 5분 넘게 조용함: 끝남
    const later = now + 6 * 60_000;
    const { ended } = await observer.tick(state, config(), later);
    expect(ended.map((s) => s.editedFiles)).toEqual([["src/auth.ts"]]);
    const inbox = await readInbox(paths.inbox);
    expect(inbox.map((i) => [i.topic, i.dutyId])).toEqual([["session-error", "observer"]]);
    expect((await readActivity(paths)).map((r) => r.kind)).toEqual(["session-ended", "suggested"]);
    const job = observer.nextJob(state, config(), later);
    expect(job).toMatchObject({ topic: "untested-edit", cwd: "/repo" });
    expect(observer.nextJob(state, config(), later)).toBeUndefined();

    // 다시 확인해도 같은 세션을 두 번 끝내지 않는다
    expect((await observer.tick(state, config(), later + 60_000)).ended).toEqual([]);

    // 같은 세션을 이어 쓰면 새 작업으로 센다
    await appendFile(file, `${line({ type: "message", timestamp: ts(later + 120_000), message: { role: "user", content: "하나 더" } })}\n`);
    expect((await observer.tick(state, config(), later + 130_000)).ended).toEqual([]);
    expect((await observer.tick(state, config(), later + 130_000 + 6 * 60_000)).ended.map((s) => s.firstPrompt)).toEqual(["하나 더"]);
  });

  it("Agent의 세션도 읽기만 하고, Agent 앱 홈 안에서 연 세션(스케줄러)은 빼고 본다", async () => {
    const observer = new Observer(paths, noGit, sessionEnv());
    const agentHome = join(base, "agent-home");
    const agentSessions = join(agentHome, "sessions", "--work--");
    await mkdir(agentSessions, { recursive: true });
    const state: RunnerState = { duties: {}, today: { date: "", count: 0 } };
    const now = Date.now();
    const work = `${sessionLines("/work", now, { edit: true }).join("\n")}\n`;
    await writeFile(join(agentSessions, "a.jsonl"), work);
    const scheduler = `${sessionLines(join(agentHome, "scheduler"), now, { edit: true }).join("\n")}\n`;
    await writeFile(join(agentSessions, "scheduler.jsonl"), scheduler);
    await observer.tick(state, config(), now + 60_000);
    const { ended } = await observer.tick(state, config(), now + 6 * 60_000);
    expect(ended.map((s) => s.cwd)).toEqual(["/work"]);
    // 읽기만 한다
    expect(await readFile(join(agentSessions, "a.jsonl"), "utf8")).toBe(work);
  });

  it("관찰을 켜기 전에 이미 조용해진 세션은 읽지 않는다", async () => {
    const observer = new Observer(paths, noGit, sessionEnv());
    await writeFile(join(sessions, "old.jsonl"), `${sessionLines("/repo", Date.now() - 2 * H, { edit: true }).join("\n")}\n`);
    const state: RunnerState = { duties: {}, today: { date: "", count: 0 } };
    const now = Date.now() + 10 * 60_000;
    expect((await observer.tick(state, config(), now)).ended).toEqual([]);
    expect((await observer.tick(state, config(), now + 60_000)).ended).toEqual([]);
  });

  it("작업을 마치면 계기: 그 폴더(또는 상위)의 임무에 변화로 남는다", () => {
    const duty = (id: string, cwd: string): Duty => ({
      id, name: id, enabled: true, cwd, prompt: "p", profile: "propose", trigger: { kind: "session" }, createdAt: 0,
    });
    const state: RunnerState = { duties: { a: { watch: { key: "k" } }, b: { watch: { key: "k" } } }, today: { date: "", count: 0 } };
    const ended = { ...aggregateOf(sessionLines(join(base, "repo", "pkg"), 0, { edit: true })) };
    markSessionEnds([duty("a", join(base, "repo")), duty("b", join(base, "other"))], state, [ended], 5);
    expect(state.duties.a?.watch?.pending?.cause).toBe('Pi 세션이 끝남: "로그인 버그 고쳐줘 token=[가림]" (파일 1개 고침)');
    expect(state.duties.b?.watch?.pending).toBeUndefined();
  });
});

describe("저장소 상태와 기억", () => {
  it("커밋하지 않은 변경이 처음 보인 시각을 이어 간다 (실제 git)", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { execCommand } = await import("../src/watchers");
    const { readProject } = await import("../src/activity");
    const run = promisify(execFile);
    const repo = await mkdtemp(join(tmpdir(), "mate-proj-"));
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    try {
      await run("git", ["init", "-q", "-b", "main"], { cwd: repo });
      await run("git", ["commit", "-q", "--allow-empty", "-m", "a"], { cwd: repo, env });
      await writeFile(join(repo, "x.txt"), "x");
      const first = await readProject(execCommand, repo, undefined, 100);
      expect(first).toMatchObject({ branch: "main", dirty: 1, dirtySince: 100 });
      expect(first?.ahead).toBeUndefined();
      expect(await readProject(execCommand, repo, first, 200)).toMatchObject({ dirty: 1, dirtySince: 100, checkedAt: 200 });
      expect(await readProject(execCommand, join(base0(), "nope"), undefined, 1)).toBeUndefined();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("주제를 세 번 넘게 버리고 받아들인 적이 없으면 쉰다", async () => {
    const { isTopicMuted } = await import("../src/observer");
    expect(isTopicMuted({ accepted: 0, dismissed: 3 })).toBe(true);
    expect(isTopicMuted({ accepted: 1, dismissed: 5 })).toBe(false);
    expect(isTopicMuted(undefined)).toBe(false);
  });
});

function base0(): string {
  return tmpdir();
}
