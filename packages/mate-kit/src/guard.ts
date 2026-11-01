import { isToolGrant } from "./shared";

/**
 * observe·propose 단계에서 bash로 실행해도 되는 읽기 명령인지 판정한다 (설계 DESIGN-MATE.md §4).
 *
 * 허용 목록 방식이다. 목록에 없는 명령, 리다이렉트(`>`), 명령 치환(`$(…)`, 백틱), 프로세스 치환은 막는다.
 * `&&`·`||`·`;`·`|`·줄바꿈으로 이은 명령은 모든 단계가 허용될 때만 통과한다.
 * 확장 hook은 보안 경계가 아니므로(Pi security.md) "실수로 손대지 않게" 하는 장치로 본다.
 */
/**
 * grantable: 허용 목록에 없을 뿐인 명령 이름. 사용자가 그 임무에 허용하면(grants) 다음부터 통과한다.
 * 쓰기·명령 치환처럼 구조 때문에 막힌 것과, git·gh·npm처럼 쓰기 하위 명령이 있는 것은 허용을 묻지 않는다.
 */
export type CommandVerdict = { allowed: true } | { allowed: false; reason: string; grantable?: string };

/** 인자와 상관없이 읽기만 하는 명령 */
const READ_ONLY = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "rg", "pwd", "echo", "date", "which", "whoami", "uname",
  "du", "df", "sort", "uniq", "cut", "tr", "jq", "file", "stat", "tree", "basename", "dirname", "realpath",
  "true", "test", "diff", "cd",
]);

const GIT_READ = new Set([
  "status", "log", "diff", "show", "rev-parse", "describe", "blame", "ls-files", "shortlog", "rev-list", "cat-file",
]);

/** git branch·tag에서 목록 보기에 쓰는 옵션 */
const GIT_LIST_FLAGS = /^(-a|-r|-v|-vv|-l|--list|--all|--remotes|--verbose|--contains|--merged|--no-merged|--points-at|--sort=.*|--format=.*|--no-color|--color=.*)$/;

const GH_NOUNS = new Set(["pr", "run", "issue", "repo", "release", "workflow"]);
const GH_VERBS = new Set(["view", "list", "checks", "status", "diff"]);

const NPM_READ = new Set(["ls", "list", "outdated", "view", "info", "audit", "--version", "-v"]);

/** 출력 버리기는 허용한다 (`2>&1`, `> /dev/null`, `2>/dev/null`) */
const HARMLESS_REDIRECT = /[12]?>\s*\/dev\/null|2>&1/g;

/**
 * @param grants 사용자가 그 임무에 허용한 명령 이름 (예: curl). 허용해도 리다이렉트·명령 치환은 여전히 막고,
 *   curl·wget은 파일 쓰기·데이터 보내기 옵션을 막는다 (읽어 오기만 허용)
 */
export function checkCommand(command: string, grants: readonly string[] = []): CommandVerdict {
  const split = splitCommand(command.replace(HARMLESS_REDIRECT, " "));
  if ("reason" in split) return deny(split.reason);
  if (split.segments.length === 0) return deny("빈 명령입니다");
  for (const words of split.segments) {
    const verdict = checkSegment(words, grants);
    if (!verdict.allowed) return verdict;
  }
  return { allowed: true };
}

/**
 * 따옴표를 지키며 명령을 단계(segment)와 낱말로 나눈다.
 * 따옴표 밖의 `&&`, `||`, `|`, `;`, `&`, 줄바꿈은 단계 구분이고, 따옴표 밖의 `<`·`>`와
 * 작은따옴표 밖의 `$(`·백틱은 거부한다.
 */
export function splitCommand(command: string): { segments: string[][] } | { reason: string } {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: '"' | "'" | undefined;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote !== "'" && (c === "`" || (c === "$" && command[i + 1] === "("))) return { reason: "명령 치환은 쓸 수 없습니다" };
    if (quote) {
      if (c === quote) quote = undefined;
      else word += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      inWord = true;
    } else if (c === "<" || c === ">") {
      return { reason: "리다이렉트(>, <)는 쓸 수 없습니다" };
    } else if (c === "|" || c === "&" || c === ";" || c === "\n") {
      endSegment();
    } else if (/\s/.test(c)) {
      endWord();
    } else {
      word += c;
      inWord = true;
    }
  }
  if (quote) return { reason: "따옴표가 닫히지 않았습니다" };
  endSegment();
  return { segments };
}

function checkSegment(words: string[], grants: readonly string[]): CommandVerdict {
  const [cmd = "", ...args] = words;
  const name = cmd.replace(/\.exe$/i, "");
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(name)) return deny("환경 변수를 바꿔 실행할 수 없습니다");
  if (READ_ONLY.has(name)) return { allowed: true };
  switch (name) {
    case "find":
      return args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(a))
        ? deny("find의 실행·삭제·쓰기 옵션은 쓸 수 없습니다")
        : { allowed: true };
    case "git":
      return checkGit(args);
    case "gh":
      return checkGh(args);
    case "npm":
      if (args[0] === "audit" && args.includes("fix")) return deny("npm audit fix는 쓸 수 없습니다");
      return args[0] && NPM_READ.has(args[0]) ? { allowed: true } : deny(`npm ${args[0] ?? ""}은(는) 허용 목록에 없습니다`);
    case "node":
    case "pi":
      return args.length === 1 && /^(-v|--version)$/.test(args[0]!) ? { allowed: true } : deny(`${name}은(는) 버전 확인만 쓸 수 있습니다`);
    default:
      if (grants.includes(name) && isGrantableName(name)) return checkGranted(name, args);
      return {
        allowed: false,
        reason: `${name}은(는) 읽기 전용 허용 목록에 없습니다`,
        ...(isGrantableName(name) ? { grantable: name } : {}),
      };
  }
}

/**
 * 허용을 묻지 않는 명령: 파일을 바꾸거나 지우는 것, 다른 명령을 대신 실행하는 셸·래퍼, 권한 상승.
 * 읽기 단계 임무에 이런 것을 허용하면 단계의 뜻이 없어지므로 막기만 한다.
 */
const NEVER_GRANT = new Set([
  "rm", "rmdir", "del", "erase", "mv", "move", "cp", "copy", "dd", "ln", "mkdir", "touch", "tee", "truncate", "shred",
  "chmod", "chown", "chgrp", "sed", "awk", "perl", "patch", "install", "rsync", "scp", "tar", "unzip", "zip",
  "sh", "bash", "zsh", "fish", "dash", "cmd", "powershell", "pwsh", "env", "xargs", "eval", "exec", "nohup", "timeout", "watch",
  "sudo", "su", "doas", "runas", "kill", "pkill", "killall", "shutdown", "reboot", "systemctl", "service", "crontab", "at",
  "git", "gh", "npm", "npx", "pnpm", "yarn", "node", "pi", "deno", "bun", "pip", "pip3", "cargo", "go", "make",
  "python", "python3", "py", "ruby", "php", "osascript", "wscript", "cscript", "mshta",
]);

/** 임무에 저장할 수 있는 허용 이름인지: bash 명령 이름, MCP 도구 이름, 패키지 도구 허용 이름(ext__) */
export function isGrant(name: string): boolean {
  return isGrantableName(name) || isToolGrant(name);
}

/** 허용을 물을 수 있는 명령 이름인지 (경로·옵션이 아닌 이름이고, NEVER_GRANT가 아님) */
export function isGrantableName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9._+-]{0,40}$/.test(name) && !NEVER_GRANT.has(name.toLowerCase());
}

/** curl·wget으로 파일을 쓰거나 데이터를 보내는 옵션 (허용해도 읽어 오기만 하게) */
const FETCH_WRITE = /^(-o|-O|--output|--output-dir|--remote-name|--remote-name-all|-T|--upload-file|-d|--data.*|-F|--form.*|--json|-X|--request|--post-data|--post-file|--body-data|--body-file|-P|--directory-prefix|--method)(=.*)?$/;

function checkGranted(name: string, args: string[]): CommandVerdict {
  const readOnly = `${name}은(는) 읽어 오기만 허용되어 있습니다 (파일 쓰기·데이터 보내기 옵션은 쓸 수 없습니다)`;
  if (name === "curl" && args.some((a) => FETCH_WRITE.test(a) || /^-[a-zA-Z]*[oOTdFX]/.test(a))) return deny(readOnly);
  if (name === "wget") {
    // wget은 옵션이 없으면 파일로 저장하므로, 표준 출력으로 받을 때(-O- 또는 -qO-)만 통과시킨다
    const toStdout = args.some((a) => /^-q?O-$/.test(a));
    const others = args.filter((a) => !/^-q?O-$/.test(a));
    if (!toStdout || others.some((a) => FETCH_WRITE.test(a))) return deny(`${readOnly} — wget은 -O-로 화면에 받아야 합니다`);
  }
  return { allowed: true };
}

function checkGit(args: string[]): CommandVerdict {
  // git -C <폴더> … 는 폴더만 바꾸므로 건너뛴다
  const rest = args[0] === "-C" ? args.slice(2) : args;
  const [sub = "", ...subArgs] = rest;
  if (GIT_READ.has(sub)) return { allowed: true };
  if (sub === "branch" || sub === "tag") {
    // 이름을 주면 만들기가 되므로, 이름(패턴)은 --list와 함께일 때만 허용한다
    const listMode = subArgs.includes("-l") || subArgs.includes("--list");
    const ok = subArgs.every((a) => (a.startsWith("-") ? GIT_LIST_FLAGS.test(a) : listMode));
    return ok ? { allowed: true } : deny(`git ${sub}는 목록 보기만 쓸 수 있습니다`);
  }
  if (sub === "remote") {
    return subArgs.length === 0 || (subArgs.length === 1 && subArgs[0] === "-v") ? { allowed: true } : deny("git remote는 목록 보기만 쓸 수 있습니다");
  }
  if (sub === "stash" && subArgs[0] === "list") return { allowed: true };
  return deny(`git ${sub}은(는) 읽기 전용 허용 목록에 없습니다`);
}

function checkGh(args: string[]): CommandVerdict {
  const [noun = "", verb = ""] = args;
  if (noun === "status" || (noun === "auth" && verb === "status")) return { allowed: true };
  if (GH_NOUNS.has(noun) && GH_VERBS.has(verb)) return { allowed: true };
  return deny(`gh ${noun} ${verb}은(는) 읽기 전용 허용 목록에 없습니다`);
}

function deny(reason: string): CommandVerdict {
  return { allowed: false, reason };
}
