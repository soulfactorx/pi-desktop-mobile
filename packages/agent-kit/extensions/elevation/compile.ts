/**
 * 권한 상승 작업(op)을 이 플랫폼의 argv로 바꾼다 (desktop-agent tools/elevated.ts를 옮김). 파일·프로세스에 손대지 않는다.
 *
 * 입력이 자유 문자열이 아니라 작업 목록인 이유: 승인 화면에 뜬 글자와 실제 실행되는 것이 1:1이어야 사람이 판단할 수 있다.
 * 결과는 셸을 거치지 않는 argv라, 인자에 `;`나 `$(...)`가 들어 있어도 해석되지 않는다.
 * 설계: DESIGN-AGENT.md §4 "권한 상승"
 */

export const ELEVATED_TOOL = "shell_exec_elevated";

export const ELEVATED_OPS = ["package_install", "package_remove", "package_update", "service", "copy_file", "raw"] as const;
export const SERVICE_ACTIONS = ["start", "stop", "restart", "status", "enable", "disable"] as const;

export interface ElevatedInput {
  op: (typeof ELEVATED_OPS)[number];
  names?: string[];
  action?: (typeof SERVICE_ACTIONS)[number];
  unit?: string;
  from?: string;
  to?: string;
  argv?: string[];
}

export type LinuxPackageManager = "apt-get" | "dnf" | "pacman" | "zypper";

/** 셸 메타문자·공백·제어문자가 없는 이름만 — 승인 화면 한 줄 = 인자 하나 */
const PKG_NAME = /^[A-Za-z0-9][A-Za-z0-9._+@-]*$/;
const UNIT_NAME = /^[A-Za-z0-9][A-Za-z0-9._@:-]*$/;
/** 셸을 거치지 않으므로 ~는 펼쳐지지 않는다 */
const ABS_PATH = /^(\/|[A-Za-z]:[\\/])[^\n\r\0]*$/;
const ARG = /^[^\n\r\0]+$/;
/** 상승 도구 안에서 다시 상승하는 것은 막는다 (승인 화면에 보인 것과 다른 권한 경로가 생긴다) */
const NESTED_ELEVATION = /^(sudo|doas|pkexec|su|runas|gsudo)(\.exe)?$/i;

function need<T>(value: T | undefined, field: string): T {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) throw new Error(`${field} 인자가 필요하다`);
  return value;
}

/** 입력 검사. 어긋나면 이유를 담은 오류 */
export function validateElevated(input: ElevatedInput): void {
  for (const name of input.names ?? []) if (!PKG_NAME.test(name)) throw new Error(`패키지 이름에 쓸 수 없는 문자가 있다: ${name}`);
  if ((input.names?.length ?? 0) > 20) throw new Error("패키지는 한 번에 20개까지");
  if (input.unit !== undefined && !UNIT_NAME.test(input.unit)) throw new Error(`서비스 이름에 쓸 수 없는 문자가 있다: ${input.unit}`);
  for (const path of [input.from, input.to]) if (path !== undefined && !ABS_PATH.test(path)) throw new Error(`절대 경로여야 한다 (~는 펼쳐지지 않는다): ${path}`);
  if (input.argv) {
    if (input.argv.length > 40) throw new Error("argv는 40개까지");
    for (const arg of input.argv) if (!ARG.test(arg)) throw new Error("인자에 줄바꿈이나 NUL을 넣을 수 없다");
    const head = input.argv[0]?.split(/[\\/]/).at(-1) ?? "";
    if (NESTED_ELEVATION.test(head)) throw new Error(`${head}는 넣지 말라. 이 도구가 이미 관리자 권한으로 실행한다`);
  }
}

function linuxArgv(i: ElevatedInput, pm: LinuxPackageManager | undefined): string[] {
  const manager = () => {
    if (!pm) throw new Error("지원하는 패키지 관리자를 찾지 못했다 (apt-get·dnf·pacman·zypper)");
    return pm;
  };
  switch (i.op) {
    case "package_install":
    case "package_remove": {
      const names = need(i.names, "names");
      const install = i.op === "package_install";
      switch (manager()) {
        case "apt-get":
          return ["apt-get", install ? "install" : "remove", "-y", ...names];
        case "dnf":
          return ["dnf", install ? "install" : "remove", "-y", ...names];
        case "pacman":
          return ["pacman", install ? "-S" : "-R", "--noconfirm", ...names];
        case "zypper":
          return ["zypper", "--non-interactive", install ? "install" : "remove", ...names];
      }
      break;
    }
    case "package_update":
      switch (manager()) {
        case "apt-get":
          return ["apt-get", "update"];
        case "dnf":
          return ["dnf", "check-update"];
        case "pacman":
          // -Sy 단독은 부분 업그레이드로 시스템을 깨뜨릴 수 있다 (Arch 권고)
          throw new Error('pacman은 목록만 갱신할 수 없다. 전체 업그레이드가 필요하면 사용자에게 알린 뒤 raw로 ["pacman","-Syu","--noconfirm"]을 요청하라');
        case "zypper":
          return ["zypper", "refresh"];
      }
      break;
    case "service":
      return ["systemctl", need(i.action, "action"), need(i.unit, "unit")];
    case "copy_file":
      return ["cp", "-f", need(i.from, "from"), need(i.to, "to")];
    case "raw":
      return need(i.argv, "argv");
  }
  throw new Error(`이 플랫폼에서 지원하지 않는 작업이다: ${i.op}`);
}

function macArgv(i: ElevatedInput): string[] {
  const target = () => `system/${need(i.unit, "unit")}`;
  switch (i.op) {
    case "package_install":
    case "package_remove":
    case "package_update":
      throw new Error("macOS의 Homebrew는 관리자 권한이 필요 없다. bash로 brew를 그대로 실행하라");
    case "service": {
      const map: Record<string, string[]> = {
        status: ["launchctl", "print", target()],
        start: ["launchctl", "kickstart", target()],
        restart: ["launchctl", "kickstart", "-k", target()],
        stop: ["launchctl", "kill", "SIGTERM", target()],
        enable: ["launchctl", "enable", target()],
        disable: ["launchctl", "disable", target()],
      };
      return map[need(i.action, "action")]!;
    }
    case "copy_file":
      return ["cp", "-f", need(i.from, "from"), need(i.to, "to")];
    case "raw":
      return need(i.argv, "argv");
  }
}

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

function winArgv(i: ElevatedInput): string[] {
  switch (i.op) {
    case "package_install":
    case "package_remove": {
      const names = need(i.names, "names");
      if (names.length > 1) throw new Error("winget은 한 번에 한 패키지만 처리한다");
      const install = i.op === "package_install";
      return ["winget", install ? "install" : "uninstall", "--silent", "--accept-source-agreements", ...(install ? ["--accept-package-agreements"] : []), "--id", names[0]!];
    }
    case "package_update":
      return ["winget", "source", "update"];
    case "service": {
      const unit = need(i.unit, "unit");
      const map: Record<string, string[]> = {
        start: ["sc.exe", "start", unit],
        stop: ["sc.exe", "stop", unit],
        status: ["sc.exe", "query", unit],
        restart: ["powershell.exe", "-NoProfile", "-Command", `Restart-Service -Name ${psQuote(unit)}`],
        enable: ["sc.exe", "config", unit, "start=", "auto"],
        disable: ["sc.exe", "config", unit, "start=", "disabled"],
      };
      return map[need(i.action, "action")]!;
    }
    case "copy_file":
      return ["powershell.exe", "-NoProfile", "-Command", `Copy-Item -LiteralPath ${psQuote(need(i.from, "from"))} -Destination ${psQuote(need(i.to, "to"))} -Force`];
    case "raw":
      return need(i.argv, "argv");
  }
}

/** 검사하고 이 플랫폼의 argv로 바꾼다. 승인 화면에 보일 값이라 실행 전에 부른다 */
export function compileElevated(input: ElevatedInput, platform: NodeJS.Platform, linuxPm?: LinuxPackageManager): string[] {
  validateElevated(input);
  if (platform === "win32") return winArgv(input);
  if (platform === "darwin") return macArgv(input);
  return linuxArgv(input, linuxPm);
}

/** 승인 화면에 보일 한 줄. argv를 그대로, 공백이 든 인자는 따옴표로 */
export function argvLine(argv: string[]): string {
  return argv.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(" ");
}
