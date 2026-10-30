import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseMcpFile, readMcpFile, serverViews, updateMcpFile, withEnabled, withoutServer, withPreset } from "../src/mcp-file";
import { WEB_SEARCH_PRESETS, validServerName } from "../src/mcp-presets";

const preset = (id: string) => WEB_SEARCH_PRESETS.find((p) => p.id === id)!;

describe("MCP 설정 (mcp.json)", () => {
  it("화면용 모양: 명령·주소, 꺼짐, 키는 있다는 것만", () => {
    const file = parseMcpFile(
      JSON.stringify({
        mcpServers: {
          fs: { command: "npx", args: ["-y", "server-fs", "."], enabled: false },
          docs: { url: "https://example.com/mcp", headers: { Authorization: "Bearer secret" }, description: "문서" },
        },
      }),
    );
    expect(serverViews(file)).toEqual([
      { name: "fs", kind: "command", target: "npx -y server-fs .", enabled: false, hasSecrets: false },
      { name: "docs", kind: "url", target: "https://example.com/mcp", enabled: true, description: "문서", hasSecrets: true },
    ]);
    expect(JSON.stringify(serverViews(file))).not.toContain("secret");
  });

  it("미리 정한 서버 넣기: 키가 필요한 서버는 env에, 없으면 거절", () => {
    const withExa = withPreset({}, preset("exa"));
    expect(withExa.mcpServers?.exa).toMatchObject({ url: "https://mcp.exa.ai/mcp" });
    expect(() => withPreset({}, preset("brave"))).toThrow(/API 키/);
    const withBrave = withPreset(withExa, preset("brave"), "  key-1 ");
    expect(withBrave.mcpServers?.["brave-search"]).toMatchObject({ command: "npx", env: { BRAVE_API_KEY: "key-1" } });
    expect(Object.keys(withBrave.mcpServers ?? {})).toEqual(["exa", "brave-search"]);
  });

  it("켜기·끄기는 enabled 칸만 바꾸고, 빼기는 그 서버만 뺀다. 모르는 칸은 그대로", () => {
    const file = { other: { keep: true }, mcpServers: { a: { url: "u", timeout: 30 }, b: { command: "c" } } };
    const off = withEnabled(file, "a", false);
    expect(off.mcpServers?.a).toEqual({ url: "u", timeout: 30, enabled: false });
    expect(withEnabled(off, "a", true).mcpServers?.a).toEqual({ url: "u", timeout: 30 });
    expect(() => withEnabled(file, "nope", true)).toThrow(/없습니다/);
    expect(withoutServer(file, "a")).toEqual({ other: { keep: true }, mcpServers: { b: { command: "c" } } });
  });

  it("파일: 없으면 빈 설정, 깨져 있으면 덮어쓰지 않고 오류", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-"));
    const path = join(dir, "sub", "mcp.json");
    expect(await readMcpFile(path)).toEqual({});
    await updateMcpFile(path, (f) => withPreset(f, preset("exa")));
    expect(JSON.parse(readFileSync(path, "utf8")).mcpServers.exa.url).toBe("https://mcp.exa.ai/mcp");

    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{ 고치던 중");
    await expect(updateMcpFile(broken, (f) => f)).rejects.toThrow();
    expect(readFileSync(broken, "utf8")).toBe("{ 고치던 중");
  });

  it("서버 이름 규칙", () => {
    expect(WEB_SEARCH_PRESETS.every((p) => validServerName(p.name))).toBe(true);
    expect(validServerName("a b")).toBe(false);
  });
});
