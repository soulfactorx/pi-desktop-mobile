import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

/** `pi list`로 설치 폴더를 다시 읽어 적어 둔다 */
export async function refreshPackagePaths(run: PiRun, home: string): Promise<void> {
  const listed = await runPiInHome(run, home, ["list"], 120_000);
  if (!listed.ok) return;
  const tmp = join(home, `${PACKAGE_PATHS_FILE}.${process.pid}.tmp`);
  await writeFile(tmp, JSON.stringify(parsePiList(listed.output), null, 2), "utf8");
  await rename(tmp, join(home, PACKAGE_PATHS_FILE));
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
