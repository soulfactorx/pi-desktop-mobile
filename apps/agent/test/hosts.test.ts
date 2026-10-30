import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { collectKit } from "@pi-desktop/host-deploy";
import { agentRemoteApp, remoteExtensionEntries } from "../src/main/hosts";

const repo = resolve(__dirname, "../../..");
const kitDir = join(repo, "packages/agent-kit");
const isolationDir = join(repo, "packages/pi-isolation");

describe("원격 호스트에 kit 올리기", () => {
  it("agent-kit·pi-isolation의 설치본 범위만 모으고, 내용이 같으면 해시도 같다", async () => {
    const kit = agentRemoteApp({ agentScript: "x", agentVersion: "0", kitDir, isolationDir }).kit;
    const a = await kit();
    const b = await collectKit([{ name: "agent-kit", dir: kitDir }, { name: "pi-isolation", dir: isolationDir }]);
    expect(a.hash).toBe(b.hash);
    const rels = a.files.map((f) => f.rel);
    expect(rels).toContain("agent-kit/package.json");
    expect(rels).toContain("agent-kit/extensions/permissions/index.ts");
    expect(rels).toContain("pi-isolation/extensions/mcp.ts");
    expect(rels.some((r) => r.includes("/test/") || r.includes("node_modules"))).toBe(false);
  });

  it("원격 확장 경로는 로컬 package.json의 목록을 그 호스트 경로로 바꾼다", async () => {
    const entries = await remoteExtensionEntries(kitDir, "/home/u/.pi-desktop-agent/kits/h/agent-kit");
    expect(entries[0]).toBe("/home/u/.pi-desktop-agent/kits/h/agent-kit/extensions/agent-core/index.ts");
    expect(entries.every((e) => e.startsWith("/home/u/"))).toBe(true);
  });
});
