/**
 * Host Agent 다시 붙기 정책 (설계 §3.2). electron 없이 판단하는 순수 함수라 테스트한다.
 *
 * 연결이 끊기면 점점 길게 기다리며 다시 붙는다. SSH 서버가 꺼졌거나 주소(IP)가 바뀐 것처럼
 * 다시 해도 안 될 때 끝없이 ssh를 띄우지 않도록, 연달아 몇 번 실패하면 멈추고 사용자에게 "다시 연결"을 맡긴다.
 */

/** 연달아 이만큼 실패하면 자동으로 다시 붙지 않는다 (약 1분) */
export const MAX_AUTO_RETRIES = 6;
const FIRST_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;

/** failures번째 실패 뒤 다시 붙기까지 기다릴 시간. 멈출 때면 undefined */
export function retryDelay(failures: number): number | undefined {
  if (failures >= MAX_AUTO_RETRIES) return undefined;
  return Math.min(FIRST_DELAY_MS * 2 ** Math.max(0, failures - 1), MAX_DELAY_MS);
}

/** 연결되지 않은 동안 화면의 요청이 연결을 기다리는 최대 시간 */
export const REQUEST_WAIT_MS = 20_000;
/** 연결 준비(SSH 확인·Agent 올리기 등)를 기다리는 최대 시간 */
export const PREPARE_TIMEOUT_MS = 90_000;
