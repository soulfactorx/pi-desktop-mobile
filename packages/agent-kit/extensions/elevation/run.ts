import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LinuxPackageManager } from "./compile";

/**
 * 승인이 끝난 argv를 OS 상승 경로로 한 번 실행한다 (desktop-agent tools/elevated.ts를 옮김).
 * 비밀번호는 OS(polkit·Authorization Services·UAC)가 직접 받는다. 이 프로세스는 끝까지 일반 사용자 권한이고,
 * 관리자 권한인 것은 승인된 argv 하나를 실행하고 끝나는 자식 프로세스뿐이다.
 */

export interface ElevatedResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  cancelled?: boolean;
}

const MAX_OUTPUT = 100 * 1024;
/** 인증 창에 답하는 시간까지 포함한 상한 */
const RUN_TIMEOUT_MS = 5 * 60 * 1000;

const truncate = (s: string) => (s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n...[출력 잘림]` : s);

function run(file: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: RUN_TIMEOUT_MS, maxBuffer: 5 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      // 종료 코드는 error.code에 숫자로 온다 (실행 자체가 실패하면 문자열 코드)
      const err = error as (Error & { code?: number | string }) | null;
      const code = !err ? 0 : typeof err.code === "number" ? err.code : 1;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** 설치된 첫 패키지 관리자 (Linux) */
export function linuxPackageManager(): LinuxPackageManager | undefined {
  for (const name of ["apt-get", "dnf", "pacman", "zypper"] as const) if (existsSync(`/usr/bin/${name}`)) return name;
  return undefined;
}

async function runLinux(argv: string[]): Promise<ElevatedResult> {
  // PATH 해석을 pkexec에 맡기지 않고 미리 절대 경로로 바꾼다 (승인 화면과 실행 대상을 맞춘다)
  let bin = argv[0]!;
  if (!bin.startsWith("/")) {
    const which = await run("/usr/bin/which", [bin]);
    bin = which.code === 0 ? (which.stdout.split("\n")[0]?.trim() ?? "") : "";
  }
  if (!bin || !existsSync(bin)) return { exitCode: 127, stdout: "", stderr: `실행 파일을 찾을 수 없다: ${argv[0]}` };
  // 데스크톱 polkit 에이전트가 없으면 tty로 묻지 않고 바로 실패하게 한다 (앱이 비밀번호를 받는 길은 없다)
  const { code, stdout, stderr } = await run("pkexec", ["--disable-internal-agent", bin, ...argv.slice(1)]);
  if (code === 126) return { exitCode: 126, stdout: "", stderr: "사용자가 인증을 취소했거나 권한이 거부됐다", cancelled: true };
  if (code === 127 && !stdout) {
    return { exitCode: 127, stdout: "", stderr: `실행 파일이 없거나 polkit 인증 에이전트가 없다 (${argv[0]}). 데스크톱 세션 밖이면 터미널에서 직접 실행해야 한다` };
  }
  return { exitCode: code, stdout: truncate(stdout), stderr: truncate(stderr) };
}

const shQuote = (arg: string) => `'${arg.replace(/'/g, `'\\''`)}'`;

async function runMac(argv: string[]): Promise<ElevatedResult> {
  // Authorization Services 경로는 셸 문자열을 받는다. 인자마다 작은따옴표로 감싸 셸 해석을 막고 AppleScript 문자열로 한 번 더 감싼다
  const command = `${argv.map(shQuote).join(" ")} 2>&1; echo "__EXIT__$?"`;
  const script = `do shell script "${command.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}" with administrator privileges`;
  const { code, stdout, stderr } = await run("osascript", ["-e", script]);
  if (code !== 0 && /-128|User canceled/i.test(stderr)) return { exitCode: 126, stdout: "", stderr: "사용자가 인증을 취소했다", cancelled: true };
  const match = /__EXIT__(\d+)\s*$/.exec(stdout);
  return { exitCode: match ? Number(match[1]) : code, stdout: truncate(match ? stdout.slice(0, match.index) : stdout), stderr: truncate(stderr) };
}

async function runWindows(argv: string[]): Promise<ElevatedResult> {
  // Start-Process -Verb RunAs는 출력을 파이프로 받을 수 없어, 상승한 자식이 임시 파일에 남기고 여기서 읽은 뒤 지운다
  const stamp = `agent-elev-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const outFile = join(tmpdir(), `${stamp}.out`);
  const codeFile = join(tmpdir(), `${stamp}.code`);
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const args = argv.slice(1).map(q).join(",");
  const inner = `$ErrorActionPreference='Continue'; & ${q(argv[0]!)} ${args ? `@(${args})` : ""} *> ${q(outFile)}; Set-Content -LiteralPath ${q(codeFile)} -Value $LASTEXITCODE`;
  const encoded = Buffer.from(inner, "utf16le").toString("base64");
  const launcher = `Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}'`;
  const { code, stderr } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", launcher]);
  const readAndRemove = (path: string) => {
    if (!existsSync(path)) return "";
    const text = readFileSync(path, "utf8");
    try {
      rmSync(path);
    } catch {
      // 지우지 못해도 결과는 돌려준다
    }
    return text;
  };
  const stdout = readAndRemove(outFile);
  const exitText = readAndRemove(codeFile).trim();
  if (code !== 0 && !exitText) return { exitCode: 126, stdout: "", stderr: stderr.trim() || "UAC 승격이 거부됐거나 취소됐다", cancelled: true };
  return { exitCode: exitText ? Number(exitText) || 0 : code, stdout: truncate(stdout), stderr: truncate(stderr) };
}

export function runElevated(argv: string[], platform: NodeJS.Platform = process.platform): Promise<ElevatedResult> {
  if (platform === "win32") return runWindows(argv);
  if (platform === "darwin") return runMac(argv);
  return runLinux(argv);
}
