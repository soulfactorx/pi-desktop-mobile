/**
 * 자동 업데이트 방식 (M5 인스톨러·자동 업데이트). electron 없이 판단하는 순수 함수라 테스트한다.
 *
 * - Windows(NSIS 설치본): 서명이 없어도 electron-updater가 내려받아 다시 시작할 때 설치한다.
 * - Linux AppImage(APPIMAGE 환경 변수가 있음): 내려받아 바꿔 끼운다.
 * - macOS: 서명(Apple Developer ID)이 없으면 Squirrel.Mac이 설치를 거부하므로, 새 버전을 알리고 릴리스 페이지를 연다.
 * - Linux deb 등 그 밖: 패키지 관리자가 설치하므로 알리기만 한다.
 */

export type UpdateMode = "auto" | "notify";

export function updateMode(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): UpdateMode {
  if (platform === "win32") return "auto";
  if (platform === "linux" && env.APPIMAGE) return "auto";
  return "notify";
}

/**
 * 저장소의 package.json 버전 그대로인 로컬 빌드(npm run dist). 릴리스 워크플로는 태그 버전으로 바꿔서 만든다.
 * 로컬 빌드가 릴리스로 업데이트되면 시험하던 빌드가 바뀌어 버리므로 확인하지 않는다 (업데이트 시험용 PI_DESKTOP_UPDATE_URL은 예외).
 */
export const LOCAL_BUILD_VERSION = "0.0.1";

export function isLocalBuild(version: string, env: NodeJS.ProcessEnv): boolean {
  return version === LOCAL_BUILD_VERSION && !env.PI_DESKTOP_UPDATE_URL;
}

/** 그 버전의 GitHub 릴리스 페이지 */
export function releaseUrl(owner: string, repo: string, version: string): string {
  return `https://github.com/${owner}/${repo}/releases/tag/v${version.replace(/^v/, "")}`;
}

/** 사용자에게 묻거나 알리는 창의 내용 (main의 dialog.showMessageBox에 그대로 넘긴다) */
export interface UpdatePrompt {
  type: "info" | "question" | "warning" | "error";
  message: string;
  detail: string;
  /** 첫 버튼이 기본(확인) 동작이다. 버튼이 하나면 알리기만 한다 */
  buttons: string[];
}

/** 새 버전을 찾았을 때 받을지 묻는 창. auto면 내려받아 설치하고, notify면 릴리스 페이지를 연다 */
export function availablePrompt(mode: UpdateMode, current: string, version: string): UpdatePrompt {
  return mode === "auto"
    ? {
        type: "question",
        message: `새 버전 ${version}이(가) 있습니다. 업데이트할까요?`,
        detail: `지금 버전은 ${current}입니다. 업데이트를 누르면 내려받은 뒤, 다시 시작해 설치할지 한 번 더 묻습니다.`,
        buttons: ["업데이트", "나중에"],
      }
    : {
        type: "question",
        message: `새 버전 ${version}이(가) 있습니다.`,
        detail: `지금 버전은 ${current}입니다. 이 OS에서는 자동 설치가 되지 않아 릴리스 페이지에서 내려받습니다.`,
        buttons: ["릴리스 페이지 열기", "나중에"],
      };
}

/** 내려받기를 마쳤을 때 지금 다시 시작해 설치할지 묻는 창 */
export function restartPrompt(version: string): UpdatePrompt {
  return {
    type: "question",
    message: `${version} 업데이트를 내려받았습니다. 지금 다시 시작해 설치할까요?`,
    detail: "나중에를 고르면 앱을 끌 때 설치합니다. 열린 Pi 세션은 Host Agent에서 계속 돕니다.",
    buttons: ["지금 다시 시작해 설치", "나중에"],
  };
}

/** 사용자가 직접 확인했는데 받을 업데이트가 없거나 확인할 수 없을 때 알리는 창 */
export function resultPrompt(status: "none" | "error" | "disabled" | "downloading", current: string, error?: string): UpdatePrompt {
  switch (status) {
    case "none":
      return { type: "info", message: "최신 버전입니다.", detail: `지금 버전 ${current}이(가) 가장 새 버전입니다.`, buttons: ["확인"] };
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
export const FIRST_CHECK_MS = 15_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
