/**
 * Pi 준비 상태와, 그것으로 화면에 띄울 안내 (설계 DESIGN-AGENT.md §0 "Pi 관리").
 * 메인이 데몬(pi.status·pi.models)에서 모아 보내고, 렌더러가 안내로 바꾼다. 렌더러에서도 쓰므로 import하지 않는다.
 */

export interface PiSetupView {
  /** 찾은 Pi 버전. 못 찾았으면 없음 */
  piVersion?: string;
  piError?: string;
  node: { version?: string; required?: string; ok: boolean };
  /** Windows만: Pi bash 툴이 쓸 Git Bash */
  gitBash?: { found: boolean };
  /** 자격 증명이 있는 프로바이더 이름 (auth.json) */
  authProviders: string[];
  /** 쓸 수 있는 모델 (인증이 있는 프로바이더의 모델) */
  models: Array<{ provider: string; id: string }>;
  modelsError?: string;
  /** 설치된 Pi Desktop 위치 */
  piDesktopPath?: string;
  platform: string;
}

export interface SetupIssue {
  kind: "no-pi" | "node" | "no-models" | "git-bash";
  level: "error" | "warn";
  title: string;
  detail: string;
}

export function piSetupIssues(setup: PiSetupView): SetupIssue[] {
  const issues: SetupIssue[] = [];
  if (!setup.piVersion) {
    issues.push({
      kind: "no-pi",
      level: "error",
      title: "Pi를 찾지 못했습니다",
      detail: "Pi Desktop을 설치해 Pi를 설치·로그인하거나, 터미널에서 npm으로 설치하세요.",
    });
    return issues;
  }
  if (!setup.node.ok) {
    issues.push({
      kind: "node",
      level: "error",
      title: `Node.js ${setup.node.required ?? "22.19 이상"}이 필요합니다`,
      detail: `지금 Node: ${setup.node.version ?? "알 수 없음"}. Node.js를 업데이트한 뒤 앱을 다시 여세요.`,
    });
  }
  if (setup.models.length === 0) {
    issues.push({
      kind: "no-models",
      level: "error",
      title: "쓸 수 있는 모델이 없습니다",
      detail: "프로바이더 로그인·API 키·모델 설정은 Pi Desktop에서 합니다. Pi Desktop의 프로바이더 화면에서 로그인하거나 키를 넣은 뒤 \"다시 확인\"을 누르세요.",
    });
  }
  if (setup.platform === "win32" && setup.gitBash && !setup.gitBash.found) {
    issues.push({
      kind: "git-bash",
      level: "warn",
      title: "Git Bash가 없습니다",
      detail: "Pi의 명령 실행(bash) 도구에 필요합니다. Git for Windows를 설치하세요.",
    });
  }
  return issues;
}
