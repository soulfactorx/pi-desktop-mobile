// Pi Desktop·Agent가 Pi를 띄울 때 -e로 넣는 확장입니다 (DESIGN-APPS.md §3.5 3단계).
// 에이전트가 대화로 자기 앱의 스킬·프롬프트·MCP 서버·Pi 패키지를 보고 고칠 수 있게 한다.
// Pi가 소스 그대로 불러오고(Pi Desktop은 데몬이 문자열로 써 둔다) node 내장 모듈과 Pi가 넣어 주는 typebox 말고는 import하지 않는다.
//
// - 관리하는 홈: PI_RESOURCES_HOME (Agent: 앱 홈). 없으면 Pi 설정 폴더 (Pi Desktop: ~/.pi/agent)
// - 고치기 전에 묻는다 (ctx.ui.confirm). Agent는 permissions 확장이 대신 물으므로 PI_RESOURCES_CONFIRM=0
// - API 키·토큰은 받지 않는다. 키가 필요한 MCP 서버는 앱 화면에서 넣게 한다
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Type } from "typebox";

type Json = Record<string, unknown>;

const homeOf = () => process.env.PI_RESOURCES_HOME || process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const appHome = () => Boolean(process.env.PI_RESOURCES_HOME);
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SERVER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function readJson(path: string): Json {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return value && typeof value === "object" ? (value as Json) : {};
  } catch {
    return {};
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

function frontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out: Record<string, string> = {};
  for (const line of m?.[1]?.split(/\r?\n/) ?? []) {
    const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

export function listResources(home: string) {
  const skills = listDir(join(home, "skills"))
    .filter((n) => existsSync(join(home, "skills", n, "SKILL.md")))
    .map((n) => ({ name: n, description: frontmatter(readFileSync(join(home, "skills", n, "SKILL.md"), "utf8")).description ?? "" }));
  const prompts = listDir(join(home, "prompts"))
    .filter((n) => n.endsWith(".md"))
    .map((n) => ({ name: n.slice(0, -3), description: frontmatter(readFileSync(join(home, "prompts", n), "utf8")).description ?? "" }));
  const servers = Object.entries((readJson(join(home, "mcp.json")).mcpServers ?? {}) as Record<string, Json>).map(([name, e]) => ({
    name,
    enabled: e.enabled !== false,
    target: typeof e.url === "string" ? e.url : [e.command, ...((e.args as unknown[]) ?? [])].filter(Boolean).join(" "),
    hasSecrets: Boolean((e.env && Object.keys(e.env as Json).length) || (e.headers && Object.keys(e.headers as Json).length)),
  }));
  const raw = readJson(join(home, "settings.json")).packages;
  const packages = (Array.isArray(raw) ? raw : []).map((p) => (typeof p === "string" ? p : String((p as Json)?.source ?? ""))).filter(Boolean);
  return { home, skills, prompts, mcpServers: servers, packages };
}

function moveToTrash(home: string, path: string, label: string): void {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const trash = join(home, "resources-trash");
  mkdirSync(trash, { recursive: true });
  renameSync(path, join(trash, `${stamp}-${label}`));
}

export function saveResource(home: string, p: { kind: string; name: string; description?: string; content: string; replace?: boolean }): string {
  if (!NAME.test(p.name)) throw new Error("이름은 영어 소문자·숫자·하이픈으로 (예: weekly-report)");
  const description = (p.description ?? "").replace(/\s+/g, " ").trim();
  if (!description) throw new Error("description(무엇을 하고 언제 쓰는지)이 필요합니다");
  if (!p.content.trim()) throw new Error("content가 비어 있습니다");
  const path = p.kind === "skill" ? join(home, "skills", p.name, "SKILL.md") : join(home, "prompts", `${p.name}.md`);
  if (existsSync(path) && !p.replace) throw new Error(`이미 ${p.name}이(가) 있습니다. 고치려면 replace: true`);
  const head = p.kind === "skill" ? `---\nname: ${p.name}\ndescription: ${JSON.stringify(description)}\n---\n\n` : `---\ndescription: ${JSON.stringify(description)}\n---\n\n`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${head}${p.content.trim()}\n`, "utf8");
  return path;
}

export function deleteResource(home: string, p: { kind: string; name: string }): void {
  if (!NAME.test(p.name)) throw new Error(`이름이 올바르지 않습니다: ${p.name}`);
  const path = p.kind === "skill" ? join(home, "skills", p.name) : join(home, "prompts", `${p.name}.md`);
  if (!existsSync(path)) throw new Error(`${p.name}이(가) 없습니다`);
  moveToTrash(home, path, `${p.kind}-${p.name}`);
}

export function changeMcp(home: string, p: { action: string; name: string; url?: string; command?: string; args?: string[]; description?: string }): void {
  if (!SERVER.test(p.name)) throw new Error(`서버 이름이 올바르지 않습니다: ${p.name}`);
  const path = join(home, "mcp.json");
  const file = readJson(path);
  const servers = { ...((file.mcpServers ?? {}) as Record<string, Json>) };
  const entry = servers[p.name];
  if (p.action === "add") {
    if (entry) throw new Error(`이미 ${p.name} 서버가 있습니다`);
    if (p.url) {
      if (!/^https?:\/\//.test(p.url)) throw new Error("url은 http(s) 주소여야 합니다");
      servers[p.name] = { url: p.url, ...(p.description ? { description: p.description } : {}) };
    } else if (p.command) {
      servers[p.name] = { command: p.command, args: p.args ?? [], ...(p.description ? { description: p.description } : {}) };
    } else throw new Error("url 또는 command가 필요합니다");
  } else {
    if (!entry) throw new Error(`${p.name} 서버가 없습니다`);
    if (p.action === "remove") delete servers[p.name];
    else if (p.action === "enable") {
      const { enabled: _e, ...rest } = entry;
      servers[p.name] = rest;
    } else if (p.action === "disable") servers[p.name] = { ...entry, enabled: false };
    else throw new Error(`모르는 동작: ${p.action}`);
  }
  writeJson(path, { ...file, mcpServers: servers });
}

export function validPackageSource(source: string): boolean {
  if (source.includes("..")) return false;
  return /^(npm:(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.^~<>=*-]+)?|git:[a-z0-9][\w.-]*\/[\w./-]+(@[\w./-]+)?|https:\/\/[a-z0-9][\w.-]*\/[\w./-]+(@[\w./-]+)?)$/i.test(source.trim());
}

/** 지금 도는 Pi를 그대로 불러 하위 명령을 이 홈에서 돌린다 */
function runPi(home: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  const script = process.argv[1] ?? "";
  const viaNode = /\.(c|m)?js$/.test(script);
  const command = process.execPath;
  const full = viaNode ? [script, ...args] : args;
  return new Promise((done) =>
    execFile(command, full, { cwd: home, env: { ...process.env, PI_CODING_AGENT_DIR: home }, timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) =>
      done({ ok: !error, output: `${stdout}${stderr ? `\n${stderr}` : ""}`.trim() }),
    ),
  );
}

/** 앱 홈이면 설치 폴더를 적어 둔다 (앱이 세션을 열 때 이 파일로 -e를 붙인다, pi-resources packages.ts와 같은 형식) */
async function refreshPaths(home: string): Promise<void> {
  const listed = await runPi(home, ["list"]);
  if (!listed.ok) return;
  const paths: Record<string, string> = {};
  let section = "";
  let source: string | undefined;
  for (const line of listed.output.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      section = line.trim().toLowerCase();
      source = undefined;
      continue;
    }
    if (!section.startsWith("user")) continue;
    const two = /^ {2}(\S.*)$/.exec(line);
    const four = /^ {4,}(\S.*)$/.exec(line);
    if (two) source = two[1]!.trim().replace(/\s+\(.*\)$/, "");
    else if (four && source && !(source in paths)) paths[source] = four[1]!.trim();
  }
  writeJson(join(home, "package-paths.json"), paths);
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });
const AFTER = () => (appHome() ? "새 대화부터 적용됩니다." : "지금 세션에 쓰려면 /reload, 아니면 새 세션부터 적용됩니다.");

export default function manage(pi: any): void {
  const confirmFirst = process.env.PI_RESOURCES_CONFIRM !== "0";
  const kinds = process.env.PI_RESOURCES_NO_SKILL === "1" ? ["prompt"] : ["skill", "prompt"];
  const ask = async (ctx: any, title: string, body: string) => {
    if (!confirmFirst) return true;
    if (!ctx?.hasUI) return false;
    return Boolean(await ctx.ui.confirm(title, body));
  };

  pi.registerTool({
    name: "resources_list",
    label: "확장 목록",
    description: "이 앱의 스킬·프롬프트·MCP 서버·Pi 패키지 목록을 본다 (API 키 값은 보이지 않는다). 무엇이 있는지 확인하거나 고치기 전에 쓴다.",
    promptSnippet: "resources_list: 이 앱의 스킬·프롬프트·MCP 서버·패키지 목록",
    parameters: Type.Object({}),
    async execute() {
      return text(JSON.stringify(listResources(homeOf()), null, 2));
    },
  });

  pi.registerTool({
    name: "resource_save",
    label: "스킬·프롬프트 저장",
    description:
      `이 앱에 ${kinds.includes("skill") ? "스킬(SKILL.md)이나 " : ""}프롬프트 템플릿을 만들거나 고친다. 사용자가 저장해 두라고 하거나 되풀이할 지시가 있을 때 쓴다. ` +
      "name은 영어 소문자·숫자·하이픈, description은 무엇을 하고 언제 쓰는지, content는 Markdown 본문. 있는 것을 고치려면 replace: true.",
    promptSnippet: "resource_save: 스킬·프롬프트를 이 앱에 저장",
    parameters: Type.Object({
      kind: Type.Union(kinds.map((k) => Type.Literal(k)), { description: "skill: 작업 방법(모델이 골라 읽음), prompt: /이름으로 부르는 지시" }),
      name: Type.String({ description: "영어 소문자·숫자·하이픈" }),
      description: Type.String({ description: "무엇을 하고 언제 쓰는지" }),
      content: Type.String({ description: "본문 (Markdown)" }),
      replace: Type.Optional(Type.Boolean({ description: "있는 것을 고칠 때 true" })),
    }),
    async execute(_id: string, p: any, _signal: unknown, _onUpdate: unknown, ctx: any) {
      if (!kinds.includes(p.kind)) throw new Error(`저장할 수 없는 종류: ${p.kind}`);
      if (!(await ask(ctx, `${p.kind === "skill" ? "스킬" : "프롬프트"} ${p.replace ? "고치기" : "저장"}: ${p.name}`, `${p.description}\n\n${String(p.content).slice(0, 1200)}`))) return text("사용자가 저장하지 않기로 했다.");
      const path = saveResource(homeOf(), p);
      return text(`저장했다: ${path}. ${AFTER()}`);
    },
  });

  pi.registerTool({
    name: "resource_delete",
    label: "스킬·프롬프트 지우기",
    description: "이 앱의 스킬이나 프롬프트를 지운다 (앱 홈의 resources-trash/로 옮겨 되살릴 수 있다).",
    promptSnippet: "resource_delete: 스킬·프롬프트 지우기",
    parameters: Type.Object({ kind: Type.Union([Type.Literal("skill"), Type.Literal("prompt")]), name: Type.String() }),
    async execute(_id: string, p: any, _signal: unknown, _onUpdate: unknown, ctx: any) {
      if (!(await ask(ctx, `${p.kind === "skill" ? "스킬" : "프롬프트"} 지우기: ${p.name}`, "resources-trash로 옮깁니다."))) return text("사용자가 지우지 않기로 했다.");
      deleteResource(homeOf(), p);
      return text(`${p.name}을(를) 지웠다 (resources-trash로 옮김). ${AFTER()}`);
    },
  });

  pi.registerTool({
    name: "mcp_server",
    label: "MCP 서버 관리",
    description:
      "이 앱의 MCP 서버(mcp.json)를 넣거나(add: url 또는 command+args) 켜고 끄고(enable·disable) 뺀다(remove). " +
      "API 키·토큰은 넣지 않는다. 키가 필요한 서버는 넣은 뒤 사용자에게 앱 화면(웹 검색·MCP)에서 키를 넣으라고 안내한다. 사용자가 원할 때만 쓴다.",
    promptSnippet: "mcp_server: MCP 서버 넣기·켜기·끄기·빼기",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("add"), Type.Literal("enable"), Type.Literal("disable"), Type.Literal("remove")]),
      name: Type.String({ description: "서버 이름 (영문·숫자·_·-)" }),
      url: Type.Optional(Type.String({ description: "add: 원격 서버 주소 (http/https)" })),
      command: Type.Optional(Type.String({ description: "add: 서버를 띄우는 명령 (예: npx)" })),
      args: Type.Optional(Type.Array(Type.String(), { description: "add: 명령 인자" })),
      description: Type.Optional(Type.String()),
    }),
    async execute(_id: string, p: any, _signal: unknown, _onUpdate: unknown, ctx: any) {
      const what = p.action === "add" ? `넣기: ${p.name} (${p.url ?? [p.command, ...(p.args ?? [])].join(" ")})` : `${p.action}: ${p.name}`;
      if (!(await ask(ctx, `MCP 서버 ${what}`, "외부 서비스에 연결하는 도구가 생기거나 바뀝니다."))) return text("사용자가 바꾸지 않기로 했다.");
      changeMcp(homeOf(), p);
      return text(`MCP 서버 ${what} 완료. ${AFTER()}`);
    },
  });

  pi.registerTool({
    name: "pi_package",
    label: "Pi 패키지 설치",
    description:
      "이 앱에 Pi 패키지(확장·스킬 묶음)를 설치(install)하거나 지운다(remove). source는 npm:이름, git:주소, https 주소. " +
      "패키지는 코드를 실행하므로 사용자가 원할 때만, 무엇을 설치하는지 밝히고 쓴다. 설치에는 몇 분이 걸릴 수 있다.",
    promptSnippet: "pi_package: Pi 패키지 설치·제거",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("install"), Type.Literal("remove")]),
      source: Type.String({ description: "npm:이름, git:주소, https 주소" }),
    }),
    async execute(_id: string, p: any, _signal: unknown, _onUpdate: unknown, ctx: any) {
      const source = String(p.source ?? "").trim();
      if (p.action === "install" && !validPackageSource(source)) throw new Error("source는 npm:이름, git:주소, https 주소여야 합니다");
      if (!(await ask(ctx, `Pi 패키지 ${p.action === "install" ? "설치" : "제거"}: ${source}`, p.action === "install" ? "패키지는 코드를 실행합니다. 믿을 수 있는 것만 설치하세요." : ""))) {
        return text("사용자가 하지 않기로 했다.");
      }
      const home = homeOf();
      mkdirSync(home, { recursive: true });
      const result = await runPi(home, [p.action, source]);
      if (appHome()) await refreshPaths(home);
      if (!result.ok) throw new Error(`실패했다:\n${result.output.slice(-1500)}`);
      return text(`${source} ${p.action === "install" ? "설치" : "제거"} 완료. ${AFTER()}`);
    },
  });
}
