import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendProposal, makeProposal, type InstallProposal } from "@pi-desktop/mate-kit";
import { readMcpFile } from "@pi-desktop/pi-isolation/mcp-file";
import { applyInstall, describeInstall, installHints } from "../src/install";
import { itemButtons, shouldNotify } from "../src/remote/messages";
import { matePaths, type MatePaths } from "../src/paths";
import { getDuty, loadInboxState, saveDuty } from "../src/store";

const SKILL = "---\nname: hn-summary\ndescription: HN 글을 세 줄로 요약한다\n---\n1. 제목을 본다\n";

async function setup(dutySkills?: string[]) {
  const base = await mkdtemp(join(tmpdir(), "mate-install-"));
  const paths: MatePaths = matePaths(join(base, "mate"));
  const env = { PI_CODING_AGENT_DIR: join(base, "pi"), PI_DESKTOP_AGENT_HOME: join(base, "agent") };
  await saveDuty(paths, { id: "hn", name: "HN 요약", cwd: base, prompt: "p", profile: "propose", trigger: { kind: "manual" }, ...(dutySkills ? { skills: dutySkills } : {}) });
  let n = 0;
  const propose = async (install: InstallProposal) => {
    // 같은 제목·요약은 인박스가 중복으로 거르므로 번호를 붙인다
    const item = makeProposal({ title: `설치 ${install.kind} ${++n}`, summary: "필요하다", install }, { dutyId: "hn", runId: "r1" });
    await appendProposal(paths.inbox, item);
    return item.id;
  };
  return { base, paths, env, propose };
}

describe("휴대폰의 설치 제안", () => {
  it("적용·버리기 버튼과 자세히를 붙이고, 알림 대상으로 본다", () => {
    const item = makeProposal({ title: "스킬", summary: "s", install: { kind: "mcp", preset: "exa" } }, { dutyId: "hn", runId: "r" });
    const buttons = itemButtons(item, { sendDetail: true, allowFix: false }).flat().map((b) => b.text);
    expect(buttons).toEqual(["적용", "버리기", "자세히"]);
    expect(shouldNotify(item, "action")).toBe(true);
  });
});

describe("설치 제안 적용", () => {
  it("스킬 초안은 skills/<이름>/SKILL.md로 넣고, 골라 쓰는 임무에 더하며, 같은 이름은 덮어쓰지 않는다", async () => {
    const { paths, propose } = await setup(["other"]);
    const id = await propose({ kind: "skill", name: "hn-summary", content: SKILL });
    expect(await describeInstall({ kind: "skill", name: "hn-summary", content: SKILL })).toContain("HN 글을 세 줄로");
    expect(await applyInstall(paths, id)).toContain("hn-summary");
    expect(readFileSync(join(paths.skills, "hn-summary", "SKILL.md"), "utf8")).toBe(SKILL);
    expect((await getDuty(paths, "hn"))!.skills).toEqual(["other", "hn-summary"]);
    expect((await loadInboxState(paths))[id]?.status).toBe("applied");

    const again = await propose({ kind: "skill", name: "hn-summary", content: SKILL.replace("세 줄", "다섯 줄") });
    await expect(applyInstall(paths, again)).rejects.toThrow(/덮어쓰지 않았습니다/);
    expect(readFileSync(join(paths.skills, "hn-summary", "SKILL.md"), "utf8")).toBe(SKILL);
  });

  it("MCP 서버는 목록의 것만 넣고 임무가 고르게 한다. 키가 필요한 서버는 꺼 둔 채 넣는다", async () => {
    const { paths, propose } = await setup();
    await applyInstall(paths, await propose({ kind: "mcp", preset: "exa" }));
    const message = await applyInstall(paths, await propose({ kind: "mcp", preset: "brave" }));
    expect(message).toContain("키를 넣으면");
    const file = await readMcpFile(paths.mcp);
    expect(file.mcpServers?.exa).toMatchObject({ url: "https://mcp.exa.ai/mcp" });
    expect(file.mcpServers?.exa?.enabled).toBeUndefined();
    expect(file.mcpServers?.["brave-search"]).toMatchObject({ command: "npx", enabled: false });
    expect((await getDuty(paths, "hn"))!.mcpServers).toEqual(["exa", "brave-search"]);
    // "전부" 쓰는 임무의 스킬은 그대로 둔다
    expect((await getDuty(paths, "hn"))!.skills).toBeUndefined();

    await expect(applyInstall(paths, await propose({ kind: "mcp", preset: "unknown-server" }))).rejects.toThrow(/목록에 없는/);
  });

  it("다른 앱의 스킬은 원본을 그대로 두고 Mate 홈으로 복사한다", async () => {
    const { paths, env, propose } = await setup();
    const source = join(env.PI_DESKTOP_AGENT_HOME, "skills", "weekly-report");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "---\nname: weekly-report\ndescription: 주간 보고\n---\nx\n");
    expect(await installHints(paths, env)).toEqual(expect.arrayContaining([expect.stringContaining("weekly-report")]));
    const id = await propose({ kind: "copy", from: "agent", name: "weekly-report" });
    expect(await describeInstall({ kind: "copy", from: "agent", name: "weekly-report" }, env)).toContain("주간 보고");
    await applyInstall(paths, id, env);
    expect(existsSync(join(paths.skills, "weekly-report", "SKILL.md"))).toBe(true);
    expect(existsSync(join(source, "SKILL.md"))).toBe(true);
    // 이미 Mate에 있으면 안내에서 빠진다
    expect((await installHints(paths, env)).join("\n")).not.toContain("weekly-report");

    await expect(applyInstall(paths, await propose({ kind: "copy", from: "pi-desktop", name: "none" }), env)).rejects.toThrow(/찾지 못했습니다/);
  });
});
