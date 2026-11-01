import type { ExtensionTemplate, ResourceDiagnosticInfo, ResourceSource, ResourcesView } from "@pi-desktop/host-protocol/messages";

/**
 * 리소스 창의 순수 함수들 (설계 §4.2~4.5, M4 첫 단계: 읽기 전용).
 */

export type ResourceTab = "context" | "prompts" | "skills" | "extensions" | "packages";

export const RESOURCE_TABS: ReadonlyArray<{ id: ResourceTab; label: string }> = [
  { id: "context", label: "컨텍스트" },
  { id: "prompts", label: "프롬프트" },
  { id: "skills", label: "스킬" },
  { id: "extensions", label: "확장" },
  { id: "packages", label: "패키지" },
];

/** 탭마다 항목 수 */
export function tabCount(view: ResourcesView, tab: ResourceTab): number {
  switch (tab) {
    case "context":
      return view.contextFiles.length + (view.systemPrompt ? 1 : 0) + view.appendSystemPrompt.length;
    case "prompts":
      return view.prompts.length;
    case "skills":
      return view.skills.length;
    case "extensions":
      return view.extensions.length;
    case "packages":
      return view.packages.length;
  }
}

/** 출처 배지: 패키지면 그 소스, 아니면 사용자·프로젝트 */
export function sourceLabel(source: ResourceSource): string {
  if (source.fromPackage) return source.source;
  if (source.scope === "user") return "사용자";
  if (source.scope === "project") return "프로젝트";
  if (source.scope === "temporary") return "임시";
  return source.scope;
}

/**
 * 긴 경로를 줄여 보여 준다: 데이터 폴더 안이면 "~agent/…", 작업 폴더 안이면 "./…",
 * 작업 폴더의 상위 폴더에 바로 있으면 "../파일" (AGENTS.md 계층).
 * 구분자(/, \)는 섞여 와도 같게 보고, 줄인 경로는 "/"로 보여 준다.
 */
export function shortPath(path: string, view: Pick<ResourcesView, "agentDir" | "cwd">): string {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const target = norm(path);
  const under = (base: string) => {
    const b = norm(base);
    return target.startsWith(`${b}/`) ? target.slice(b.length + 1) : undefined;
  };
  const inAgent = under(view.agentDir);
  if (inAgent !== undefined) return `~agent/${inAgent}`;
  const inCwd = under(view.cwd);
  if (inCwd !== undefined) return `./${inCwd}`;
  const slash = target.lastIndexOf("/");
  const dir = target.slice(0, slash);
  const cwd = norm(view.cwd);
  if (slash >= 0 && cwd.startsWith(`${dir}/`)) {
    const levels = cwd.slice(dir.length + 1).split("/").length;
    return `${"../".repeat(levels)}${target.slice(slash + 1)}`;
  }
  return path;
}

/** 경로별 진단 (같은 파일에 여러 개일 수 있다) */
export function diagnosticsByPath(diagnostics: readonly ResourceDiagnosticInfo[]): Map<string, ResourceDiagnosticInfo[]> {
  const map = new Map<string, ResourceDiagnosticInfo[]>();
  for (const d of diagnostics) {
    if (!d.path) continue;
    map.set(d.path, [...(map.get(d.path) ?? []), d]);
  }
  return map;
}

/** 파일 크기를 짧게 */
export function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** 탭에서 새로 만들 수 있는 리소스 종류. 없으면 그 탭에서는 만들지 않는다 */
export function creatableKind(tab: ResourceTab): "prompt" | "skill" | "agents" | "extension" | undefined {
  if (tab === "extensions") return "extension";
  return tab === "prompts" ? "prompt" : tab === "skills" ? "skill" : tab === "context" ? "agents" : undefined;
}

/** 앱에서 고칠 수 있는 리소스: 패키지에 든 것이 아닌 마크다운 파일과 확장 코드 (.ts·.js 등) */
export function isEditable(item: { path: string; fromPackage?: boolean }): boolean {
  return !item.fromPackage && /\.(md|ts|js|mts|mjs|cts|cjs)$/i.test(item.path);
}

/** 확장 템플릿 선택지 (데몬 extension-templates.ts와 같은 종류) */
export const EXTENSION_TEMPLATE_LABELS: ReadonlyArray<readonly [ExtensionTemplate, string]> = [
  ["command", "명령 (/이름) — 입력창에서 부르는 기능"],
  ["tool", "툴 — 모델이 필요할 때 부르는 기능"],
  ["guard", "확인 — 위험한 bash 명령 전에 묻기"],
  ["blank", "빈 확장"],
];

/** 비교용 경로: 구분자를 /로, 끝의 /를 빼고, Windows 경로(드라이브 문자)는 대소문자를 무시한다 */
function samePathKey(path: string): string {
  const unified = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:\//.test(unified) ? unified.toLowerCase() : unified;
}

/** 내 패키지 폴더가 설정에 설치되어 있으면 그 패키지 (로컬 경로 설치는 installedPath가 그 폴더다) */
export function installedPackageFor<T extends { installedPath?: string }>(dir: string, packages: readonly T[]): T | undefined {
  const key = samePathKey(dir);
  return packages.find((p) => p.installedPath !== undefined && samePathKey(p.installedPath) === key);
}

/** 내 패키지에서 앱으로 열어 고칠 수 있는 파일 */
export function editablePackageFiles(files: readonly string[]): string[] {
  return files.filter((f) => /\.(md|json|ts|js|mts|mjs|cts|cjs)$/i.test(f));
}

/** 폴더 경로에 이름을 붙인다. 그 경로가 쓰는 구분자(Windows면 \)를 따른다 */
export function joinPath(dir: string, ...parts: string[]): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return [dir.replace(/[\\/]+$/, ""), ...parts].join(sep);
}

/** 리소스 탭에서 지울 수 있는 것: 사용자·프로젝트 폴더에 직접 둔 것 (패키지·내장·임시는 아님) */
export function isDeletable(item: { path: string; fromPackage?: boolean; scope: string }): boolean {
  return !item.fromPackage && !item.path.startsWith("builtin:") && (item.scope === "user" || item.scope === "project");
}

/** Pi Desktop bridge 확장의 다시 불러오기 명령 (데몬 bridge.ts와 같은 이름) */
export const RELOAD_COMMAND = "desktop:reload";

/** bridge 확장의 확장 툴 켜기 명령 (데몬 bridge.ts와 같은 이름). 이어 연 세션에서 나중에 설치한 확장의 툴을 켠다 */
export const ENABLE_TOOLS_COMMAND = "desktop:enable-tools";

/** bridge 확장의 트리 이동 명령 (데몬 bridge.ts와 같은 이름). 인자는 TreeMove JSON */
export const TREE_COMMAND = "desktop:tree";

/**
 * 트리 이동 방법 (TUI /tree의 "Summarize branch?" 세 가지)
 * - summarize 없음: 요약 없이 옮긴다 (떠나는 갈래는 트리에 그대로 남는다)
 * - summarize: 떠나는 갈래를 LLM이 요약해 옮긴 위치에 남긴다
 * - instructions: 요약할 때 따를 지시 (주면 요약한다)
 */
export interface TreeMove {
  target: string;
  summarize?: boolean;
  instructions?: string;
}

/**
 * 세션에 bridge가 들어 있는지. 앱 업데이트 전에 연 세션에는 없다.
 * 없는 세션에 "/desktop:reload"를 보내면 Pi가 일반 질문으로 LLM에 보내므로, 보내기 전에 꼭 확인한다.
 */
export function hasReloadCommand(commands: ReadonlyArray<{ name: string }>): boolean {
  return commands.some((c) => c.name === RELOAD_COMMAND);
}

export const PACKAGE_TYPE_LABEL = { extensions: "확장", skills: "스킬", prompts: "프롬프트", themes: "테마" } as const;

/** 패키지 리소스 하나를 가리키는 키 (종류마다 경로가 겹칠 수 있다) */
export function packageResourceKey(item: { type: string; pattern: string }): string {
  return `${item.type}:${item.pattern}`;
}

/** 처음 상태와 달라진 것만 settings.json에 적을 변경으로 */
export function packageFilterChanges<T extends "extensions" | "skills" | "prompts" | "themes">(
  items: ReadonlyArray<{ type: T; pattern: string; enabled: boolean }>,
  checked: ReadonlyMap<string, boolean>,
): Array<{ type: T; pattern: string; enabled: boolean }> {
  return items
    .filter((item) => {
      const now = checked.get(packageResourceKey(item));
      return now !== undefined && now !== item.enabled;
    })
    .map((item) => ({ type: item.type, pattern: item.pattern, enabled: !item.enabled }));
}
