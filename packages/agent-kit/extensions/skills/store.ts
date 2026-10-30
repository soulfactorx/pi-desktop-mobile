import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentHome } from "../../src/home";
import type { SkillInput, SkillView } from "./types";

export * from "./types";

/**
 * Pi 스킬 (Pi docs/skills.md, Agent Skills 규격). 스킬 하나 = <폴더>/SKILL.md (frontmatter name·description + 지시).
 *
 * 스킬은 앱 홈의 `skills/`(`~/.pi-desktop-agent/skills/`)에 둔다 (설계 DESIGN-APPS.md §3). 앱은 Pi를 `-ns --skill <이 폴더>`로
 * 띄우므로 Pi 설정 폴더·`~/.agents/skills/`·Pi 패키지의 스킬은 올라가지 않는다. 프로젝트 스킬(.pi/skills)도 같은 이유로 쓰지 않는다.
 * 지운 스킬은 바로 지우지 않고 agent-kit 상태 폴더의 skills-trash/로 옮긴다.
 *
 * desktop-agent의 스킬은 "다듬은 지시문을 다시 쓰기" 위한 앱 자체 기능이었다. Pi에는 같은 목적의 스킬이 이미 있으므로
 * 그 형식을 그대로 쓴다 (모델이 이름·설명을 보고 필요할 때 읽고, 사람은 /skill:이름으로 부른다).
 */

export function userSkillsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(agentHome(env), "skills");
}

/** 규격: 소문자·숫자·하이픈, 앞뒤·연속 하이픈 없음, 64자까지 */
export function validSkillName(name: string): boolean {
  return name.length > 0 && name.length <= 64 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name);
}

/** 사람이 적은 이름을 규격에 맞게 바꿔 본다 (예: "PDF Tools" → "pdf-tools"). 한글 등은 빠진다 */
export function toSkillName(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

const yamlString = (value: string) => (/^[^:#'"\n{}[\],&*!|>%@`]+$/.test(value) && value.trim() === value ? value : JSON.stringify(value));

export function formatSkill(input: SkillInput): string {
  const lines = [`name: ${input.name}`, `description: ${yamlString(input.description.replace(/\s+/g, " ").trim())}`];
  if (!input.modelInvocation) lines.push("disable-model-invocation: true");
  return `---\n${lines.join("\n")}\n---\n\n${input.instructions.trim()}\n`;
}

/** SKILL.md를 읽는다. frontmatter가 없거나 이름·설명이 없으면 undefined (Pi도 읽지 않는다) */
export function parseSkill(text: string): Omit<SkillInput, "name"> & { name?: string } | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return undefined;
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0 || /^\s/.test(line)) continue;
    let value = line.slice(colon + 1).trim();
    if (/^".*"$/.test(value)) {
      try {
        value = JSON.parse(value) as string;
      } catch {
        value = value.slice(1, -1);
      }
    } else if (/^'.*'$/.test(value)) value = value.slice(1, -1).replace(/''/g, "'");
    fields[line.slice(0, colon).trim()] = value;
  }
  if (!fields.description) return undefined;
  return {
    ...(fields.name ? { name: fields.name } : {}),
    description: fields.description,
    instructions: match[2]!.trim(),
    modelInvocation: fields["disable-model-invocation"] !== "true",
  };
}

/** 한 폴더 아래의 스킬들 (SKILL.md가 있는 하위 폴더, 한 단계 아래까지) */
async function scan(dir: string): Promise<SkillView[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const found: SkillView[] = [];
  for (const folder of names) {
    const file = join(dir, folder, "SKILL.md");
    try {
      if (!(await stat(file)).isFile()) continue;
      const parsed = parseSkill(await readFile(file, "utf8"));
      if (!parsed) continue;
      const files = (await readdir(join(dir, folder))).filter((n) => n !== "SKILL.md");
      found.push({
        name: parsed.name ?? folder,
        folder,
        description: parsed.description,
        instructions: parsed.instructions,
        modelInvocation: parsed.modelInvocation,
        path: file,
        extraFiles: files,
      });
    } catch {
      // SKILL.md가 없는 폴더는 스킬이 아니다
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

export async function listSkills(env: NodeJS.ProcessEnv = process.env): Promise<SkillView[]> {
  return scan(userSkillsDir(env));
}

/** 다른 앱 홈의 스킬 폴더를 읽는다 (Mate가 자기 홈의 skills/를 같은 형식으로 다룬다, DESIGN-APPS.md §3.4) */
export function listSkillsIn(dir: string): Promise<SkillView[]> {
  return scan(dir);
}

/**
 * 사용자 스킬을 만들거나 고친다. 이름을 바꾸면 폴더도 바꾼다(딸린 파일은 그대로 따라간다).
 * 다른 스킬과 이름이 겹치면 오류.
 */
export async function saveSkill(dir: string, input: SkillInput, previous?: string): Promise<string> {
  if (!validSkillName(input.name)) throw new Error("스킬 이름은 영어 소문자·숫자·하이픈만, 64자까지 (예: weekly-report)");
  if (!input.description.trim()) throw new Error("설명이 필요하다. 무엇을 하고 언제 쓰는지 적어라 (모델이 이것을 보고 고른다)");
  if (input.description.length > 1024) throw new Error("설명은 1,024자까지");
  if (!input.instructions.trim()) throw new Error("지시가 비어 있다");
  if (previous && !validSkillName(previous)) throw new Error(`이름이 올바르지 않다: ${previous}`);
  await mkdir(dir, { recursive: true });
  const target = join(dir, input.name);
  const exists = async (path: string) => stat(path).then(() => true, () => false);
  if (previous && previous !== input.name) {
    if (await exists(target)) throw new Error(`이미 같은 이름의 스킬이 있다: ${input.name}`);
    await rename(join(dir, previous), target);
  } else if (!previous && (await exists(target))) {
    throw new Error(`이미 같은 이름의 스킬이 있다: ${input.name}`);
  }
  await mkdir(target, { recursive: true });
  const file = join(target, "SKILL.md");
  await writeFile(file, formatSkill(input), "utf8");
  return file;
}

/** 사용자 스킬을 지운다. 폴더를 trashDir로 옮겨 되돌릴 수 있게 한다 */
export async function deleteSkill(dir: string, name: string, trashDir: string, now = new Date()): Promise<void> {
  if (!validSkillName(name)) throw new Error(`이름이 올바르지 않다: ${name}`);
  await mkdir(trashDir, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  try {
    await rename(join(dir, name), join(trashDir, `${name}-${stamp}`));
  } catch {
    // 다른 드라이브 등으로 옮기지 못하면 지운다
    await rm(join(dir, name), { recursive: true, force: true });
  }
}
