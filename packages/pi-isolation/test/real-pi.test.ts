import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isolationArgs, isolationEnv, mcpToolPattern } from "../src/index";

/**
 * 실제 Pi(devDependency)를 격리 옵션으로 띄워, 모델에 가는 시스템 안내에 앱 홈의 것만 들어가는지 본다.
 * Pi 설정 폴더도 임시 폴더로 바꿔 사용자 ~/.pi를 건드리지 않는다.
 */

const packageDir = resolve(fileURLToPath(new URL("..", import.meta.url)));

function findPiCli(): string {
  let dir = packageDir;
  for (;;) {
    const candidate = join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("Pi를 찾을 수 없습니다. npm install을 먼저 실행하세요");
    dir = parent;
  }
}

/** 받은 요청 본문을 모아 두고 "끝"이라고만 답하는 OpenAI 호환 서버 */
async function startLlm(): Promise<{ baseUrl: string; requests: Array<Record<string, any>>; close: () => Promise<void> }> {
  const requests: Array<Record<string, any>> = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push(JSON.parse(body) as Record<string, any>);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: Record<string, unknown>, finish: string | null) =>
        res.write(`data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      chunk({ role: "assistant", content: "끝" }, null);
      chunk({}, "stop");
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise((done) => server.close(() => done())) };
}

function run(cli: string, args: string[], cwd: string, env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("exit", (code) => done({ code, stderr }));
  });
}

describe("실제 Pi에서 격리 옵션", () => {
  let llm: Awaited<ReturnType<typeof startLlm>>;
  beforeAll(async () => {
    llm = await startLlm();
  });
  afterAll(async () => {
    await llm.close();
  });

  it("앱 홈의 스킬·AGENTS.md·mcp.json만 보이고 Pi 설정 폴더의 것은 보이지 않는다", async () => {
    const piDir = mkdtempSync(join(tmpdir(), "iso-pi-"));
    writeFileSync(join(piDir, "models.json"), JSON.stringify({ providers: { mock: { baseUrl: llm.baseUrl, api: "openai-completions", apiKey: "mock", models: [{ id: "mock-model" }] } } }));
    writeFileSync(join(piDir, "AGENTS.md"), "PI_USER_INSTRUCTIONS");
    mkdirSync(join(piDir, "skills", "pi-skill"), { recursive: true });
    writeFileSync(join(piDir, "skills", "pi-skill", "SKILL.md"), "---\nname: pi-skill\ndescription: PI_SKILL_DESCRIPTION\n---\nx\n");
    // 끝나지 않는 명령이라 연결은 되지 않지만, codemode 서버는 목록(mcp_servers)에 이름이 오른다
    const idle = { command: process.execPath, args: ["-e", "setTimeout(() => {}, 60000)"], description: "서버 설명" };
    writeFileSync(join(piDir, "mcp.json"), JSON.stringify({ mcpServers: { "pi-server": idle } }));

    const home = mkdtempSync(join(tmpdir(), "iso-home-"));
    writeFileSync(join(home, "AGENTS.md"), "APP_INSTRUCTIONS");
    mkdirSync(join(home, "skills", "app-skill"), { recursive: true });
    writeFileSync(join(home, "skills", "app-skill", "SKILL.md"), "---\nname: app-skill\ndescription: APP_SKILL_DESCRIPTION\n---\nx\n");
    writeFileSync(join(home, "mcp.json"), JSON.stringify({ mcpServers: { "app-server": idle } }));

    const project = mkdtempSync(join(tmpdir(), "iso-project-"));
    writeFileSync(join(project, "AGENTS.md"), "PROJECT_INSTRUCTIONS");

    const args = [
      "--mode", "json",
      "--provider", "mock",
      "--model", "mock-model",
      ...isolationArgs({ home, isolationDir: packageDir, extensions: [], sessionDir: join(home, "sessions") }),
      "안녕",
    ];
    const result = await run(findPiCli(), args, project, { PI_CODING_AGENT_DIR: piDir, ...isolationEnv(home) });
    expect(result.code, result.stderr).toBe(0);

    const request = llm.requests.at(-1)!;
    const system = (request.messages as Array<{ role: string; content: unknown }>).filter((m) => m.role === "system" || m.role === "developer").map((m) => JSON.stringify(m.content)).join("\n");
    expect(system).toContain("APP_INSTRUCTIONS");
    expect(system).toContain("PROJECT_INSTRUCTIONS");
    expect(system).toContain("APP_SKILL_DESCRIPTION");
    expect(system).toContain("mcp__app_server");
    expect(system).not.toContain("PI_USER_INSTRUCTIONS");
    expect(system).not.toContain("PI_SKILL_DESCRIPTION");
    expect(system).not.toContain("mcp__pi_server");
    // 세션은 앱 홈에 남는다
    expect(existsSync(join(home, "sessions"))).toBe(true);
    expect(existsSync(join(piDir, "sessions"))).toBe(false);
  });

  it("Mate처럼 고른 서버의 도구만 모델에 바로 선언한다 (direct 노출, --tools 패턴)", async () => {
    const piDir = mkdtempSync(join(tmpdir(), "iso-pi-"));
    writeFileSync(join(piDir, "models.json"), JSON.stringify({ providers: { mock: { baseUrl: llm.baseUrl, api: "openai-completions", apiKey: "mock", models: [{ id: "mock-model" }] } } }));
    const home = mkdtempSync(join(tmpdir(), "iso-home-"));
    const fake = { command: process.execPath, args: [join(packageDir, "test", "fixtures", "fake-mcp.mjs")] };
    writeFileSync(join(home, "mcp.json"), JSON.stringify({ mcpServers: { "picked-one": fake, other: fake } }));
    const args = [
      "--mode", "json",
      "--provider", "mock",
      "--model", "mock-model",
      ...isolationArgs({ home, isolationDir: packageDir, extensions: [], sessionDir: join(home, "sessions") }),
      "--tools", ["read", mcpToolPattern("picked-one")].join(","),
      "도구 목록",
    ];
    const result = await run(findPiCli(), args, home, { PI_CODING_AGENT_DIR: piDir, ...isolationEnv(home, { mcpServers: ["picked-one"], mcpExposure: "direct" }) });
    expect(result.code, result.stderr).toBe(0);
    const tools = ((llm.requests.at(-1)!.tools ?? []) as Array<{ function?: { name?: string } }>).map((t) => t.function?.name);
    expect(tools).toEqual(expect.arrayContaining(["read", "mcp__picked_one__echo", "mcp__picked_one__add"]));
    expect(tools.some((name) => name?.startsWith("mcp__other__"))).toBe(false);
    expect(tools).not.toContain("codemode");
  });
});
