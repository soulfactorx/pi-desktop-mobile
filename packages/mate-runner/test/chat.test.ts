import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendBlocked, appendChat, appendChatQuestion, appendProposal, makeProposal, PERMISSION_OPTIONS, readChat } from "@pi-desktop/mate-kit";
import { askPermission } from "../src/permission";
import { addChatRequest, ChatAgent, loadChatState } from "../src/chat/chat-agent";
import { chatSystemPrompt, openQuestions } from "../src/chat/context";
import { parseSchedulePhrase } from "../src/chat/schedule-phrase";
import type { RunInput, RunOutcome } from "../src/executor";
import { matePaths, type MatePaths } from "../src/paths";
import { listDuties, loadConfig, loadInboxState, saveConfig, saveDuty, takeRequests } from "../src/store";

describe("실행 시점 표현", () => {
  it("대화에서 쓰는 표현을 계기로 바꾼다", () => {
    expect(parseSchedulePhrase(undefined)).toEqual({ kind: "manual" });
    expect(parseSchedulePhrase("daily 9:00")).toEqual({ kind: "daily", time: "09:00" });
    expect(parseSchedulePhrase("weekdays 18:30")).toEqual({ kind: "daily", time: "18:30", weekdays: [1, 2, 3, 4, 5] });
    expect(parseSchedulePhrase("every 30 minutes")).toEqual({ kind: "interval", minutes: 30 });
    expect(parseSchedulePhrase("on-commit")).toEqual({ kind: "git" });
    expect(parseSchedulePhrase("after-session")).toEqual({ kind: "session" });
    expect(parseSchedulePhrase("가끔")).toBeUndefined();
    expect(parseSchedulePhrase("daily 25:00")).toBeUndefined();
  });
});

describe("ChatAgent", () => {
  let paths: MatePaths;
  let agent: ChatAgent;
  let calls: RunInput[];
  let reply: Partial<RunOutcome>;
  const noGit = async () => ({ code: 1, stdout: "" });
  const kitDir = join(__dirname, "..", "..", "mate-kit");

  beforeEach(async () => {
    paths = matePaths(await mkdtemp(join(tmpdir(), "mate-chat-")));
    calls = [];
    reply = { summary: "알겠어요" };
    agent = new ChatAgent({
      paths,
      kitDir,
      locatePi: async () => ({ cliPath: "pi" }),
      exec: noGit,
      log: () => {},
      runPi: (async (_l: unknown, input: RunInput) => {
        calls.push(input);
        return { status: "done", costUsd: 0.002, tokens: 1, proposals: 0, ...reply };
      }) as never,
    });
    await saveDuty(paths, { id: "brief", name: "아침 브리핑", cwd: "/w/pi-desktop", prompt: "p", profile: "observe", trigger: { kind: "manual" } });
  });
  afterEach(async () => {
    agent.stop();
    await rm(paths.home, { recursive: true, force: true });
  });

  it("앱 요청 파일을 읽어 답하고, '/' 명령은 모델 없이 바로 답한다", async () => {
    const user = await appendChat(paths.chat, { role: "user", text: "/duties", source: "app" });
    await addChatRequest(paths, { text: "/duties", source: "app", lineId: user.id });
    await agent.pump();
    expect(calls).toHaveLength(0);
    let lines = await readChat(paths.chat);
    // 앱이 남긴 사용자 줄은 다시 남기지 않는다
    expect(lines.filter((l) => l.role === "user")).toHaveLength(1);
    expect(lines.at(-1)).toMatchObject({ role: "mate", kind: "reply", source: "app" });
    expect(lines.at(-1)!.text).toContain("아침 브리핑");
    expect(await readdir(paths.chatRequests)).toEqual([]);

    await addChatRequest(paths, { text: "오늘 브리핑 결과 알려줘", source: "app" });
    await agent.pump();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.chat!.systemPrompt).toContain("아침 브리핑");
    lines = await readChat(paths.chat);
    expect(lines.at(-1)).toMatchObject({ role: "mate", text: "알겠어요" });
    expect((await loadChatState(paths)).cost?.usd).toBeCloseTo(0.002);
  });

  it("mate_do 할 일: 임무 만들기·제안 처리·일시 정지, 모르는 폴더는 거절", async () => {
    const item = makeProposal({ title: "린트 경고", summary: "s" }, { dutyId: "brief", runId: "r" });
    await appendProposal(paths.inbox, item);
    expect(await agent.doAction({ action: "create_duty", name: "Nightly check", folder: "pi-desktop", prompt: "테스트 확인", schedule: "daily 22:00" }, "app")).toMatch(/만들었어요/);
    const made = (await listDuties(paths)).find((d) => d.name === "Nightly check");
    expect(made).toMatchObject({ id: "nightly-check", cwd: "/w/pi-desktop", profile: "propose", trigger: { kind: "daily", time: "22:00" } });
    expect(await agent.doAction({ action: "dismiss", item: item.id }, "app")).toMatch(/버림/);
    expect((await loadInboxState(paths))[item.id]?.status).toBe("dismissed");
    expect(await agent.doAction({ action: "pause" }, "app")).toMatch(/멈췄어요/);
    expect((await loadConfig(paths)).paused).toBe(true);
    expect(await agent.doAction({ action: "ask", folder: "없는폴더", prompt: "x" }, "app")).toMatch(/모르겠어요/);
    // 휴대폰에서 고치기는 설정에서 허용해야 한다
    expect(await agent.doAction({ action: "fix", folder: "pi-desktop", prompt: "고쳐" }, "telegram")).toMatch(/꺼져 있어요/);
    expect(await agent.doAction({ action: "run_duty", duty: "브리핑" }, "app")).toMatch(/실행을 요청했어요/);
    expect((await loadChatState(paths)).pending.brief).toBeDefined();
  });

  it("답하지 않은 질문은 맥락에 들어가고, 같은 질문은 다시 묻지 않는다", async () => {
    expect(await appendChatQuestion(paths.chat, { text: "테스트를 추가할까요?", options: ["예", "아니요"] })).toBe(true);
    expect(await appendChatQuestion(paths.chat, { text: "테스트를  추가할까요?" })).toBe(false);
    const lines = await readChat(paths.chat);
    expect(openQuestions(lines)).toHaveLength(1);
    expect(await chatSystemPrompt(paths, Date.now())).toContain("테스트를 추가할까요?");
    await appendChat(paths.chat, { role: "user", text: "예", answerTo: lines[0]!.id });
    expect(openQuestions(await readChat(paths.chat))).toHaveLength(0);
  });

  it("막힌 명령은 허용을 묻고, 허용하면 임무에 더해 다시 실행한다 (모델 없이)", async () => {
    const duty = (await listDuties(paths)).find((d) => d.id === "brief")!;
    const blocked = join(paths.runDir, "blocked", "r1.jsonl");
    await appendBlocked(blocked, { name: "curl", command: "curl -s https://hacker-news.firebaseio.com/v0/topstories.json", at: 1 });
    await appendBlocked(blocked, { name: "curl", command: "curl -s https://b", at: 2 });
    expect(await askPermission(paths, duty, "r1", blocked, Date.now())).toBe(true);
    const question = (await readChat(paths.chat)).find((l) => l.kind === "question")!;
    expect(question).toMatchObject({ options: [...PERMISSION_OPTIONS], permission: { dutyId: "brief", commands: ["curl"] } });
    expect(question.text).toContain("hacker-news.firebaseio.com");
    // 기록 파일은 지우고, 답하지 않은 같은 질문은 다시 묻지 않는다
    await appendBlocked(blocked, { name: "curl", command: "curl -s https://hacker-news.firebaseio.com/v0/topstories.json", at: 3 });
    expect(await askPermission(paths, duty, "r2", blocked, Date.now())).toBe(false);

    agent.submit({ text: PERMISSION_OPTIONS[0], source: "telegram", answerTo: question.id });
    await agent.whenIdle();
    expect(calls).toHaveLength(0);
    expect((await listDuties(paths)).find((d) => d.id === "brief")!.grants).toEqual(["curl"]);
    expect((await takeRequests(paths)).map((r) => r.dutyId)).toEqual(["brief"]);
    expect((await loadChatState(paths)).pending.brief?.source).toBe("telegram");
    expect((await readChat(paths.chat)).at(-1)!.text).toContain("curl을(를) 허용했어요");

    // 같은 질문에 또 답하면 처음 답만 따른다
    agent.submit({ text: PERMISSION_OPTIONS[0], source: "app", answerTo: question.id });
    await agent.whenIdle();
    expect((await readChat(paths.chat)).at(-1)!.text).toBe("이미 답한 질문이에요.");
    expect(await takeRequests(paths)).toEqual([]);

    // 이미 허용한 명령은 다시 묻지 않는다
    const granted = (await listDuties(paths)).find((d) => d.id === "brief")!;
    await appendBlocked(blocked, { name: "curl", command: "curl -o x https://a", at: 4 });
    expect(await askPermission(paths, granted, "r3", blocked, Date.now())).toBe(false);
  });

  it("허용하지 않으면 임무를 그대로 두고, 예·아니요가 아닌 답은 모델이 받는다", async () => {
    const duty = (await listDuties(paths)).find((d) => d.id === "brief")!;
    const blocked = join(paths.runDir, "blocked", "r1.jsonl");
    await appendBlocked(blocked, { name: "dig", command: "dig +short example.com", at: 1 });
    await askPermission(paths, duty, "r1", blocked, Date.now());
    const question = (await readChat(paths.chat)).find((l) => l.kind === "question")!;
    agent.submit({ text: "왜 필요한데?", source: "app", answerTo: question.id });
    await agent.whenIdle();
    expect(calls).toHaveLength(1);
    agent.submit({ text: PERMISSION_OPTIONS[1], source: "app", answerTo: question.id });
    await agent.whenIdle();
    expect((await listDuties(paths)).find((d) => d.id === "brief")!.grants).toBeUndefined();
    expect(await takeRequests(paths)).toEqual([]);
  });

  it("막힌 MCP 도구는 도구 설명과 함께 다섯 개까지 묻고, 허용하면 그 도구만 임무에 더한다", async () => {
    const duty = (await listDuties(paths)).find((d) => d.id === "brief")!;
    const blocked = join(paths.runDir, "blocked", "r1.jsonl");
    for (let i = 0; i < 7; i++) await appendBlocked(blocked, { name: `mcp__github__tool_${i}`, command: `도구 ${i} 설명`, at: i });
    expect(await askPermission(paths, duty, "r1", blocked, Date.now())).toBe(true);
    const question = (await readChat(paths.chat)).find((l) => l.kind === "question")!;
    expect(question.permission!.commands).toEqual(["mcp__github__tool_0", "mcp__github__tool_1", "mcp__github__tool_2", "mcp__github__tool_3", "mcp__github__tool_4"]);
    expect(question.text).toContain("MCP github · tool_0: 도구 0 설명");
    expect(question.text).toContain("읽기인지 쓰기인지");

    agent.submit({ text: PERMISSION_OPTIONS[0], source: "app", answerTo: question.id });
    await agent.whenIdle();
    expect((await listDuties(paths)).find((d) => d.id === "brief")!.grants).toEqual(question.permission!.commands);
    expect((await takeRequests(paths)).map((r) => r.dutyId)).toEqual(["brief"]);
  });

  it("대화는 설정에서 고른 MCP 서버와 허용한 도구로 돌고, 막힌 도구를 허용하면 설정에 더한다", async () => {
    await saveConfig(paths, { chatMcpServers: ["github"], chatGrants: ["mcp__github__list_prs"] });
    agent.submit({ text: "열린 PR 알려 줘", source: "app" });
    await agent.whenIdle();
    expect(calls[0]!.duty).toMatchObject({ id: "mate-chat", mcpServers: ["github"], grants: ["mcp__github__list_prs"] });
    expect(calls[0]!.blockedPath).toBeDefined();

    const chatDuty = calls[0]!.duty;
    await appendBlocked(calls[0]!.blockedPath!, { name: "mcp__github__create_issue", command: "이슈를 만든다", at: 1 });
    expect(await askPermission(paths, chatDuty, "c1", calls[0]!.blockedPath!, Date.now())).toBe(true);
    const question = (await readChat(paths.chat)).find((l) => l.kind === "question")!;
    expect(question.text).toContain("대화에서 create_issue을(를) 허용할까요?");
    agent.submit({ text: PERMISSION_OPTIONS[0], source: "app", answerTo: question.id });
    await agent.whenIdle();
    expect((await loadConfig(paths)).chatGrants).toEqual(["mcp__github__list_prs", "mcp__github__create_issue"]);
    // 대화는 다시 실행하지 않는다
    expect(calls).toHaveLength(1);
    expect(await takeRequests(paths)).toEqual([]);
  });

  it("/new는 대화 번호를 올리고 구분선을 남긴다", async () => {
    agent.submit({ text: "/new", source: "app" });
    await agent.whenIdle();
    expect((await loadChatState(paths)).epoch).toBe(2);
    expect((await readChat(paths.chat)).at(-1)).toMatchObject({ kind: "divider" });
  });
});
