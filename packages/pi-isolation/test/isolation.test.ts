import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isolationArgs, isolationEnv, isolationExtensionPaths } from "../src/index";
import { findContextFiles } from "../src/context-files";
import { filterMcpConfig, mcpToolPattern, parseMcpConfig } from "../src/mcp-config";

const temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

describe("isolationArgs", () => {
  it("앱 홈의 스킬·프롬프트만 올리고 Pi 기본 확장·문맥 파일을 끈다", () => {
    const args = isolationArgs({ home: "/h", isolationDir: "/iso", extensions: ["/kit/a.ts"], sessionDir: "/h/sessions" });
    expect(args.slice(0, 2)).toEqual(["--session-dir", "/h/sessions"]);
    expect(args).toContain("-ns");
    expect(args).toContain("-np");
    expect(args).toContain("-ne");
    expect(args).toContain("-nc");
    expect(args[args.indexOf("--skill") + 1]).toBe(join("/h", "skills"));
    expect(args[args.indexOf("--prompt-template") + 1]).toBe(join("/h", "prompts"));
    const extensions = args.flatMap((arg, i) => (arg === "-e" ? [args[i + 1]] : []));
    expect(extensions).toEqual(["/kit/a.ts", ...isolationExtensionPaths("/iso"), "builtin:codemode", "builtin:tool-search"]);
    expect(extensions).not.toContain("builtin:mcp");
  });

  it("mcp: false면 MCP 확장과 codemode·tool-search를 올리지 않는다", () => {
    const args = isolationArgs({ home: "/h", isolationDir: "/iso", extensions: ["/kit/a.ts"], mcp: false });
    const extensions = args.flatMap((arg, i) => (arg === "-e" ? [args[i + 1]] : []));
    expect(extensions).toEqual(["/kit/a.ts", resolve("/iso", "extensions/context.ts")]);
    expect(args).toContain("-ne");
  });

  it("skills를 주면 그 스킬 폴더만, 빈 배열이면 스킬 없이 올린다", () => {
    const pick = isolationArgs({ home: "/h", isolationDir: "/iso", extensions: [], skills: ["a", "b"] });
    expect(pick.flatMap((arg, i) => (arg === "--skill" ? [pick[i + 1]] : []))).toEqual([join("/h", "skills", "a"), join("/h", "skills", "b")]);
    const none = isolationArgs({ home: "/h", isolationDir: "/iso", extensions: [], skills: [] });
    expect(none).toContain("-ns");
    expect(none).not.toContain("--skill");
  });

  it("isolationEnv는 고른 MCP 서버와 노출 방식을 넘긴다", () => {
    expect(isolationEnv("/h", { mcpServers: ["a", "b"], mcpExposure: "direct" })).toEqual({
      PI_ISOLATION_HOME: "/h",
      PI_ISOLATION_MCP_SERVERS: "a,b",
      PI_ISOLATION_MCP_EXPOSURE: "direct",
    });
    expect(isolationEnv("/h", { mcpServers: [] })).toEqual({ PI_ISOLATION_HOME: "/h", PI_ISOLATION_MCP_SERVERS: "" });
  });

  it("remote면 이 PC가 Windows여도 다른 호스트의 경로를 /로 잇는다", () => {
    const args = isolationArgs({ home: "/home/u/.pi-desktop-agent", isolationDir: "/home/u/.pi-desktop-agent/kits/k/pi-isolation", extensions: [], skills: ["a"], remote: true });
    expect(args[args.indexOf("--skill") + 1]).toBe("/home/u/.pi-desktop-agent/skills/a");
    expect(args[args.indexOf("--prompt-template") + 1]).toBe("/home/u/.pi-desktop-agent/prompts");
    expect(args).toContain("/home/u/.pi-desktop-agent/kits/k/pi-isolation/extensions/context.ts");
  });

  it("세션 폴더를 주지 않으면 --session-dir를 붙이지 않는다", () => {
    expect(isolationArgs({ home: "/h", isolationDir: "/iso", extensions: [] })).not.toContain("--session-dir");
  });

  it("확장 경로는 패키지 폴더 기준이다", () => {
    expect(isolationExtensionPaths("/iso")).toEqual([resolve("/iso", "extensions/mcp.ts"), resolve("/iso", "extensions/context.ts")]);
    expect(isolationEnv("/h")).toEqual({ PI_ISOLATION_HOME: "/h" });
  });
});

describe("parseMcpConfig", () => {
  it("올바른 서버만 넣고 깨진 서버는 오류로 알린다", () => {
    const text = JSON.stringify({
      autoEnableCodemode: false,
      mcpServers: {
        exa: { url: "https://mcp.exa.ai/mcp" },
        brave: { command: "npx", args: ["-y", "brave"], enabled: false },
        "bad name": { command: "x" },
        nothing: {},
        "my-server": { command: "y" },
        my_server: { command: "z" },
      },
    });
    const loaded = parseMcpConfig("/h/mcp.json", text);
    expect(loaded.servers.map((s) => s.name)).toEqual(["exa", "brave", "my-server"]);
    expect(loaded.servers[1]).toMatchObject({ source: "/h/mcp.json", scope: "global", config: { enabled: false } });
    expect(loaded.autoEnableCodemode).toBe(false);
    expect(loaded.errors).toHaveLength(3);
    expect(loaded.errors.join("\n")).toContain('"my_server" conflicts with "my-server"');
  });

  it("없거나 빈 파일은 서버 없음, 깨진 JSON은 오류", () => {
    expect(parseMcpConfig("/m", undefined)).toEqual({ servers: [], errors: [] });
    expect(parseMcpConfig("/m", "{").errors).toHaveLength(1);
    expect(parseMcpConfig("/m", "[]").errors[0]).toContain("expected an object");
  });
});

describe("filterMcpConfig", () => {
  const loaded = parseMcpConfig("/m", JSON.stringify({ mcpServers: { "my-gh": { command: "x", exposure: "deferred", toolExposure: { t: "hidden" } }, other: { url: "https://o.example/mcp" } } }));

  it("고른 서버만 남기고, direct면 노출을 모두 direct로 바꾼다", () => {
    const filtered = filterMcpConfig(loaded, { servers: ["my-gh"], exposure: "direct" });
    expect(filtered.servers.map((s) => s.name)).toEqual(["my-gh"]);
    expect(filtered.servers[0]!.config).toEqual({ command: "x", exposure: "direct" });
    expect(filterMcpConfig(loaded, { servers: [] }).servers).toEqual([]);
    expect(filterMcpConfig(loaded, {}).servers).toHaveLength(2);
  });

  it("도구 이름 패턴은 Pi처럼 -를 _로 바꾼다", () => {
    expect(mcpToolPattern("my-gh")).toBe("mcp__my_gh__*");
  });
});

describe("findContextFiles", () => {
  it("앱 홈의 파일을 먼저, 작업 폴더는 위쪽 폴더부터 폴더마다 하나씩", () => {
    const home = temp("iso-home-");
    const root = temp("iso-root-");
    const child = join(root, "a", "b");
    mkdirSync(child, { recursive: true });
    writeFileSync(join(home, "AGENTS.md"), "﻿앱 지침");
    writeFileSync(join(root, "CLAUDE.md"), "루트");
    writeFileSync(join(root, "a", "AGENTS.md"), "a의 AGENTS");
    writeFileSync(join(root, "a", "CLAUDE.md"), "a의 CLAUDE (AGENTS.md가 있으면 안 읽음)");
    writeFileSync(join(child, "AGENTS.override.md"), "b 덮어쓰기");
    const files = findContextFiles(home, child);
    expect(files.map((f) => f.content)).toEqual(["앱 지침", "루트", "a의 AGENTS", "b 덮어쓰기"]);
  });

  it("앱 홈에 파일이 없으면 작업 폴더의 것만", () => {
    const root = temp("iso-root-");
    writeFileSync(join(root, "AGENTS.md"), "x");
    expect(findContextFiles(temp("iso-home-"), root).map((f) => f.path)).toEqual([join(root, "AGENTS.md")]);
  });
});
