/**
 * Mate의 로그인할 때 실행기 시작(src/main/autostart.ts)의 웹 대체 (설계 DESIGN.md §5.11).
 * 웹 버전은 실행 명령(pi-web mate)이 실행기를 띄우므로 로그인 항목이 없다.
 */

export const RUNNER_ONLY_ARG = "--mate-runner-only";

export interface AutostartState {
  supported: boolean;
  enabled: boolean;
  reason?: string;
}

const state: AutostartState = {
  supported: false,
  enabled: false,
  reason: "웹 버전은 Termux에서 pi-web mate로 켜면 실행기도 함께 뜹니다 (휴대폰을 켤 때 띄우려면 Termux:Boot)",
};

export function isRunnerOnlyLaunch(): boolean {
  return false;
}

export function getAutostart(): AutostartState {
  return state;
}

export async function setAutostart(_enabled: boolean): Promise<AutostartState> {
  return state;
}
