import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readChat, readInbox } from "@pi-desktop/mate-kit";
import { PI_CLI, setupRealPi, type RealPiFixture } from "../../host-agent/test/helpers/real-pi";
import { isAlive, readPid } from "../src/daemon";
import { matePaths, type MatePaths } from "../src/paths";
import { applyInboxChange } from "../src/inbox-change";
import { addRequest, listRuns, loadInboxState, loadState, saveConfig, saveDuty } from "../src/store";
import type { Duty, RunRecord } from "../src/types";

/**
 * 빌드된 실행기(dist/mate-runner.mjs)로 실제 Pi를 mock LLM과 함께 돌리는 계약 테스트.
 * 권한 단계가 실제 Pi에서 지켜지는지, 제안이 인박스에 쌓이는지 확인한다.
 */
const execFileAsync = promisify(execFile);
const RUNNER = fileURLToPath(new URL("../dist/mate-runner.mjs", import.meta.url));

describe("실행기 + 실제 Pi", () => {
  let fixture: RealPiFixture;
  let paths: MatePaths;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    fixture = await setupRealPi();
    paths = matePaths(await mkdtemp(join(tmpdir(), "mate-home-")));
    await saveConfig(paths, { model: "mock/mock-model" });
    // 상주 실행기의 주기 확인을 줄여 변화 계기를 빨리 본다
    env = { ...process.env, ...fixture.piEnv, MATE_HOME: paths.home, PI_DESKTOP_PI_CLI: PI_CLI, PI_DESKTOP_MATE_TICK_MS: "300" };
  });

  afterAll(async () => {
    await execFileAsync(process.execPath, [RUNNER, "stop"], { env }).catch(() => {});
    await fixture?.llm.close();
    if (paths) await rm(paths.home, { recursive: true, force: true }).catch(() => {});
  });

  async function addDuty(id: string, profile: Duty["profile"], prompt: string): Promise<void> {
    await saveDuty(paths, { id, name: `임무 ${id}`, cwd: fixture.projectDir, prompt, profile, trigger: { kind: "manual" } });
  }

  async function run(id: string): Promise<RunRecord> {
    const { stdout } = await execFileAsync(process.execPath, [RUNNER, "run", id], { env, timeout: 60_000 });
    return JSON.parse(stdout) as RunRecord;
  }

  it("propose: mate_propose가 인박스에 쌓이고, 같은 제안은 다시 쌓이지 않는다", async () => {
    await addDuty("ci", "propose", 'tool:mate_propose {"title":"CI 실패","summary":"unit 테스트가 깨졌습니다","severity":"warn"}');
    const first = await run("ci");
    expect(first).toMatchObject({ status: "done", proposals: 1, model: "mock/mock-model" });
    expect(first.sessionId).toBeTruthy();
    expect(await run("ci")).toMatchObject({ status: "done", proposals: 0 });
    const inbox = await readInbox(paths.inbox);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ dutyId: "ci", runId: first.id, title: "CI 실패", severity: "warn" });
    // 실행 세션은 Mate 홈에 남는다 (Pi 세션 목록을 채우지 않음)
    expect(existsSync(paths.sessions)).toBe(true);
  });

  it("observe: 마지막 답변을 결과로 인박스에 남긴다", async () => {
    await addDuty("brief", "observe", "오늘 요약");
    expect(await run("brief")).toMatchObject({ status: "done", summary: "echo: 오늘 요약", proposals: 1 });
    expect((await readInbox(paths.inbox)).find((i) => i.dutyId === "brief")).toMatchObject({ title: "임무 brief 결과", summary: "echo: 오늘 요약" });
  });

  it("허용 목록에 없는 명령은 허용을 묻고, 임무에 허용하면 다시 묻지 않는다 (지우기 명령은 묻지 않음)", async () => {
    const questions = async (dutyId: string) => (await readChat(paths.chat)).filter((l) => l.permission?.dutyId === dutyId);
    await addDuty("fetch", "observe", "bash:curl --version");
    await run("fetch");
    expect((await questions("fetch")).map((q) => q.permission!.commands)).toEqual([["curl"]]);

    await saveDuty(paths, { id: "fetch", name: "임무 fetch", cwd: fixture.projectDir, prompt: "bash:curl --version", profile: "observe", trigger: { kind: "manual" }, grants: ["curl"] });
    await run("fetch");
    expect(await questions("fetch")).toHaveLength(1);

    await addDuty("rm2", "observe", "bash:rm -f hello.txt");
    await run("rm2");
    expect(await questions("rm2")).toEqual([]);
    expect(await readFile(join(fixture.projectDir, "hello.txt"), "utf8")).toBe("안녕 Pi\n");
  });

  it("허용 목록에 없는 bash와 선언되지 않은 쓰기 도구는 실행되지 않는다", async () => {
    await addDuty("rm", "propose", "bash:rm -f hello.txt");
    await run("rm");
    expect(await readFile(join(fixture.projectDir, "hello.txt"), "utf8")).toBe("안녕 Pi\n");

    await addDuty("write", "observe", 'tool:write {"path":"new.txt","content":"x"}');
    await run("write");
    expect(existsSync(join(fixture.projectDir, "new.txt"))).toBe(false);
  });

  it("비용 상한을 넘으면 실행을 멈추고 '비용 상한'으로 남긴다", async () => {
    // 토큰 하나에 $1인 mock 모델 (mock 응답은 입력 10·출력 5 토큰 → $15)
    await writeFile(
      join(fixture.piEnv.PI_CODING_AGENT_DIR!, "models.json"),
      JSON.stringify({
        providers: {
          mock: {
            baseUrl: fixture.llm.baseUrl,
            api: "openai-completions",
            apiKey: "mock",
            models: [{ id: "mock-model" }, { id: "mock-costly", cost: { input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0 } }],
          },
        },
      }),
    );
    await saveDuty(paths, {
      id: "costly",
      name: "비싼 임무",
      cwd: fixture.projectDir,
      prompt: "비싼 질문",
      profile: "observe",
      trigger: { kind: "manual" },
      model: "mock/mock-costly",
      maxCostUsd: 1,
    });
    const record = await run("costly");
    expect(record).toMatchObject({ status: "budget" });
    expect(record.error).toMatch(/비용 상한 \$1/);
    expect(record.costUsd).toBeGreaterThan(1);
    // 세션 파일을 기록해 화면에서 열 수 있다
    expect(record.sessionFile && existsSync(record.sessionFile)).toBe(true);
  });

  const start = async () => JSON.parse((await execFileAsync(process.execPath, [RUNNER, "start"], { env })).stdout) as { status: string; pid: number };

  async function stopRunner(pid: number): Promise<void> {
    await execFileAsync(process.execPath, [RUNNER, "stop"], { env });
    for (let i = 0; i < 50 && isAlive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  }

  /** 조건에 맞는 실행 기록을 기다린다. 실패하면 실행기 로그·기록·상태를 함께 보여 준다 (분리된 프로세스라 출력이 테스트에 남지 않음) */
  async function waitForRun(match: (r: RunRecord) => boolean, ms = 30_000): Promise<RunRecord> {
    let found: RunRecord | undefined;
    for (const end = Date.now() + ms; !found && Date.now() < end; ) {
      await new Promise((r) => setTimeout(r, 100));
      found = (await listRuns(paths)).find(match);
    }
    if (found) return found;
    throw new Error(`실행 기록을 기다리다 시간이 지났습니다\n${await diagnostics()}`);
  }

  /** 분리된 실행기의 로그·실행 기록·상태 (실패 메시지에 붙인다) */
  async function diagnostics(): Promise<string> {
    return [
      await readFile(paths.log, "utf8").catch(() => "(로그 없음)"),
      JSON.stringify(await listRuns(paths), null, 1),
      await readFile(paths.state, "utf8").catch(() => "(상태 없음)"),
    ].join("\n---\n");
  }

  it("상주 실행기가 지금 실행 요청을 처리하고, 두 번 띄워도 하나만 돈다", async () => {
    const first = await start();
    expect(first.status).toBe("started");
    expect(await start()).toMatchObject({ status: "running", pid: first.pid });

    await addDuty("echo", "observe", "상주 확인");
    await addRequest(paths, "echo");
    const done = await waitForRun((r) => r.dutyId === "echo" && r.status === "done");
    expect(done).toMatchObject({ reason: "manual", summary: "echo: 상주 확인" });

    await stopRunner(first.pid);
    expect(isAlive(first.pid)).toBe(false);
    // stop은 pid 파일까지 지운다. 남기면 그 pid가 다른 프로세스에 재사용됐을 때 다음 start가 실행기를 띄우지 않는다
    expect(await readPid(paths)).toBeUndefined();
  });

  it("act: 작업 공간에서 고친 것은 승인 대기로 올라가고, 적용해야 내 폴더에 들어온다", async () => {
    const repo = await mkdtemp(join(tmpdir(), "mate-act-"));
    const gitEnv = { ...env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    const git = (...args: string[]) => execFileAsync("git", args, { cwd: repo, env: gitEnv });
    await git("init", "-q", "-b", "main");
    await writeFile(join(repo, "README.md"), "hello\n");
    await git("add", ".");
    await git("commit", "-qm", "first");
    const act = (id: string, prompt: string) =>
      saveDuty(paths, { id, name: `고치기 ${id}`, cwd: repo, prompt, profile: "act", trigger: { kind: "manual" } });
    try {
      await act("fix", 'tool:write {"path":"fix.txt","content":"고침\\n"}');
      const record = await run("fix");
      expect(record).toMatchObject({ status: "done", changeFiles: 1, proposals: 1 });
      expect(existsSync(join(repo, "fix.txt"))).toBe(false);
      const item = (await readInbox(paths.inbox)).find((i) => i.runId === record.id && i.change);
      expect(item).toMatchObject({ severity: "action", title: "고치기 fix: 파일 1개 고침", change: { files: ["fix.txt"] } });
      expect(existsSync(item!.change!.worktree)).toBe(true);

      await applyInboxChange(paths, item!.id);
      // 줄 끝은 사용자 git 설정(core.autocrlf)을 따른다
      expect((await readFile(join(repo, "fix.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("고침\n");
      expect(existsSync(item!.change!.worktree)).toBe(false);
      expect((await loadInboxState(paths))[item!.id]?.status).toBe("applied");

      // 작업 공간 밖으로는 쓰지 못하고, 바뀐 것이 없으면 작업 공간을 남기지 않는다
      await act("escape", 'tool:write {"path":"../mate-escape.txt","content":"x"}');
      expect(await run("escape")).toMatchObject({ status: "done", proposals: 0 });
      expect(existsSync(join(paths.worktrees, "..", "mate-escape.txt"))).toBe(false);
      expect(existsSync(join(repo, "..", "mate-escape.txt"))).toBe(false);
      expect((await readdir(paths.worktrees)).filter((n) => !n.endsWith(".patch"))).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("git 계기: 처음 본 커밋은 기준만 잡고, 새 커밋이 생기면 돈다", async () => {
    const repo = await mkdtemp(join(tmpdir(), "mate-git-"));
    const gitEnv = { ...env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    const git = (...args: string[]) => execFileAsync("git", args, { cwd: repo, env: gitEnv });
    await git("init", "-q", "-b", "main");
    await git("commit", "-q", "--allow-empty", "-m", "first");
    await saveDuty(paths, { id: "repo", name: "저장소", cwd: repo, prompt: "새 커밋 확인", profile: "observe", trigger: { kind: "git" } });

    const runner = await start();
    try {
      // 느린 Windows CI에서는 실행기 시작(WMI)과 첫 git 확인이 10초를 넘기도 해 넉넉히 기다린다
      let baseline: string | undefined;
      for (const end = Date.now() + 30_000; !baseline && Date.now() < end; ) {
        await new Promise((r) => setTimeout(r, 100));
        baseline = (await loadState(paths)).duties.repo?.watch?.signature;
      }
      // toMatch(undefined)는 메시지 없이 TypeError로 끝나므로, 기준이 없으면 진단을 붙여 먼저 실패시킨다
      if (!baseline) throw new Error(`git 기준을 기다리다 시간이 지났습니다 (start 결과 ${JSON.stringify(runner)})\n${await diagnostics()}`);
      expect(baseline).toMatch(/^main@/);
      expect((await listRuns(paths)).some((r) => r.dutyId === "repo")).toBe(false);

      await git("commit", "-q", "--allow-empty", "-m", "second");
      const { stdout: sha } = await git("rev-parse", "--short", "HEAD");
      const changed = await waitForRun((r) => r.dutyId === "repo" && r.status === "done");
      expect(changed).toMatchObject({ reason: "change", cause: `커밋 ${sha.trim()} (main)` });
      // 실행기는 실행 기록을 먼저 쓰고 상태(처리한 변화 지우기)를 그 뒤에 저장한다. 느린 CI에서는 그 사이에 읽을 수 있어 잠깐 기다린다
      let pending = (await loadState(paths)).duties.repo?.watch?.pending;
      for (const end = Date.now() + 10_000; pending && Date.now() < end; ) {
        await new Promise((r) => setTimeout(r, 100));
        pending = (await loadState(paths)).duties.repo?.watch?.pending;
      }
      expect(pending).toBeUndefined();
    } finally {
      await stopRunner(runner.pid);
      await rm(repo, { recursive: true, force: true }).catch(() => {});
    }
  });
});
