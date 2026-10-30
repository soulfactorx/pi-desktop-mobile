import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extensionArgs, extensionEntries, KIT_VERSION } from "../src/index";

const kitDir = resolve(fileURLToPath(new URL("..", import.meta.url)));

describe("agent-kit 매니페스트", () => {
  it("KIT_VERSION이 package.json의 version과 같다", () => {
    const manifest = JSON.parse(readFileSync(join(kitDir, "package.json"), "utf8")) as { version: string };
    expect(KIT_VERSION).toBe(manifest.version);
  });

  it("pi.extensions를 절대 경로로 읽고 -e 인자로 바꾼다", async () => {
    const entries = await extensionEntries(kitDir);
    expect(entries).toEqual([
      join(kitDir, "extensions", "agent-core", "index.ts"),
      join(kitDir, "extensions", "permissions", "index.ts"),
      join(kitDir, "extensions", "loop-guard", "index.ts"),
      join(kitDir, "extensions", "local-model", "index.ts"),
      join(kitDir, "extensions", "ask-user", "index.ts"),
      join(kitDir, "extensions", "web", "index.ts"),
      join(kitDir, "extensions", "memory", "index.ts"),
      join(kitDir, "extensions", "documents", "index.ts"),
      join(kitDir, "extensions", "tasks", "index.ts"),
      join(kitDir, "extensions", "schedule", "index.ts"),
      join(kitDir, "extensions", "elevation", "index.ts"),
      join(kitDir, "extensions", "peers", "index.ts"),
      join(kitDir, "extensions", "skills", "index.ts"),
    ]);
    expect(extensionArgs(entries)).toEqual(entries.flatMap((entry) => ["-e", entry]));
  });

  it("pi.extensions가 없거나 절대 경로면 거절한다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-kit-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    await expect(extensionEntries(dir)).rejects.toThrow(/pi.extensions/);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ pi: { extensions: [join(dir, "a.ts")] } }));
    await expect(extensionEntries(dir)).rejects.toThrow(/잘못된 확장 경로/);
  });
});
