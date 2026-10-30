import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APPROVAL_MARKER, parseApprovalTitle } from "../src/approval";
import { attended, isWorker } from "../src/runtime";
import { classify } from "../extensions/permissions/rules";
import { taskNotice } from "../extensions/tasks/index";
import { inheritedArgsOf, labelTitle, piCommand, runWorker } from "../extensions/tasks/worker";
import { extensionArgs, extensionEntries } from "../src/index";
import { kitDir, PI_CLI, startPi, type RpcPi, type RpcRecord } from "./helpers/rpc-pi";
import { startScriptLlm, type ScriptLlm } from "./helpers/script-llm";

describe("워커 준비", () => {
  it("지금 Pi의 cli와 확장·격리 옵션을 물려준다", () => {
    expect(piCommand(["node", "/x/cli.js", "--mode", "rpc"], {})).toEqual({ command: process.execPath, args: ["/x/cli.js"] });
    expect(piCommand(["pi.exe"], {}).command).toBe("pi");
    expect(inheritedArgsOf(["node", "cli.js", "-e", "/a.ts", "--model", "m", "--extension", "/b.ts"])).toEqual(["-e", "/a.ts", "--extension", "/b.ts"]);
    // 앱이 띄운 격리 옵션은 물려주고 세션 폴더는 물려주지 않는다
    const isolated = ["node", "cli.js", "--mode", "rpc", "--session-dir", "/h/sessions", "-ns", "--skill", "/h/skills", "-np", "--prompt-template", "/h/prompts", "-ne", "-e", "/k.ts", "-e", "builtin:codemode", "-nc"];
    expect(inheritedArgsOf(isolated)).toEqual(["-ns", "--skill", "/h/skills", "-np", "--prompt-template", "/h/prompts", "-ne", "-e", "/k.ts", "-e", "builtin:codemode", "-nc"]);
  });

  it("다이얼로그 제목에 작업 이름을 붙이되, 승인 형식은 앱이 읽을 수 있게 첫 줄 끝에 붙인다", () => {
    expect(labelTitle("어느 쪽?", "작업 t1")).toBe("[작업 t1] 어느 쪽?");
    const approval = labelTitle(`${APPROVAL_MARKER} bash · 실행 · 명령 실행\nls -la`, "작업 t1");
    expect(parseApprovalTitle(approval)).toMatchObject({ toolName: "bash", summary: "명령 실행 (작업 t1)", target: "ls -la" });
  });

  it("사람이 지켜보는지·워커인지는 환경 변수로도 판단한다", () => {
    expect(attended(true, {})).toBe(true);
    expect(attended(true, { PI_DESKTOP_AGENT_UNATTENDED: "1" })).toBe(false);
    expect(attended(false, {})).toBe(false);
    expect(isWorker({ PI_DESKTOP_AGENT_WORKER: "1" })).toBe(true);
    expect(classify("delegate_task", { title: "x", instruction: "y" })).toEqual({ risk: "read" });
  });

  it("작업 알림 글", () => {
    const base = { id: "t1", title: "정리", instruction: "", origin: "delegate" as const, cwd: "", startedAt: "" };
    expect(taskNotice({ ...base, status: "done", result: "3개 지움" })).toBe("[작업 알림] 정리 (t1) — 완료\n3개 지움");
    expect(taskNotice({ ...base, status: "failed", error: "boom" })).toBe("[작업 알림] 정리 (t1) — 실패\n오류: boom");
  });
});

describe("tasks (실제 Pi + 워커)", () => {
  let llm: ScriptLlm;
  let pi: RpcPi;
  let dataDir: string;

  beforeAll(async () => {
    llm = await startScriptLlm("mock-model");
    ({ pi, dataDir } = await startPi(llm.baseUrl));
  });

  afterAll(async () => {
    pi?.close();
    await llm?.close();
  });

  it("맡기면 바로 돌아오고, 워커의 승인은 이 세션에서 받고, 끝나면 결과가 대화에 들어온다", async () => {
    // 워커 대화는 지시에 WORKER-JOB이 들어 있어 따로 답한다
    llm.route((text) => text.includes("WORKER-JOB"), [{ tool: "bash", args: { command: "echo worker-ran" } }, { text: "워커 결과: 셋을 찾았다" }]);
    llm.setScript([
      { tool: "delegate_task", args: { title: "파일 세기", instruction: "WORKER-JOB: 파일을 세라" } },
      { text: "맡겼다" },
      { text: "작업 결과를 확인했다" },
    ]);
    const from = pi.mark;
    await pi.request({ type: "prompt", message: "백그라운드로 세 줘" });

    // 워커의 bash 승인 요청이 작업 이름을 달고 이 세션으로 넘어온다
    const asked = await pi.waitFor(
      (r: RpcRecord) => r.type === "extension_ui_request" && r.method === "select" && String(r.title).includes("(작업 t-"),
      from,
    );
    expect(parseApprovalTitle(String(asked.title))).toMatchObject({ toolName: "bash", target: "echo worker-ran" });
    pi.write({ type: "extension_ui_response", id: asked.id, value: (asked.options as string[])[0] });

    // 작업 알림이 들어와 메인 세션이 한 턴 더 돈다
    await pi.waitFor((r) => r.type === "message_end" && JSON.stringify(r).includes("작업 결과를 확인했다"), from);
    const last = llm.requests.at(-1) as { messages: unknown[] };
    expect(JSON.stringify(last.messages)).toContain("[작업 알림] 파일 세기");
    expect(JSON.stringify(last.messages)).toContain("워커 결과: 셋을 찾았다");

    const files = readdirSync(join(dataDir, "tasks")).filter((n) => n.endsWith(".json"));
    const record = JSON.parse(readFileSync(join(dataDir, "tasks", files[0]!), "utf8"));
    expect(record).toMatchObject({ title: "파일 세기", status: "done", result: "워커 결과: 셋을 찾았다" });
  }, 60_000);
});

describe("워커 — 모델 오류", () => {
  it("글 없이 모델 오류로 끝난 실행은 실패로 기록한다", async () => {
    // 아무것도 듣지 않는 주소로 보내 모델 호출을 실패시킨다 (재시도는 끈다)
    const argv = ["node", PI_CLI, ...extensionArgs(await extensionEntries(kitDir))];
    const models = JSON.stringify({ providers: { mock: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "mock", models: [{ id: "mock-model" }] } } });
    const agentDir = mkdtempSync(join(tmpdir(), "worker-err-"));
    writeFileSync(join(agentDir, "models.json"), models);
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
    await expect(
      runWorker({
        label: "t",
        prompt: "안녕",
        cwd: tmpdir(),
        provider: "mock",
        model: "mock-model",
        argv,
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: join(agentDir, "s"), PI_DESKTOP_AGENT_HOME: join(agentDir, "home") },
      }),
    ).rejects.toThrow(/모델 호출이 실패했다/);
  }, 60_000);
});
