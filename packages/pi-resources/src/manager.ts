import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { deleteSkill, listSkillsIn, saveSkill } from "@pi-desktop/agent-kit/skills";
import type { SkillInput, SkillView } from "@pi-desktop/agent-kit/skill-types";
import { readMcpFile, serverViews, updateMcpFile, withEnabled, withoutServer, withPreset } from "@pi-desktop/pi-isolation/mcp-file";
import { WEB_SEARCH_PRESETS, type McpCheckResult, type McpServerView } from "@pi-desktop/pi-isolation/mcp-presets";

/**
 * Pi의 확장 가능한 데이터를 관리하는 공용 코드 (설계 DESIGN-APPS.md §3.5 "관리 코드는 함께 쓴다").
 *
 * 세 앱은 데이터를 따로 둔다 (§2). 대신 관리하는 코드는 하나로 두고, 앱마다 **어느 홈을 관리하는지**만 바꿔 쓴다.
 * - Agent: `~/.pi-desktop-agent`, Mate: `~/.pi-desktop-mate` (스킬 `skills/`, MCP `mcp.json`)
 *
 * 낮은 단계의 저장 코드는 Pi가 실행 중에 소스 그대로 불러오는 곳에 남겨 둔다
 * (스킬 저장: agent-kit의 skill_save 확장, MCP 설정 읽기: pi-isolation 확장). 이 패키지는 앱(데몬·실행기·화면)이 번들해 쓴다.
 */

/** 그 호스트의 Pi를 띄우는 명령 (node + cli.js) */
export interface PiRun {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
}

export interface ResourceHomeOptions {
  /** 관리할 홈 (스킬은 `<home>/skills`, MCP는 `<home>/mcp.json`) */
  home: string;
  /** 지운 스킬을 옮길 폴더. deleteSkill을 주지 않을 때 쓴다 */
  skillsTrash?: string;
  /** 앱이 스킬을 지우는 방법을 따로 가질 때 (예: Mate는 자기 휴지통으로 옮긴다) */
  deleteSkill?: (name: string) => Promise<void>;
  /** 연결 확인(pi mcp list)에 쓸 Pi. 인자는 앱이 넘긴 것을 그대로 준다 (Agent의 개발용 덮어쓰기 등) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi: (overrides?: any) => Promise<PiRun>;
}

/** 한 홈의 스킬·MCP 관리 메서드. 이름은 앱의 API 이름과 같다 */
export interface ResourceHome {
  skillsList(): Promise<SkillView[]>;
  skillSave(previous: string | undefined, input: SkillInput): Promise<void>;
  skillDelete(name: string): Promise<void>;
  skillsDir(): Promise<string>;
  mcpList(): Promise<McpServerView[]>;
  mcpAddPreset(id: string, key?: string): Promise<McpServerView[]>;
  mcpSetEnabled(name: string, enabled: boolean): Promise<McpServerView[]>;
  mcpRemove(name: string): Promise<McpServerView[]>;
  /** 없으면 빈 설정을 만들고 경로를 돌려준다 (로컬이면 앱이 연다) */
  mcpEnsureFile(): Promise<string>;
  /**
   * pi mcp list: 켜진 서버마다 연결해 상태·도구·오류를 찍고, 연결 안 된 것이 있으면 1로 끝난다.
   * pi mcp는 Pi 설정 폴더의 mcp.json만 읽으므로 이 실행에서만 설정 폴더를 이 홈으로 바꾼다.
   * 그래서 OAuth 로그인이 필요한 서버는 로그인 안 됨으로 보일 수 있다 (세션은 Pi의 mcp-auth.json을 쓴다, pi-isolation 참고)
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mcpCheck(overrides?: any): Promise<McpCheckResult>;
}

export function resourceHome(options: ResourceHomeOptions): ResourceHome {
  const skills = join(options.home, "skills");
  const mcp = join(options.home, "mcp.json");
  return {
    skillsList: () => listSkillsIn(skills),
    skillSave: async (previous, input) => void (await saveSkill(skills, input, previous)),
    skillDelete: async (name) => {
      if (options.deleteSkill) return options.deleteSkill(name);
      if (!options.skillsTrash) throw new Error("지운 스킬을 둘 곳이 정해지지 않았습니다");
      await deleteSkill(skills, name, options.skillsTrash);
    },
    skillsDir: async () => skills,

    mcpList: async () => serverViews(await readMcpFile(mcp)),
    mcpAddPreset: async (id, key) => {
      const preset = WEB_SEARCH_PRESETS.find((p) => p.id === id);
      if (!preset) throw new Error(`목록에 없는 서버입니다: ${id}`);
      return updateMcpFile(mcp, (file) => withPreset(file, preset, key));
    },
    mcpSetEnabled: (name, enabled) => updateMcpFile(mcp, (file) => withEnabled(file, name, enabled === true)),
    mcpRemove: (name) => updateMcpFile(mcp, (file) => withoutServer(file, name)),
    mcpEnsureFile: async () => {
      await updateMcpFile(mcp, (file) => ({ mcpServers: {}, ...file }));
      return mcp;
    },
    mcpCheck: async (overrides) => {
      const run = await options.pi(overrides);
      await mkdir(options.home, { recursive: true });
      return new Promise<McpCheckResult>((done) => {
        execFile(
          run.command,
          [...run.args, "mcp", "list"],
          { cwd: options.home, env: { ...run.env, PI_CODING_AGENT_DIR: options.home }, timeout: 120_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
          (error, stdout, stderr) => done({ ok: !error, output: `${stdout}${stderr ? `\n${stderr}` : ""}` }),
        );
      });
    },
  };
}
