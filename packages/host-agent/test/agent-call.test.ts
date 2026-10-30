import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Methods } from "@pi-desktop/host-protocol";
import { isolatedEnv, TestClient } from "./helpers/agent-client";
import { PI_CLI } from "./helpers/real-pi";

/**
 * 에이전트 앱의 데이터 함수를 데몬으로 부른다 (설계 DESIGN-APPS.md §6 D4).
 * 데몬 홈(PI_DESKTOP_HOME)이 Agent 홈이고, 상태는 그 아래 data/, 스킬은 skills/에 있다.
 */
describe("agent.call", () => {
  let client: TestClient;
  let home: string;
  const call = <T>(name: string, ...args: unknown[]) => client.request<T>(Methods.agentCall, { name, args });

  beforeAll(async () => {
    const env = await isolatedEnv();
    home = env.PI_DESKTOP_HOME!;
    client = new TestClient(env);
  });

  afterAll(async () => {
    await client?.shutdownDaemon();
  });

  it("지식베이스를 만들고 읽는다 (데몬 홈의 data/)", async () => {
    const entry = await call<{ id: string; title: string }>("kbSave", undefined, { type: "user", title: "선호", content: "한국어로 답한다", tags: [] });
    expect(entry.title).toBe("선호");
    const list = await call<Array<{ id: string }>>("kbList", false);
    expect(list.map((e) => e.id)).toEqual([entry.id]);
    expect(existsSync(join(home, "data", "memory"))).toBe(true);
    await expect(call("kbSave", undefined, { type: "user", title: "", content: "" })).rejects.toThrow(/제목과 본문/);
  });

  it("스킬은 데몬 홈의 skills/에 둔다", async () => {
    await call("skillSave", undefined, { name: "weekly-report", description: "주간 보고", instructions: "1. 본다", modelInvocation: true });
    expect(existsSync(join(home, "skills", "weekly-report", "SKILL.md"))).toBe(true);
    expect((await call<Array<{ name: string }>>("skillsList")).map((s) => s.name)).toEqual(["weekly-report"]);
    expect(await call("skillsDir")).toBe(join(home, "skills"));
  });

  it("돌려줄 값이 없으면 null, 모르는 이름이나 Object 원형의 이름은 거절한다", async () => {
    expect(await call("setElevation", true)).toBeNull();
    expect(await call("getElevation")).toBe(true);
    await expect(call("nope")).rejects.toThrow(/모르는 에이전트 함수/);
    await expect(call("toString")).rejects.toThrow(/모르는 에이전트 함수/);
  });

  it("MCP 설정은 데몬 홈의 mcp.json을 고치고, 연결 확인은 그 호스트의 Pi로 돈다", async () => {
    const views = await call<Array<{ name: string }>>("mcpAddPreset", "exa");
    expect(views.map((v) => v.name)).toEqual(["exa"]);
    expect(existsSync(join(home, "mcp.json"))).toBe(true);
    expect(await call("mcpSetEnabled", "exa", false)).toEqual([expect.objectContaining({ name: "exa", enabled: false })]);
    expect(await call("mcpRemove", "exa")).toEqual([]);
    const check = await call<{ ok: boolean; output: string }>("mcpCheck", { piCliPath: PI_CLI });
    expect(check.output).toMatch(/mcp/i);
  }, 60_000);

  it("본문 검색은 데몬 홈의 세션 폴더 안 파일만 읽는다", async () => {
    const dir = join(home, "sessions");
    mkdirSync(dir, { recursive: true });
    const inside = join(dir, "a.jsonl");
    const line = (role: string, text: string) => JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }] } });
    writeFileSync(inside, `${JSON.stringify({ type: "session", id: "a", cwd: "/w" })}\n${line("user", "배포 스크립트 고치기")}\n`);
    const outside = join(home, "secret.jsonl");
    writeFileSync(outside, `${line("user", "배포 비밀")}\n`);
    const hits = await call<Array<{ path: string }>>("searchHistory", [{ path: inside, firstMessage: "" }, { path: outside, firstMessage: "" }], "배포");
    expect(hits.map((h) => h.path)).toEqual([inside]);
  });

  it("사용량과 네트워크 상태를 그 호스트에서 만든다", async () => {
    const usage = await call<{ range: string; total: unknown }>("usageSummary", "7d");
    expect(usage).toMatchObject({ range: "7d", total: expect.any(Object) });
    const network = await call<{ settings: { enabled: boolean }; peers: unknown[] }>("networkState");
    expect(network.settings.enabled).toBe(false);
    expect(network.peers).toEqual([]);
  });
});
