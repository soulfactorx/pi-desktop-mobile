import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { installError, readInbox, type InboxItem, type InstallProposal } from "@pi-desktop/mate-kit";
import { readMcpFile, updateMcpFile } from "@pi-desktop/pi-isolation/mcp-file";
import { WEB_SEARCH_PRESETS as MCP_PRESETS, type McpPreset } from "@pi-desktop/pi-isolation/mcp-presets";
import type { MatePaths } from "./paths";
import { getDuty, saveDuty, setInboxStatus } from "./store";

/**
 * Mate가 제안한 설치를 적용한다 (설계 DESIGN-APPS.md §3.4 "Mate가 제안해서 만들기·추가하기", DESIGN-MATE.md §5).
 * 모델은 제안만 남기고, 사용자가 앱·휴대폰에서 적용하면 여기서 Mate 홈에 넣는다.
 * - 같은 이름의 스킬이 있으면 덮어쓰지 않는다
 * - MCP 서버는 정해 둔 목록의 것만. 키가 필요하면 꺼 둔 채 넣고, 키는 사용자가 스킬·MCP 탭에서 넣는다
 * - 다른 앱의 스킬은 읽기만 하고 Mate 홈으로 복사한다. MCP 설정은 토큰이 섞일 수 있어 복사하지 않는다
 * 적용하면 그 제안을 남긴 임무가 넣은 것을 쓰도록 고른다.
 */

/** 다른 앱의 스킬 폴더 (DESIGN-APPS.md §3) */
export function otherSkillsDir(from: "pi-desktop" | "agent", env: NodeJS.ProcessEnv = process.env): string {
  if (from === "agent") return join(env.PI_DESKTOP_AGENT_HOME || join(homedir(), ".pi-desktop-agent"), "skills");
  return join(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "skills");
}

const exists = (path: string) => stat(path).then(() => true, () => false);

export function findPreset(id: string): McpPreset | undefined {
  return MCP_PRESETS.find((p) => p.id === id);
}

/** 적용 전에 사용자에게 보일 설명 (Markdown). 앱 카드와 휴대폰 "자세히"에 쓴다 */
export async function describeInstall(install: InstallProposal, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  switch (install.kind) {
    case "skill":
      return [`**새 스킬** \`${install.name}\` (Mate 홈 skills/${install.name}/SKILL.md)`, "", "```markdown", install.content.trim(), "```"].join("\n");
    case "mcp": {
      const preset = findPreset(install.preset);
      if (!preset) return `정해 둔 목록에 없는 MCP 서버입니다: ${install.preset} (적용할 수 없습니다)`;
      const target = typeof preset.entry.url === "string" ? `주소 ${preset.entry.url}` : `명령 \`${[preset.entry.command, ...((preset.entry.args as string[] | undefined) ?? [])].join(" ")}\``;
      return [
        `**MCP 서버 추가** ${preset.label} (mcp.json의 \`${preset.name}\`)`,
        `- ${target}`,
        `- ${preset.detail}`,
        preset.keyEnv ? `- 키(${preset.keyEnv})가 필요합니다. 꺼 둔 채 넣고, 스킬·MCP 탭에서 키를 넣으면 켜집니다` : "- 키 없이 씁니다",
        "- 넣어도 도구는 처음 쓸 때 다시 허용을 묻습니다",
      ].join("\n");
    }
    case "copy": {
      const dir = join(otherSkillsDir(install.from, env), install.name);
      const content = await readFile(join(dir, "SKILL.md"), "utf8").catch(() => undefined);
      const app = install.from === "agent" ? "Pi Desktop Agent" : "Pi Desktop";
      if (content === undefined) return `${app}의 스킬 \`${install.name}\`을(를) 찾지 못했습니다 (${dir})`;
      return [`**${app}의 스킬 복사** \`${install.name}\``, `- 원본: ${dir} (원본은 그대로 둡니다)`, "", "```markdown", content.trim(), "```"].join("\n");
    }
  }
}

/** 인박스 항목의 설치를 적용하고, 사용자에게 보일 한 줄을 돌려준다 */
export async function applyInstall(paths: MatePaths, itemId: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const item = (await readInbox(paths.inbox)).find((i) => i.id === itemId);
  if (!item?.install) throw new Error("적용할 설치 제안을 찾지 못했습니다");
  const install = item.install;
  const invalid = installError(install);
  if (invalid) throw new Error(invalid);
  let message: string;
  switch (install.kind) {
    case "skill": {
      const dir = join(paths.skills, install.name);
      if (await exists(dir)) throw new Error(`같은 이름의 스킬(${install.name})이 이미 있어 덮어쓰지 않았습니다. 스킬·MCP 탭에서 확인하고 고쳐 주세요`);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), `${install.content.trim()}\n`, "utf8");
      await pickForDuty(paths, item, { skill: install.name });
      message = `스킬 ${install.name}을(를) 넣었어요`;
      break;
    }
    case "mcp": {
      const preset = findPreset(install.preset);
      if (!preset) throw new Error(`정해 둔 목록에 없는 MCP 서버입니다: ${install.preset}`);
      const current = await readMcpFile(paths.mcp);
      if (!current.mcpServers?.[preset.name]) {
        // 키가 필요한 서버는 키가 없으면 돌지 않으므로 꺼 둔다. 키는 사용자가 스킬·MCP 탭에서 넣는다
        const entry = { ...preset.entry, ...(preset.keyEnv ? { enabled: false } : {}) };
        await updateMcpFile(paths.mcp, (file) => ({ ...file, mcpServers: { ...file.mcpServers, [preset.name]: entry } }));
      }
      await pickForDuty(paths, item, { server: preset.name });
      message = preset.keyEnv ? `MCP 서버 ${preset.label}을(를) 넣었어요. 스킬·MCP 탭에서 키를 넣으면 켜져요` : `MCP 서버 ${preset.label}을(를) 넣었어요`;
      break;
    }
    case "copy": {
      const from = join(otherSkillsDir(install.from, env), install.name);
      if (!(await exists(join(from, "SKILL.md")))) throw new Error(`복사할 스킬을 찾지 못했습니다: ${from}`);
      const to = join(paths.skills, install.name);
      if (await exists(to)) throw new Error(`같은 이름의 스킬(${install.name})이 이미 있어 복사하지 않았습니다`);
      await mkdir(paths.skills, { recursive: true });
      await cp(from, to, { recursive: true, errorOnExist: true, force: false });
      await pickForDuty(paths, item, { skill: install.name });
      message = `스킬 ${install.name}을(를) Mate로 복사했어요`;
      break;
    }
  }
  await setInboxStatus(paths, [itemId], "applied");
  return message;
}

/**
 * 제안을 남긴 임무가 넣은 것을 쓰도록 고른다. 스킬을 "전부" 쓰는 임무는 그대로 두고(이미 포함), 골라 쓰는 임무만 더한다.
 * MCP 서버는 임무의 서버 목록에 더한다. 관찰자처럼 파일이 없는 임무면 아무것도 하지 않는다.
 */
async function pickForDuty(paths: MatePaths, item: InboxItem, add: { skill?: string; server?: string }): Promise<void> {
  const duty = await getDuty(paths, item.dutyId).catch(() => undefined);
  if (!duty) return;
  const next = { ...duty };
  if (add.skill && duty.skills && !duty.skills.includes(add.skill)) next.skills = [...duty.skills, add.skill];
  if (add.server && !(duty.mcpServers ?? []).includes(add.server)) next.mcpServers = [...(duty.mcpServers ?? []), add.server];
  if (next.skills !== duty.skills || next.mcpServers !== duty.mcpServers) await saveDuty(paths, { ...next, updatedAt: Date.now() });
}

/**
 * 임무 실행의 시스템 안내에 붙일 설치 안내: 넣을 수 있는 MCP 서버 목록과, 다른 앱에만 있는 스킬.
 * 모델이 목록 밖의 서버나 없는 스킬을 제안하지 않게 한다.
 */
export async function installHints(paths: MatePaths, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const mine = new Set(await readdir(paths.skills).catch(() => [] as string[]));
  const servers = new Set(Object.keys((await readMcpFile(paths.mcp).catch(() => ({ mcpServers: {} }))).mcpServers ?? {}));
  const presets = MCP_PRESETS.filter((p) => !servers.has(p.name)).map((p) => `${p.id}(${p.label})`);
  const lines: string[] = [];
  if (presets.length) lines.push(`- 넣을 수 있는 MCP 서버 (install.kind=mcp의 preset): ${presets.join(", ")}. 이 목록 밖의 서버는 제안하지 마라.`);
  for (const from of ["pi-desktop", "agent"] as const) {
    const names = (await readdir(otherSkillsDir(from, env)).catch(() => [] as string[])).filter((n) => !mine.has(n) && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(n)).slice(0, 20);
    if (names.length) lines.push(`- ${from === "agent" ? "Agent" : "Pi Desktop"}에만 있는 스킬 (install.kind=copy, from=${from}): ${names.join(", ")}`);
  }
  return lines;
}
