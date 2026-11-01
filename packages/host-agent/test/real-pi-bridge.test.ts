import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Methods, type SessionOpenResult, type SessionSummary } from "@pi-desktop/host-protocol";
import { BRIDGE_SOURCE, ENABLE_TOOLS_COMMAND, ensureBridge, RELOAD_COMMAND } from "../src/bridge";
import { isolatedEnv, TestClient } from "./helpers/agent-client";
import { MOCK_MODEL_ARGS, PI_CLI, setupRealPi, type RealPiFixture } from "./helpers/real-pi";

async function waitUntil(check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("대기 시간 초과");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("ensureBridge", () => {
  it("내용 해시 이름으로 한 번만 쓴다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-bridge-"));
    const path = await ensureBridge(dir);
    expect(path).toMatch(/pi-desktop-bridge-[0-9a-f]{12}\.ts$/);
    expect(existsSync(path)).toBe(true);
    expect(await ensureBridge(dir)).toBe(path);
    expect(BRIDGE_SOURCE).toContain(`"${RELOAD_COMMAND}"`);
    expect(BRIDGE_SOURCE).toContain(`"${ENABLE_TOOLS_COMMAND}"`);
  });
});

/** 실제 Pi에 bridge가 들어가고, /desktop:reload로 세션을 다시 열지 않고 새 리소스가 반영되는지 */
describe("bridge 확장 (실제 Pi)", () => {
  let fixture: RealPiFixture;
  let client: TestClient;
  let session: SessionSummary;

  const send = <T = Record<string, unknown>>(command: Record<string, unknown>) =>
    client.request<T>(Methods.sessionSend, { sessionId: session.sessionId, command });
  const commandNames = async () =>
    (await send<{ data: { commands: Array<{ name: string }> } }>({ type: "get_commands" })).data.commands.map((c) => c.name);

  beforeAll(async () => {
    fixture = await setupRealPi();
    client = new TestClient(await isolatedEnv({ PI_DESKTOP_PI_CLI: PI_CLI }));
    ({ session } = await client.request<SessionOpenResult>(Methods.sessionOpen, {
      cwd: fixture.projectDir,
      piArgs: MOCK_MODEL_ARGS,
      env: fixture.piEnv,
    }));
    await client.request(Methods.sessionAttach, { sessionId: session.sessionId, lastSeq: 0 });
  });

  afterAll(async () => {
    await client?.shutdownDaemon();
    await fixture?.llm.close();
  });

  it("세션 명령 목록에 /desktop:reload가 있다", async () => {
    expect(await commandNames()).toContain(RELOAD_COMMAND);
  });

  it("세션을 연 뒤 만든 프롬프트가 /desktop:reload 뒤에 나타난다 (LLM을 부르지 않음)", async () => {
    const prompts = join(fixture.projectDir, ".pi", "prompts");
    mkdirSync(prompts, { recursive: true });
    writeFileSync(join(prompts, "fresh.md"), "---\ndescription: 새 프롬프트\n---\nhi\n");
    expect(await commandNames()).not.toContain("fresh");

    const requestsBefore = fixture.llm.requests.length;
    const response = await send<{ success: boolean; data?: { disposition?: string } }>({
      type: "prompt",
      message: `/${RELOAD_COMMAND}`,
    });
    expect(response).toMatchObject({ success: true, data: { disposition: "handled" } });
    expect(await commandNames()).toContain("fresh");
    expect(fixture.llm.requests.length).toBe(requestsBefore);
  });

  it("확장을 넣기 전에 대화한 세션을 다시 열면 그 툴이 꺼져 있고, /desktop:enable-tools로 켠다", async () => {
    const toolNames = () => {
      const body = fixture.llm.requests.at(-1) as { tools?: Array<{ function?: { name?: string } }> } | undefined;
      return (body?.tools ?? []).map((t) => t.function?.name);
    };
    const settledCount = () =>
      client.events.filter((n) => n.sessionId === session.sessionId && (n.event as { type?: string }).type === "agent_settled").length;
    const ask = async (message: string) => {
      const before = settledCount();
      await send({ type: "prompt", message });
      await waitUntil(() => settledCount() > before);
    };
    await ask("확장 넣기 전");
    expect(toolNames()).not.toContain("late_tool");
    const state = await send<{ data: { sessionFile: string } }>({ type: "get_state" });

    // 프로젝트 확장은 신뢰가 있어야 불러오므로 사용자 폴더에 둔다
    const extensions = join(fixture.piEnv.PI_CODING_AGENT_DIR!, "extensions");
    mkdirSync(extensions, { recursive: true });
    writeFileSync(
      join(extensions, "late-tool.ts"),
      `export default function (pi: any) {
  pi.registerTool({ name: "late_tool", label: "Late", description: "나중에 넣은 툴", parameters: { type: "object", properties: {} },
    async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; } });
}
`,
    );
    // 세션을 닫고 같은 파일로 다시 연다: 기록된 툴 목록을 지켜 새 확장의 툴이 꺼져 있다
    await client.request(Methods.sessionClose, { sessionId: session.sessionId });
    ({ session } = await client.request<SessionOpenResult>(Methods.sessionOpen, {
      cwd: fixture.projectDir,
      sessionFile: state.data.sessionFile,
      piArgs: MOCK_MODEL_ARGS,
      env: fixture.piEnv,
    }));
    await client.request(Methods.sessionAttach, { sessionId: session.sessionId, lastSeq: 0 });
    await ask("다시 연 뒤");
    expect(toolNames()).not.toContain("late_tool");

    const response = await send<{ success: boolean }>({ type: "prompt", message: `/${ENABLE_TOOLS_COMMAND}` });
    expect(response.success).toBe(true);
    await ask("툴 켠 뒤");
    expect(toolNames()).toContain("late_tool");
  });

  // 한국어 Windows의 기본 명령은 CP949로 출력해 UTF-8로 읽으면 깨진다. bridge가 chcp 65001을 붙인다.
  it.skipIf(process.platform !== "win32")("Windows에서 !명령(RPC bash)의 기본 명령 출력이 깨지지 않는다", async () => {
    const response = await send<{ success: boolean; data?: { output?: string } }>({ type: "bash", command: "findstr; echo 한글" });
    expect(response.success).toBe(true);
    expect(response.data?.output ?? "").toContain("한글");
    expect(response.data?.output ?? "").not.toContain("�");
  });
});
