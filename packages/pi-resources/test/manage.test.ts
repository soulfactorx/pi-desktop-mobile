import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import manage, { changeMcp, deleteResource, listResources, saveResource, validPackageSource } from "../extensions/manage";

type Tool = { name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> };

function load(): Map<string, Tool> {
  const tools = new Map<string, Tool>();
  manage({ registerTool: (t: Tool) => tools.set(t.name, t) });
  return tools;
}

describe("확장 관리 확장 (manage)", () => {
  let home: string;
  const saved = { ...process.env };
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "pi-manage-"));
    process.env.PI_RESOURCES_HOME = home;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("스킬·프롬프트를 저장하고 목록에 보이고, 지우면 resources-trash로 옮긴다", () => {
    saveResource(home, { kind: "skill", name: "weekly-report", description: "주간 보고", content: "1. 본다" });
    saveResource(home, { kind: "prompt", name: "review", description: "리뷰 지시", content: "검토해 줘" });
    expect(readFileSync(join(home, "skills", "weekly-report", "SKILL.md"), "utf8")).toContain("name: weekly-report");
    const list = listResources(home);
    expect(list.skills).toEqual([{ name: "weekly-report", description: "주간 보고" }]);
    expect(list.prompts).toEqual([{ name: "review", description: "리뷰 지시" }]);
    expect(() => saveResource(home, { kind: "prompt", name: "review", description: "x", content: "y" })).toThrow("replace");
    saveResource(home, { kind: "prompt", name: "review", description: "고친 지시", content: "다시", replace: true });
    expect(listResources(home).prompts[0]?.description).toBe("고친 지시");
    deleteResource(home, { kind: "skill", name: "weekly-report" });
    expect(existsSync(join(home, "skills", "weekly-report"))).toBe(false);
    expect(readdirSync(join(home, "resources-trash")).length).toBe(1);
    expect(() => saveResource(home, { kind: "skill", name: "../x", description: "d", content: "c" })).toThrow("이름");
  });

  it("MCP 서버를 넣고 끄고 켜고 뺀다 (키 값은 목록에 보이지 않는다)", () => {
    changeMcp(home, { action: "add", name: "exa", url: "https://mcp.exa.ai/mcp" });
    changeMcp(home, { action: "add", name: "local", command: "npx", args: ["-y", "srv"] });
    expect(() => changeMcp(home, { action: "add", name: "exa", url: "https://x" })).toThrow("이미");
    expect(() => changeMcp(home, { action: "add", name: "bad", url: "file:///etc" })).toThrow("http");
    changeMcp(home, { action: "disable", name: "exa" });
    expect(listResources(home).mcpServers).toEqual([
      { name: "exa", enabled: false, target: "https://mcp.exa.ai/mcp", hasSecrets: false },
      { name: "local", enabled: true, target: "npx -y srv", hasSecrets: false },
    ]);
    changeMcp(home, { action: "enable", name: "exa" });
    changeMcp(home, { action: "remove", name: "local" });
    expect(JSON.parse(readFileSync(join(home, "mcp.json"), "utf8"))).toEqual({ mcpServers: { exa: { url: "https://mcp.exa.ai/mcp" } } });
  });

  it("패키지 출처는 npm·git·https만", () => {
    expect(validPackageSource("npm:pi-web-access")).toBe(true);
    expect(validPackageSource("./x")).toBe(false);
    expect(validPackageSource("npm:a; rm -rf /")).toBe(false);
  });

  it("툴: 목록을 돌려주고, 묻기가 켜져 있는데 물을 화면이 없으면 바꾸지 않는다", async () => {
    const tools = load();
    expect([...tools.keys()].sort()).toEqual(["mcp_server", "pi_package", "resource_delete", "resource_save", "resources_list"]);
    const listed = await tools.get("resources_list")!.execute("1", {});
    expect(JSON.parse(listed.content[0]!.text).home).toBe(home);
    const declined = await tools.get("resource_save")!.execute("2", { kind: "prompt", name: "a", description: "d", content: "c" }, undefined, undefined, { hasUI: false });
    expect(declined.content[0]!.text).toContain("저장하지 않기로");
    expect(existsSync(join(home, "prompts", "a.md"))).toBe(false);
  });

  it("툴: 확인을 받으면 저장한다. PI_RESOURCES_CONFIRM=0이면 묻지 않는다 (Agent는 permissions가 묻는다)", async () => {
    let asked = 0;
    const ui = { hasUI: true, ui: { confirm: async () => (asked++, true) } };
    await load().get("resource_save")!.execute("1", { kind: "prompt", name: "a", description: "d", content: "c" }, undefined, undefined, ui);
    expect(asked).toBe(1);
    process.env.PI_RESOURCES_CONFIRM = "0";
    process.env.PI_RESOURCES_NO_SKILL = "1";
    const tools = load();
    await tools.get("mcp_server")!.execute("2", { action: "add", name: "exa", url: "https://mcp.exa.ai/mcp" }, undefined, undefined, ui);
    expect(asked).toBe(1);
    await expect(tools.get("resource_save")!.execute("3", { kind: "skill", name: "s", description: "d", content: "c" }, undefined, undefined, ui)).rejects.toThrow("저장할 수 없는");
  });
});
