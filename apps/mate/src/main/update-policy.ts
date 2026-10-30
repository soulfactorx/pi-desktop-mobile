/**
 * Mate 자동 업데이트 규칙 (설계 DESIGN-MATE.md §11). electron 없이 판단하는 순수 함수라 테스트한다.
 * 확인 창의 말과 방식은 Pi Desktop(apps/desktop/src/main/update-policy.ts)과 같게 하되, 앱끼리 import하지 않으려고 따로 둔다.
 *
 * Pi Desktop과 다른 점: Mate 릴리스는 같은 저장소에 "Latest"가 아닌 릴리스로 올라간다(Pi Desktop 자동 업데이트와 섞이지 않게).
 * 그래서 electron-updater의 GitHub 방식(Latest만 봄)을 쓰지 않고, 릴리스 목록에서 가장 높은 mate-v* 태그를 찾아
 * 그 릴리스의 내려받기 주소를 generic 방식으로 넘긴다.
 */

export type UpdateMode = "auto" | "notify";

/** Windows(NSIS)·Linux AppImage는 내려받아 설치, 서명 없는 macOS·deb는 알리기만 */
export function updateMode(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): UpdateMode {
  if (platform === "win32") return "auto";
  if (platform === "linux" && env.APPIMAGE) return "auto";
  return "notify";
}

/** 저장소 package.json 버전 그대로인 로컬 빌드. 시험용 업데이트 주소가 없으면 확인하지 않는다 */
export const LOCAL_BUILD_VERSION = "0.0.1";
export const TEST_FEED_ENV = "PI_DESKTOP_MATE_UPDATE_URL";

export function isLocalBuild(version: string, env: NodeJS.ProcessEnv): boolean {
  return version === LOCAL_BUILD_VERSION && !env[TEST_FEED_ENV];
}

export interface GithubRelease {
  tag_name: string;
  draft?: boolean;
  prerelease?: boolean;
  html_url?: string;
}

const MATE_TAG = /^mate-v(\d+)\.(\d+)\.(\d+)$/;

function parts(version: string): [number, number, number] | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

export function compareVersions(a: string, b: string): number {
  const pa = parts(a) ?? [0, 0, 0];
  const pb = parts(b) ?? [0, 0, 0];
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return 0;
}

/**
 * 릴리스 목록에서 가장 높은 Mate 릴리스(mate-vX.Y.Z, 초안·사전 릴리스 제외)를 찾는다.
 * Pi Desktop(v*)·Agent 릴리스는 고르지 않는다.
 */
export function latestMateRelease(releases: GithubRelease[]): { tag: string; version: string; url?: string } | undefined {
  let best: { tag: string; version: string; url?: string } | undefined;
  for (const r of releases) {
    const m = MATE_TAG.exec(r.tag_name);
    if (!m || r.draft || r.prerelease) continue;
    const version = `${m[1]}.${m[2]}.${m[3]}`;
    if (!best || compareVersions(version, best.version) > 0) best = { tag: r.tag_name, version, ...(r.html_url ? { url: r.html_url } : {}) };
  }
  return best;
}

/** 그 릴리스의 내려받기 주소 (generic 방식 업데이트 주소: 여기서 latest.yml과 설치 파일을 받는다) */
export function releaseDownloadBase(owner: string, repo: string, tag: string): string {
  return `https://github.com/${owner}/${repo}/releases/download/${tag}`;
}

/** 사용자에게 묻거나 알리는 창의 내용 (main의 dialog.showMessageBox에 그대로 넘긴다) */
export interface UpdatePrompt {
  type: "info" | "question" | "warning" | "error";
  message: string;
  detail: string;
  /** 첫 버튼이 기본(확인) 동작이다. 버튼이 하나면 알리기만 한다 */
  buttons: string[];
}

export function availablePrompt(mode: UpdateMode, current: string, version: string): UpdatePrompt {
  return mode === "auto"
    ? {
        type: "question",
        message: `Pi Desktop Mate 새 버전 ${version}이(가) 있습니다. 업데이트할까요?`,
        detail: `지금 버전은 ${current}입니다. 업데이트를 누르면 내려받은 뒤, 다시 시작해 설치할지 한 번 더 묻습니다.`,
        buttons: ["업데이트", "나중에"],
      }
    : {
        type: "question",
        message: `Pi Desktop Mate 새 버전 ${version}이(가) 있습니다.`,
        detail: `지금 버전은 ${current}입니다. 이 OS에서는 자동 설치가 되지 않아 릴리스 페이지에서 내려받습니다.`,
        buttons: ["릴리스 페이지 열기", "나중에"],
      };
}

export function restartPrompt(version: string): UpdatePrompt {
  return {
    type: "question",
    message: `${version} 업데이트를 내려받았습니다. 지금 다시 시작해 설치할까요?`,
    detail: "설치하는 동안 실행기를 잠시 멈추고, 다시 시작하면 새 실행기로 이어서 돕니다. 나중에를 고르면 앱을 끌 때 설치합니다.",
    buttons: ["지금 다시 시작해 설치", "나중에"],
  };
}

export function resultPrompt(status: "none" | "error" | "disabled" | "downloading", current: string, error?: string): UpdatePrompt {
  switch (status) {
    case "none":
      return { type: "info", message: "최신 버전입니다.", detail: `지금 버전 ${current}이(가) 가장 새 Pi Desktop Mate입니다.`, buttons: ["확인"] };
    case "downloading":
      return { type: "info", message: "업데이트를 내려받는 중입니다.", detail: "다 받으면 다시 시작해 설치할지 묻습니다.", buttons: ["확인"] };
    case "disabled":
      return { type: "info", message: "업데이트를 확인하지 않는 실행입니다.", detail: error ?? "", buttons: ["확인"] };
    case "error":
      return {
        type: "error",
        message: "업데이트를 확인하지 못했습니다.",
        detail: `${error ?? "알 수 없는 오류"}\n인터넷 연결(VPN·프록시)을 확인한 뒤 다시 시도하세요.`,
        buttons: ["확인"],
      };
  }
}

/** 시작한 뒤 처음 확인까지와 그 뒤 확인 간격 */
export const FIRST_CHECK_MS = 20_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
