import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendBlocked } from "../../src/blocked";
import { checkCommand, isGrantableName } from "../../src/guard";
import { extToolGrant, isGuardProfile, isMcpToolName, MATE_ENV, profileTools } from "../../src/shared";
import { writeScopeError } from "../../src/write-scope";

/** Windows Git Bash 출력이 UTF-8로 오도록 (Pi Desktop bridge와 같은 처리, Mate는 bridge를 쓰지 않는다) */
const UTF8_PREFIX = "chcp.com 65001 > /dev/null 2>&1";

/**
 * 권한 단계 강제 (설계 DESIGN-MATE.md §4).
 *
 * 실행기가 `--tools`로 단계에 없는 도구를 아예 선언하지 않지만, 여기서 한 번 더 막는다:
 * - 단계에 없는 도구 호출은 막는다 (다른 확장이 더한 도구 포함)
 * - bash는 어느 단계든 읽기 전용 허용 목록만 (사용자가 그 임무에 허용한 명령은 더한다)
 * - 허용 목록에 없을 뿐인 명령은 막으면서 기록해 둔다. 실행이 끝나면 실행기가 사용자에게 허용을 묻는다
 * - act의 write·edit는 작업 공간(git worktree) 안만. 작업 공간이 주어지지 않았으면 막는다
 * - MCP 도구(임무가 고른 서버의 것)는 사용자가 허용한 것만. 처음 쓰는 도구는 막고 기록해 허용을 묻는다 (D2.5)
 * 권한 단계 환경 변수가 없으면(터미널 pi에 설치) 아무것도 하지 않는다.
 */
export default function mateGuard(pi: ExtensionAPI): void {
  const profile = process.env[MATE_ENV.profile];
  if (!isGuardProfile(profile)) return;
  const allowed = new Set(profileTools(profile));
  const writeRoot = process.env[MATE_ENV.writeRoot];
  /** 사용자가 이 임무에 허용한 명령 이름 */
  const grants = (process.env[MATE_ENV.grants] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const blockedPath = process.env[MATE_ENV.blocked];

  // Mate 홈에 설치한 Pi 패키지의 도구 (DESIGN-APPS.md §3.5). --tools에는 이름을 미리 알 수 없어 넣지 못하므로
  // 세션이 시작되면 여기서 켜고, MCP 도구처럼 사용자가 허용한 것만 쓰게 한다 (허용 이름은 ext__<도구>)
  const packageDirs = (process.env[MATE_ENV.packages] ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const inPackage = (tool: { sourceInfo?: { path?: string; baseDir?: string } }) => {
    const where = norm(tool.sourceInfo?.baseDir ?? tool.sourceInfo?.path ?? "");
    return where !== "" && packageDirs.some((dir) => where === norm(dir) || where.startsWith(`${norm(dir)}/`));
  };
  const packageTools = () => (packageDirs.length === 0 ? [] : pi.getAllTools().filter(inPackage));
  if (packageDirs.length > 0) {
    pi.on("session_start", async () => {
      const tools = packageTools().map((t) => t.name);
      if (tools.length === 0) return;
      const active = pi.getActiveTools().map((t: unknown) => (typeof t === "string" ? t : (t as { name: string }).name));
      pi.setActiveTools([...new Set([...active, ...tools])]);
    });
  }

  pi.on("tool_call", async (event, ctx) => {
    const fromPackage = packageDirs.length > 0 ? packageTools().find((t) => t.name === event.toolName) : undefined;
    if (fromPackage) {
      const grant = extToolGrant(event.toolName);
      if (grants.includes(grant)) return undefined;
      if (blockedPath) {
        await appendBlocked(blockedPath, { name: grant, command: (fromPackage.description ?? "").split("\n")[0]!.slice(0, 200), at: Date.now() }).catch(() => undefined);
      }
      return {
        block: true,
        reason:
          `${event.toolName}은(는) 사용자가 아직 허용하지 않은 확장 도구다.` +
          (blockedPath ? " 사용자에게 허용을 요청해 두었다. 다른 방법으로 우회하지 말고, 할 수 있는 만큼만 하고 무엇이 막혔는지 요약에 적어라." : ""),
      };
    }
    if (isMcpToolName(event.toolName)) {
      if (grants.includes(event.toolName)) return undefined;
      if (blockedPath) {
        const description = pi.getAllTools().find((t) => t.name === event.toolName)?.description ?? "";
        await appendBlocked(blockedPath, { name: event.toolName, command: description.split("\n")[0]!.slice(0, 200), at: Date.now() }).catch(() => undefined);
      }
      return {
        block: true,
        reason:
          `${event.toolName}은(는) 사용자가 아직 허용하지 않은 MCP 도구다.` +
          (blockedPath ? " 사용자에게 허용을 요청해 두었다. 다른 방법으로 우회하지 말고, 할 수 있는 만큼만 하고 무엇이 막혔는지 요약에 적어라." : ""),
      };
    }
    if (!allowed.has(event.toolName)) {
      return { block: true, reason: `Mate의 ${profile} 단계에서는 ${event.toolName} 도구를 쓸 수 없습니다` };
    }
    if (event.toolName === "write" || event.toolName === "edit") {
      if (!writeRoot) return { block: true, reason: "작업 공간이 없어 파일을 쓸 수 없습니다" };
      const path = String((event.input as { path?: unknown }).path ?? "");
      const error = writeScopeError(path, ctx?.cwd ?? process.cwd(), writeRoot);
      return error ? { block: true, reason: error } : undefined;
    }
    if (event.toolName !== "bash") return undefined;
    const input = event.input as { command?: unknown };
    const command = String(input.command ?? "");
    const verdict = checkCommand(command, grants);
    if (!verdict.allowed) {
      // 허용을 물을 수 있는 명령이면 기록해 두고, 실행이 끝나면 실행기가 사용자에게 묻는다 (설계 §4 "권한 요청")
      if (verdict.grantable && blockedPath && isGrantableName(verdict.grantable)) {
        await appendBlocked(blockedPath, { name: verdict.grantable, command: command.slice(0, 300), at: Date.now() }).catch(() => undefined);
        return {
          block: true,
          reason:
            `읽기 전용 명령만 실행할 수 있습니다: ${verdict.reason}. ` +
            `사용자에게 ${verdict.grantable} 허용을 요청해 두었다. 다른 명령으로 우회하지 말고, 할 수 있는 만큼만 하고 무엇이 막혔는지 요약에 적어라.`,
        };
      }
      return { block: true, reason: `읽기 전용 명령만 실행할 수 있습니다: ${verdict.reason}` };
    }
    if (process.platform === "win32" && !command.startsWith(UTF8_PREFIX)) input.command = `${UTF8_PREFIX}\n${command}`;
    return undefined;
  });
}
