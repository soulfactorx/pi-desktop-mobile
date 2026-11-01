import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resourceHome } from "../src/manager";

const noPi = async () => {
  throw new Error("이 시험에서는 Pi를 띄우지 않는다");
};

describe("resourceHome", () => {
  it("한 홈의 스킬을 만들고 고치고 휴지통으로 지운다", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-resources-"));
    const trash = join(home, "trash");
    const r = resourceHome({ home, skillsTrash: trash, pi: noPi });
    expect(await r.skillsDir()).toBe(join(home, "skills"));
    expect(await r.skillsList()).toEqual([]);

    await r.skillSave(undefined, { name: "weekly-report", description: "주간 보고", instructions: "1. 본다", modelInvocation: true });
    await r.skillSave("weekly-report", { name: "weekly-report", description: "주간 보고서", instructions: "1. 본다\n2. 쓴다", modelInvocation: false });
    const [skill] = await r.skillsList();
    expect(skill).toMatchObject({ name: "weekly-report", description: "주간 보고서", modelInvocation: false });

    await r.skillDelete("weekly-report");
    expect(await r.skillsList()).toEqual([]);
    expect(readdirSync(trash).length).toBe(1);
  });

  it("앱이 준 방법으로 스킬을 지운다 (Mate 휴지통)", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-resources-"));
    const removed: string[] = [];
    const r = resourceHome({ home, deleteSkill: async (name) => void removed.push(name), pi: noPi });
    await r.skillDelete("x");
    expect(removed).toEqual(["x"]);
  });

  it("홈의 mcp.json에 미리 설정한 서버를 넣고 켜고 끄고 뺀다", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-resources-"));
    const r = resourceHome({ home, skillsTrash: join(home, "trash"), pi: noPi });
    expect(await r.mcpList()).toEqual([]);

    const added = await r.mcpAddPreset("exa");
    expect(added).toEqual([expect.objectContaining({ name: "exa", enabled: true })]);
    expect(JSON.parse(readFileSync(join(home, "mcp.json"), "utf8")).mcpServers.exa.url).toContain("exa.ai");

    expect((await r.mcpSetEnabled("exa", false))[0]?.enabled).toBe(false);
    expect(await r.mcpRemove("exa")).toEqual([]);
    await expect(r.mcpAddPreset("nope")).rejects.toThrow("목록에 없는 서버");
  });

  it("mcp.json이 없으면 빈 설정을 만들고 경로를 돌려준다", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-resources-"));
    const r = resourceHome({ home, skillsTrash: join(home, "trash"), pi: noPi });
    const path = await r.mcpEnsureFile();
    expect(path).toBe(join(home, "mcp.json"));
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ mcpServers: {} });
  });

  it("mcp.json 원문을 앱 안에서 읽고 고쳐 저장한다. 틀린 JSON은 저장하지 않는다", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-resources-"));
    const r = resourceHome({ home, skillsTrash: join(home, "trash"), pi: noPi });
    const { path, text } = await r.mcpReadText();
    expect(JSON.parse(text)).toEqual({ mcpServers: {} });
    const views = await r.mcpWriteText(JSON.stringify({ mcpServers: { mine: { command: "npx", args: ["-y", "my-mcp"] } } }));
    expect(views.map((v) => v.name)).toEqual(["mine"]);
    await expect(r.mcpWriteText("{ 틀림")).rejects.toThrow("JSON 형식이 아닙니다");
    await expect(r.mcpWriteText(JSON.stringify({ mcpServers: [] }))).rejects.toThrow("mcpServers");
    expect(JSON.parse(readFileSync(path, "utf8")).mcpServers.mine.command).toBe("npx");
  });
});
