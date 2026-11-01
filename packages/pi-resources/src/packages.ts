import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PiRun } from "./manager";
import type { PackageResult, PackageView } from "./types";

/**
 * 앱 홈에 설치하는 Pi 패키지 (설계 DESIGN-APPS.md §3.5, 2단계).
 *
 * Pi는 패키지를 설정 폴더(`PI_CODING_AGENT_DIR`)의 settings.json `packages`에 적고 그 폴더의 npm/·git/에 설치한다.
 * Agent·Mate는 로그인을 함께 쓰려고 설정 폴더를 바꾸지 않으므로(§3.1), **설치할 때만** 설정 폴더를 앱 홈으로 바꿔
 * `pi install`·`pi remove`를 돌린다. 그러면 패키지 목록은 `<앱 홈>/settings.json`, 설치본은 `<앱 홈>/npm|git/`에 생긴다.
 *
 * 세션을 열 때는 `-ne`로 Pi 기본 확장을 끄고, 설치된 패키지 폴더를 `-e <폴더>`로 하나씩 올린다 (폴더는 Pi의 패키지 규칙대로 읽힌다).
 * 폴더 위치는 설치·제거 뒤 `pi list`로 받아 `<앱 홈>/package-paths.json`에 적어 두고, 세션을 열 때는 그 파일만 읽는다.
 */

export const PACKAGE_PATHS_FILE = "package-paths.json";
/** 패키지마다 더하는 도구 이름 (출처 → 이름들). Mate는 --tools에 이름을 미리 적어야 해서 설치할 때 알아 둔다 */
export const PACKAGE_TOOLS_FILE = "package-tools.json";

/** `pi list` 출력에서 출처 → 설치 폴더를 읽는다 (사용자 패키지만) */
export function parsePiList(output: string): Record<string, string> {
  const paths: Record<string, string> = {};
  let section = "";
  let source: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      section = line.trim().toLowerCase();
      source = undefined;
      continue;
    }
    if (!section.startsWith("user")) continue;
    const four = /^ {4,}(\S.*)$/.exec(line);
    const two = /^ {2}(\S.*)$/.exec(line);
    if (two) source = two[1]!.trim().replace(/\s+\(.*\)$/, "");
    else if (four && source && !(source in paths)) paths[source] = four[1]!.trim();
  }
  return paths;
}

/** 출처에서 보기 좋은 이름 (npm:@a/b@1.0 → @a/b, git:github.com/x/y@v1 → y) */
export function packageName(source: string): string {
  if (source.startsWith("npm:")) {
    const spec = source.slice(4);
    const at = spec.lastIndexOf("@");
    return at > 0 ? spec.slice(0, at) : spec;
  }
  const bare = source.replace(/^git:/, "").replace(/@[^/]*$/, "").replace(/\.git$/, "").replace(/\/+$/, "");
  return bare.split(/[\\/]/).pop() || source;
}

/** 설치할 수 있는 출처인지 (npm·git·https 주소. 앱이 받는 값이라 경로는 받지 않는다) */
export function validPackageSource(source: string): boolean {
  if (source.includes("..")) return false;
  return /^(npm:(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.^~<>=*-]+)?|git:[a-z0-9][\w.-]*\/[\w./-]+(@[\w./-]+)?|https:\/\/[a-z0-9][\w.-]*\/[\w./-]+(@[\w./-]+)?)$/i.test(source.trim());
}

function readSettingsPackages(text: string): string[] {
  try {
    const raw = (JSON.parse(text) as { packages?: unknown }).packages;
    if (!Array.isArray(raw)) return [];
    return raw
      .map((p) => (typeof p === "string" ? p : typeof (p as { source?: unknown })?.source === "string" ? (p as { source: string }).source : undefined))
      .filter((s): s is string => Boolean(s));
  } catch {
    return [];
  }
}

function readPaths(text: string): Record<string, string> {
  try {
    const raw = JSON.parse(text) as unknown;
    return raw && typeof raw === "object" ? (raw as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** 이 홈의 패키지 목록 */
export async function listPackages(home: string): Promise<PackageView[]> {
  const settings = await readFile(join(home, "settings.json"), "utf8").catch(() => "");
  const paths = readPaths(await readFile(join(home, PACKAGE_PATHS_FILE), "utf8").catch(() => ""));
  return readSettingsPackages(settings).map((source) => {
    const path = paths[source];
    return { source, name: packageName(source), ...(path && existsSync(path) ? { path } : {}) };
  });
}

/**
 * 세션에 올릴 패키지 폴더들 (`-e`로 하나씩). 세션을 열 때마다 부르므로 Pi를 띄우지 않고 적어 둔 파일만 읽는다.
 * settings.json에서 빠진 것(다른 곳에서 지운 것)과 폴더가 없는 것은 뺀다.
 */
export function packageDirs(home: string): string[] {
  try {
    const sources = readSettingsPackages(readFileSync(join(home, "settings.json"), "utf8"));
    const paths = readPaths(readFileSync(join(home, PACKAGE_PATHS_FILE), "utf8"));
    return sources.map((s) => paths[s]).filter((p): p is string => Boolean(p) && existsSync(p!));
  } catch {
    return [];
  }
}

/** 이 홈을 Pi 설정 폴더로 삼아 pi 명령을 돌린다 (설치·제거·목록) */
export function runPiInHome(run: PiRun, home: string, args: string[], timeoutMs = 10 * 60_000): Promise<{ ok: boolean; output: string }> {
  return new Promise((done) => {
    execFile(
      run.command,
      [...run.args, ...args],
      { cwd: home, env: { ...run.env, PI_CODING_AGENT_DIR: home }, timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => done({ ok: !error, output: `${stdout}${stderr ? `\n${stderr}` : ""}`.trim() }),
    );
  });
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, path);
}

/** `pi list`로 설치 폴더를 다시 읽어 적고, 패키지마다 도구 이름을 알아 둔다 */
export async function refreshPackagePaths(run: PiRun, home: string): Promise<void> {
  const listed = await runPiInHome(run, home, ["list"], 120_000);
  if (!listed.ok) return;
  const paths = parsePiList(listed.output);
  await writeJsonAtomic(join(home, PACKAGE_PATHS_FILE), paths);
  const tools: Record<string, string[]> = {};
  for (const [source, dir] of Object.entries(paths)) tools[source] = await discoverPackageTools(run, dir).catch(() => []);
  await writeJsonAtomic(join(home, PACKAGE_TOOLS_FILE), tools);
}

/** 도구 목록을 파일로 남기는 작은 확장. Pi를 RPC로 띄워 세션이 시작될 때 한 번 쓰고, 부르는 쪽이 Pi를 끝낸다 (모델을 부르지 않는다) */
const LISTER_SOURCE = `import { writeFileSync } from "node:fs";
export default function (pi: any) {
  pi.on("session_start", async () => {
    const out = process.env.PI_RESOURCES_TOOLS_OUT;
    if (out) writeFileSync(out, JSON.stringify(pi.getAllTools().map((t: any) => ({ name: t.name, path: t.sourceInfo?.path ?? "" }))));
  });
}
`;

/** 패키지 폴더 하나가 더하는 도구 이름들 */
export async function discoverPackageTools(run: PiRun, dir: string, timeoutMs = 60_000): Promise<string[]> {
  const work = join(tmpdir(), "pi-resources");
  await mkdir(work, { recursive: true });
  const lister = join(work, `lister-${createHash("sha256").update(LISTER_SOURCE).digest("hex").slice(0, 12)}.ts`);
  if (!existsSync(lister)) await writeFile(lister, LISTER_SOURCE, "utf8");
  const out = join(work, `tools-${process.pid}-${Date.now().toString(36)}.json`);
  const child = spawn(run.command, [...run.args, "--mode", "rpc", "--no-session", "-ns", "-np", "-nc", "-ne", "-e", lister, "-e", dir], {
    cwd: dir,
    env: { ...run.env, PI_RESOURCES_TOOLS_OUT: out },
    stdio: ["pipe", "ignore", "ignore"],
    windowsHide: true,
  });
  try {
    const started = Date.now();
    while (!existsSync(out)) {
      if (child.exitCode !== null || Date.now() - started > timeoutMs) return [];
      await new Promise((r) => setTimeout(r, 200));
    }
    await new Promise((r) => setTimeout(r, 100));
    const listed = JSON.parse(await readFile(out, "utf8")) as Array<{ name: string; path: string }>;
    const base = dir.replace(/\\/g, "/").replace(/\/+$/, "");
    return listed.filter((t) => t.path.replace(/\\/g, "/").startsWith(`${base}/`)).map((t) => t.name);
  } finally {
    child.kill();
    await rm(out, { force: true });
  }
}

/** Mate가 --tools에 넣을 패키지 도구 이름들 (세션을 열 때 부르므로 적어 둔 파일만 읽는다) */
export function packageToolNames(home: string): string[] {
  try {
    const sources = readSettingsPackages(readFileSync(join(home, "settings.json"), "utf8"));
    const tools = JSON.parse(readFileSync(join(home, PACKAGE_TOOLS_FILE), "utf8")) as Record<string, unknown>;
    return [...new Set(sources.flatMap((s) => (Array.isArray(tools[s]) ? (tools[s] as unknown[]).filter((t): t is string => typeof t === "string") : [])))];
  } catch {
    return [];
  }
}

export async function installPackage(run: PiRun, home: string, source: string): Promise<PackageResult> {
  const clean = source.trim();
  if (!validPackageSource(clean)) throw new Error(`설치할 수 없는 출처입니다: ${source} (npm:이름, git:주소, https 주소)`);
  await mkdir(home, { recursive: true });
  const result = await runPiInHome(run, home, ["install", clean]);
  await refreshPackagePaths(run, home);
  return { ...result, packages: await listPackages(home) };
}

export async function removePackage(run: PiRun, home: string, source: string): Promise<PackageResult> {
  const result = await runPiInHome(run, home, ["remove", source]);
  await refreshPackagePaths(run, home);
  return { ...result, packages: await listPackages(home) };
}
