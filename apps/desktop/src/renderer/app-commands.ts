import type { PiCommand } from "./composer-input";

/**
 * 입력창 `/` 앱 명령 (설계 §4.1 입력창).
 *
 * Pi RPC의 get_commands는 확장 명령·프롬프트 템플릿·스킬만 준다. TUI의 기본 명령(/model, /compact, /tree …)은
 * TUI가 직접 처리하므로 RPC로는 오지 않는다. 그래서 같은 이름의 명령을 앱이 직접 처리한다.
 * Pi(확장 등)에 같은 이름의 명령이 있으면 Pi의 것을 쓴다.
 */

export interface AppSlashCommand {
  name: string;
  description: string;
  /** 인자 안내 (자동완성에 보인다) */
  args?: string;
  /** GUI에서 아직 하지 못하는 명령이면 그 안내 (Pi에 글로 보내지 않고 이 안내를 보인다) */
  unsupported?: string;
}

const TUI_ONLY = "GUI에서는 아직 지원하지 않습니다. 터미널 pi(TUI)에서 쓰세요 (명령 팔레트 \"터미널: pi 열기\").";

export const APP_SLASH_COMMANDS: AppSlashCommand[] = [
  { name: "model", args: "[provider/model]", description: "모델 고르기 (인자가 있으면 바로 바꿈)" },
  { name: "thinking", args: "[level]", description: "Thinking 수준 (off·minimal·low·medium·high·xhigh·max)" },
  { name: "compact", args: "[지시]", description: "대화를 요약해 컨텍스트 줄이기" },
  { name: "new", description: "같은 폴더에서 새 세션" },
  { name: "resume", description: "저장된 다른 세션으로 (명령 팔레트에서 고름)" },
  { name: "name", args: "[이름]", description: "세션 이름 바꾸기 (인자가 없으면 지금 이름)" },
  { name: "session", description: "세션 정보와 통계" },
  { name: "tree", description: "세션 트리 열기" },
  { name: "fork", description: "앞의 메시지에서 새 세션으로 분기 (트리에서 고름)" },
  { name: "clone", description: "지금 위치까지를 새 세션으로 복제" },
  { name: "copy", description: "마지막 답변 복사" },
  { name: "export", description: "HTML로 내보내기" },
  { name: "reload", description: "확장·스킬·프롬프트·컨텍스트 다시 불러오기 (설치한 확장의 툴도 켬)" },
  { name: "settings", description: "설정 (Pi 관리 → 설정)" },
  { name: "login", args: "[provider]", description: "프로바이더 로그인 (Pi 관리 → 프로바이더)" },
  { name: "logout", description: "자격 증명 지우기 (Pi 관리 → 프로바이더)" },
  { name: "trust", description: "프로젝트 신뢰 (리소스 창)" },
  { name: "hotkeys", description: "명령과 단축키 보기 (명령 팔레트)" },
  { name: "scoped-models", description: "모델 순환 범위 설정", unsupported: TUI_ONLY },
  { name: "import", args: "<path>", description: "JSONL 세션 가져오기", unsupported: TUI_ONLY },
  { name: "share", description: "세션 공유 링크 만들기", unsupported: TUI_ONLY },
  { name: "changelog", description: "Pi 변경 기록", unsupported: TUI_ONLY },
  { name: "bug", args: "[설명]", description: "Pi 버그 보고 준비", unsupported: TUI_ONLY },
  { name: "quit", description: "탭 닫기는 Ctrl+W", unsupported: "GUI에서는 탭을 닫으세요 (Ctrl+W). 세션은 실행 중 목록에 남습니다." },
];

/** 자동완성 목록: 앱 명령(Pi에 같은 이름이 없는 것)과 Pi 명령을 합친다 */
export function withAppCommands(piCommands: readonly PiCommand[]): PiCommand[] {
  const piNames = new Set(piCommands.map((c) => c.name));
  const app = APP_SLASH_COMMANDS.filter((c) => !piNames.has(c.name)).map(
    (c): PiCommand => ({ name: c.name, description: `${c.args ? `${c.args} · ` : ""}${c.description}`, source: "app" }),
  );
  return [...app, ...piCommands];
}

/**
 * 보낸 글이 앱 명령이면 그 명령과 인자. Pi에 같은 이름의 명령이 있으면 Pi에 보내도록 undefined.
 * 명령은 첫 줄의 `/이름` 뒤에 공백이나 끝이 와야 한다.
 */
export function parseAppSlash(
  message: string,
  piCommands: readonly PiCommand[] | undefined,
): { command: AppSlashCommand; args: string } | undefined {
  const match = /^\/([a-z][\w-]*)(?:\s+([\s\S]*))?$/.exec(message.trim());
  if (!match) return undefined;
  const [, name, rest] = match;
  if (piCommands?.some((c) => c.name === name)) return undefined;
  const command = APP_SLASH_COMMANDS.find((c) => c.name === name);
  return command ? { command, args: (rest ?? "").trim() } : undefined;
}

/** `/model provider/model`의 인자를 나눈다. 모델 ID에 /가 있을 수 있어 첫 /만 가른다 */
export function splitModelArg(arg: string): { provider: string; modelId: string } | undefined {
  const index = arg.indexOf("/");
  if (index <= 0 || index === arg.length - 1) return undefined;
  return { provider: arg.slice(0, index), modelId: arg.slice(index + 1) };
}
