import { posix, resolve, win32 } from "node:path";
import type { ApprovalRequest, Risk } from "../../src/approval";
import { defaultOutputPath, inferMode } from "../documents/chunks";
import { argvLine, compileElevated, ELEVATED_TOOL, type ElevatedInput } from "../elevation/compile";
import { linuxPackageManager } from "../elevation/run";
import { userSkillsDir } from "../skills/store";

/**
 * 승인 판단의 순수 로직. 파일·프로세스·Pi에 손대지 않으므로 단위 테스트로 확인한다.
 *
 * 위험 명령 판별은 desktop-agent의 Permission Gateway에서 실제로 겪은 일을 바탕으로 옮겨 왔다.
 * 이 목록은 샌드박스가 아니라 사고 방지턱이다 (설계 DESIGN-AGENT.md §1 "승인은 동의 절차").
 */

export interface Classified {
  risk: Risk;
  request?: ApprovalRequest;
  /** 입력이 잘못돼 묻지 않고 막을 때 그 이유 (권한 상승) */
  invalid?: string;
}

/** 바깥을 바꾸지 않는 도구. Pi 기본 읽기 도구, 묻기만 하는 ask_user, 에이전트 자신의 기억만 바꾸는 memory_* (저장할 때마다 알린다) */
const READ_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "ask_user",
  "memory_save",
  "memory_forget",
  "memory_read",
  "memory_search",
  // 작업 맡기기는 그 자체로 바깥을 바꾸지 않는다. 워커가 하는 일은 워커 안에서 다시 승인을 받는다
  "delegate_task",
  "list_tasks",
  "cancel_task",
  "list_schedules",
  "cancel_schedule",
  "list_peers",
]);
/** 바깥으로 요청을 보내는 도구. 주소에 데이터를 실어 내보낼 수 있으므로 묻는다 */
const NETWORK_TOOLS = new Set(["web_fetch"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);
const FILE_TOOLS = new Set(["write", "edit"]);

/** 도구 호출 하나를 위험도와 승인 요청으로 바꾼다. 모르는 도구(다른 확장·MCP)는 실행으로 보고 묻는다 */
export function classify(toolName: string, input: Record<string, unknown>): Classified {
  if (READ_TOOLS.has(toolName)) return { risk: "read" };
  if (SHELL_TOOLS.has(toolName)) {
    const command = String(input.command ?? "");
    return {
      risk: "exec",
      request: { toolName, risk: "exec", summary: "명령 실행", target: command, pattern: commandPattern(command) },
    };
  }
  if (FILE_TOOLS.has(toolName)) {
    const path = String(input.path ?? "");
    return {
      risk: "write",
      request: {
        toolName,
        risk: "write",
        summary: toolName === "edit" ? "파일 고치기" : "파일 쓰기",
        target: path,
        pattern: folderPattern(path),
      },
    };
  }
  if (toolName === "process_document") {
    // 요약·질문(reduce)은 읽기와 같다. 번역·교정(transform)은 결과 파일을 쓰므로 그 경로로 묻는다
    const mode = input.mode === "transform" || input.mode === "reduce" ? input.mode : inferMode(String(input.instruction ?? ""));
    if (mode === "reduce") return { risk: "read" };
    const output = String(input.output ?? defaultOutputPath(String(input.path ?? "")));
    return { risk: "write", request: { toolName, risk: "write", summary: "문서 처리 결과 쓰기", target: output, pattern: folderPattern(output) } };
  }
  if (toolName === "schedule_task") {
    // 앞으로 사람 없이 되풀이될 실행을 남기는 일이라 묻는다 (실행 자체는 쓰기·실행이 거부된 채 돈다)
    const when = input.kind === "once" ? `한 번 ${String(input.at ?? "")}` : input.kind === "interval" ? `${String(input.minutes ?? "")}분마다` : `매일 ${String(input.time ?? "")}`;
    const target = `${when}: ${String(input.instruction ?? "")}`;
    return { risk: "write", request: { toolName, risk: "write", summary: "예약 등록", target, pattern: "*" } };
  }
  if (toolName === ELEVATED_TOOL) {
    // 승인 화면에 실제로 실행될 argv를 그대로 보인다. 잘못된 입력이면 묻지 않고 막는다 (invalid)
    let target: string;
    let invalid: string | undefined;
    try {
      target = argvLine(compileElevated(input as unknown as ElevatedInput, process.platform, linuxPackageManager()));
    } catch (error) {
      invalid = error instanceof Error ? error.message : String(error);
      target = invalid;
    }
    return {
      risk: "exec",
      request: { toolName, risk: "exec", summary: "관리자 권한으로 실행", target, pattern: "", onceOnly: true },
      ...(invalid ? { invalid } : {}),
    };
  }
  if (toolName === "skill_save") {
    // 앞으로의 동작을 바꾸는 파일을 남긴다. 사용자 스킬 폴더 단위로 계속 허용할 수 있다
    const name = String(input.name ?? "");
    const target = `${userSkillsDir().replace(/\\/g, "/")}/${name}/SKILL.md`;
    return { risk: "write", request: { toolName, risk: "write", summary: input.replace ? "스킬 고치기" : "스킬 저장", target, pattern: `${userSkillsDir().replace(/\\/g, "/")}/**` } };
  }
  if (toolName === "delegate_to_peer") {
    const peer = String(input.peer ?? "");
    return {
      risk: "network",
      request: { toolName, risk: "network", summary: "피어에게 작업 맡기기", target: `${peer}: ${String(input.title ?? "")}\n${String(input.instruction ?? "")}`, pattern: `${peer}:*` },
    };
  }
  if (toolName === "ask_peer") {
    // 대화 내용을 다른 사람의 에이전트로 보낸다. 피어 단위로 계속 허용할 수 있다
    const peer = String(input.peer ?? "");
    return { risk: "network", request: { toolName, risk: "network", summary: "피어에게 묻기", target: `${peer}: ${String(input.question ?? "")}`, pattern: `${peer}:*` } };
  }
  if (NETWORK_TOOLS.has(toolName)) {
    const url = String(input.url ?? "");
    return { risk: "network", request: { toolName, risk: "network", summary: "웹 요청", target: url, pattern: originPattern(url) } };
  }
  const target = JSON.stringify(input).slice(0, 500);
  return { risk: "exec", request: { toolName, risk: "exec", summary: "도구 실행", target, pattern: "*" } };
}

/** "git status --short" → "git status*" (첫 두 낱말까지) */
export function commandPattern(command: string): string {
  const words = command.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "*";
  return `${words.slice(0, Math.min(2, words.length)).join(" ")}*`;
}

/** "https://a.com/x?y" → "https://a.com/**" (같은 사이트 전부). 주소가 아니면 그대로 */
export function originPattern(url: string): string {
  try {
    return `${new URL(url).origin}/**`;
  } catch {
    return url || "*";
  }
}

/** "src/a/b.ts" → "src/a/**" (그 파일이 있는 폴더 아래 전부) */
export function folderPattern(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash < 0 ? "*" : `${normalized.slice(0, slash)}/**`;
}

/**
 * 패턴 매칭. `/`가 들어간 패턴은 경로 글롭(`**` 아무 깊이, `*` 한 단계), 아니면 끝의 `*`만 접두사 매칭.
 * Windows 경로는 `/`로 바꿔 비교한다.
 */
export function patternMatches(pattern: string, target: string): boolean {
  const pat = pattern.replace(/\\/g, "/");
  const tgt = target.replace(/\\/g, "/");
  if (pat === "*") return true;
  if (pat.includes("/")) {
    const source = pat
      .split("**")
      .map((part) => part.split("*").map(escapeRegex).join("[^/]*"))
      .join(".*");
    return new RegExp(`^${source}$`, "i").test(tgt);
  }
  if (pat.endsWith("*")) return tgt.startsWith(pat.slice(0, -1));
  return tgt === pat;
}

function escapeRegex(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

export interface Rule {
  toolName: string;
  pattern: string;
  action: "allow" | "deny";
}

/** 거부 규칙이 먼저, 그다음 허용 규칙. 맞는 것이 없으면 undefined (사람에게 묻는다) */
export function evaluate(rules: Rule[], toolName: string, target: string): "allow" | "deny" | undefined {
  const mine = rules.filter((r) => r.toolName === toolName);
  if (mine.some((r) => r.action === "deny" && patternMatches(r.pattern, target))) return "deny";
  if (mine.some((r) => r.action === "allow" && patternMatches(r.pattern, target))) return "allow";
  return undefined;
}

/**
 * 셸 문자열에서 "명령 이름이 올 수 있는 자리"만 뽑는다.
 *
 * 인용 구간은 데이터이므로 지운다 — `grep -E "shutdown|reboot" log`처럼 인자에 든 낱말 때문에 정상 조회가
 * 막히는 일이 실제로 있었다. 다만 `sh -c "..."`의 인용 안은 실행될 명령이므로 먼저 꺼내 다시 본다.
 */
const SHELL_C_BODY = /\b(?:sh|bash|zsh|dash|ksh)\s+(?:-[a-z]+\s+)*-c\s+(['"])([\s\S]*?)\1/gi;
const QUOTED = /'[^']*'|"[^"]*"/g;
const SEPARATORS =
  /[\n;|&()`]+|\$\(|\bxargs\s+(?:-\S+\s+)*|\s-exec\s+|\b(?:time|nohup|env|nice|watch|sudo|doas|pkexec|runas|command|exec)\s+/gi;

function commandHeads(command: string, depth = 0): string[] {
  const heads: string[] = [];
  if (depth < 3) {
    for (const m of command.matchAll(SHELL_C_BODY)) heads.push(...commandHeads(m[2] ?? "", depth + 1));
  }
  const bare = command.replace(SHELL_C_BODY, " ").replace(QUOTED, " ");
  for (const part of bare.split(SEPARATORS)) {
    const head = part.trim();
    if (head) heads.push(head);
  }
  return heads;
}

/** 명령 자리에 왔을 때만 파괴적인 것들 */
const DESTRUCTIVE_HEAD = [
  /^(?:shutdown|reboot|poweroff|halt)\b/i,
  /^systemctl\s+(?:-\S+\s+)*(?:reboot|poweroff|halt|kexec)\b/i,
  /^init\s+[06]\b/i,
  /^mkfs(?:\.\S+)?\b/i,
  /^dd\s+[^|]*\bif=/i,
  /^rm\s+(?:-[a-z]*\s+)*(?:\/|~\/?$|\/\*)/i,
  /^format\s+[a-z]:/i,
  /^del\s+\/[sq]\s+[a-z]:\\/i,
  /^(?:Stop-Computer|Restart-Computer|Format-Volume)\b/i,
];

/** 조각내면 형태가 깨져 명령 전체에서 봐야 하는 것 (포크 폭탄) */
const DESTRUCTIVE_WHOLE = [/:\(\)\s*\{\s*:\|:&\s*\}/];

/**
 * 권한 상승 시도. 상승 실행은 P5의 별도 도구로만 연다 (설계 §4 "권한 상승").
 * `su''do`처럼 인용으로 쪼갠 우회도 잡도록 따옴표·백슬래시를 지운 것도 한 번 더 본다.
 */
const ELEVATION =
  /(^|[\s;&|(){}'"`$=])(sudo|doas|pkexec|runas|su)(\s|$)|Start-Process[^|]*-Verb\s+RunAs|with\s+administrator\s+privileges/i;

/** 승인으로도 열 수 없는 명령이면 그 이유, 아니면 undefined */
export function hardBlockReason(command: string): string | undefined {
  if (ELEVATION.test(command) || ELEVATION.test(command.replace(/['"\\]/g, ""))) {
    return `권한 상승(sudo·runas 등)은 이 도구로 실행할 수 없다. 관리자 권한이 꼭 필요하면 ${ELEVATED_TOOL}(설정에서 켠 경우에만 보인다)를 쓰거나 사용자에게 직접 실행해 달라고 하라`;
  }
  if (DESTRUCTIVE_WHOLE.some((re) => re.test(command)) || commandHeads(command).some((h) => DESTRUCTIVE_HEAD.some((re) => re.test(h)))) {
    return "시스템을 끄거나 디스크·파일 시스템 전체를 지우는 명령은 실행할 수 없다";
  }
  return undefined;
}

/** 경로를 다루는 도구와 그 경로 칸 (없으면 작업 폴더) */
const PATH_TOOLS: Record<string, string[]> = {
  read: ["path"],
  write: ["path"],
  edit: ["path"],
  ls: ["path"],
  grep: ["path"],
  find: ["path"],
  process_document: ["path", "output"],
};

/** 기억을 바꾸는 도구. 남이 맡긴 작업이 이 PC의 기억을 바꾸지 못하게 한다 */
const MEMORY_WRITE_TOOLS = new Set(["memory_save", "memory_forget"]);

/** path가 root 안인가 (Windows는 대소문자를 가리지 않는다) */
export function insideRoot(path: string, root: string, platform: NodeJS.Platform = process.platform): boolean {
  // 경로 규칙은 그 플랫폼의 것으로 (Windows 경로를 다른 OS에서 판단할 때도 맞게)
  const p = platform === "win32" ? win32 : posix;
  const norm = (x: string) => (platform === "win32" ? x.toLowerCase() : x);
  const rel = p.relative(norm(p.resolve(root)), norm(p.resolve(path)));
  return rel === "" || (!rel.startsWith("..") && !p.isAbsolute(rel));
}

/**
 * 피어가 맡긴 작업(폴더에 갇힌 워커)에서 막을 호출이면 그 이유. 경로 도구는 root 밖을 못 보고, 기억은 못 바꾼다.
 * 경로 칸이 없으면 작업 폴더(cwd)로 본다.
 */
export function confinementViolation(toolName: string, input: Record<string, unknown>, cwd: string, root: string): string | undefined {
  if (MEMORY_WRITE_TOOLS.has(toolName)) return "맡겨진 작업에서는 이 PC의 기억을 바꿀 수 없다";
  const fields = PATH_TOOLS[toolName];
  if (!fields) return undefined;
  for (const field of fields) {
    const raw = input[field];
    const path = typeof raw === "string" && raw.trim() ? resolve(cwd, raw) : cwd;
    if (!insideRoot(path, root)) return `맡겨진 작업은 승인된 폴더(${root}) 밖을 읽거나 쓸 수 없다: ${path}`;
  }
  return undefined;
}
