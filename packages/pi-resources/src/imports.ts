import { existsSync } from "node:fs";
import { cp, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { listSkillsIn } from "@pi-desktop/agent-kit/skills";
import { listPackages } from "./packages";
import type { AppHome, AppId, Importables, ImportablePackage, ImportableSkill } from "./types";

/**
 * 다른 앱에서 가져오기 (설계 DESIGN-APPS.md §3.4 "다른 앱에서 복사", §3.5 2단계).
 * 데이터는 앱마다 따로 두므로 함께 쓰지 않고 **복사**한다. 다른 앱의 파일은 읽기만 한다.
 * - 스킬: 폴더째 이 홈의 skills/로 복사한다 (같은 이름이 있으면 하지 않는다)
 * - 패키지: 같은 출처를 이 홈에 새로 설치한다 (설치본을 복사하지 않는다)
 * - MCP는 토큰이 섞일 수 있어 가져오지 않는다. 같은 서버를 이 앱에서 새로 넣는다
 */

/** 이 호스트의 세 앱 홈 (각 앱이 쓰는 환경 변수를 따른다) */
export function appHomes(env: NodeJS.ProcessEnv = process.env, home = homedir()): AppHome[] {
  return [
    { app: "desktop", label: "Pi Desktop", home: env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent") },
    { app: "agent", label: "Agent", home: env.PI_DESKTOP_AGENT_HOME || join(home, ".pi-desktop-agent") },
    { app: "mate", label: "Mate", home: env.MATE_HOME || join(home, ".pi-desktop-mate") },
  ];
}

/** 다른 앱들에 있는 스킬·패키지 (이 홈과 같은 곳은 뺀다) */
export async function listImportables(home: string, others: readonly AppHome[]): Promise<Importables> {
  const mine = resolve(home);
  const sources = others.filter((o) => resolve(o.home) !== mine);
  const ownSkills = new Set((await listSkillsIn(join(home, "skills")).catch(() => [])).map((s) => s.name));
  const ownPackages = new Set((await listPackages(home)).map((p) => p.source));
  const skills: ImportableSkill[] = [];
  const packages: ImportablePackage[] = [];
  for (const other of sources) {
    for (const s of await listSkillsIn(join(other.home, "skills")).catch(() => [])) {
      skills.push({ from: other.app, fromLabel: other.label, name: s.name, description: s.description, exists: ownSkills.has(s.name) });
    }
    for (const p of await listPackages(other.home)) {
      packages.push({ from: other.app, fromLabel: other.label, source: p.source, name: p.name, exists: ownPackages.has(p.source) });
    }
  }
  return { skills, packages };
}

/** 다른 앱의 스킬 폴더를 이 홈으로 복사한다 */
export async function importSkill(home: string, others: readonly AppHome[], from: AppId, name: string): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error(`스킬 이름이 올바르지 않습니다: ${name}`);
  const source = others.find((o) => o.app === from);
  if (!source) throw new Error(`모르는 앱입니다: ${from}`);
  const sourceDir = join(source.home, "skills", name);
  if (!(await stat(sourceDir).catch(() => undefined))?.isDirectory()) throw new Error(`${source.label}에 ${name} 스킬이 없습니다`);
  const target = join(home, "skills", name);
  if (existsSync(target)) throw new Error(`이미 ${name} 스킬이 있습니다. 먼저 지우거나 이름을 바꾸세요`);
  await cp(sourceDir, target, { recursive: true, errorOnExist: true, force: false });
  // 복사본이 비어 있으면(읽기 실패 등) 알린다
  if ((await readdir(target)).length === 0) throw new Error(`${name} 스킬을 복사하지 못했습니다`);
}
