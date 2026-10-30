/**
 * 지금 Pi 프로세스가 어떤 실행인지. 확장들이 함께 쓴다 (설계 DESIGN-AGENT.md §1 "사람이 없으면 안전한 쪽으로").
 *
 * 확장은 대상 호스트의 Pi가 jiti로 불러오므로 이 파일은 다른 모듈을 import하지 않는다.
 */

/** 워커·예약 실행이 자식 Pi에 주는 환경 변수 */
export const WORKER_ENV = "PI_DESKTOP_AGENT_WORKER";
export const UNATTENDED_ENV = "PI_DESKTOP_AGENT_UNATTENDED";

/**
 * 사람이 지켜보고 있어 물을 수 있는가. RPC 모드는 hasUI가 늘 true라서, 아무도 답하지 않는
 * 워커·예약 실행은 환경 변수로 따로 알린다. 묻지 못하면 승인이 필요한 일은 거부해야 한다.
 */
export function attended(hasUI: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  return hasUI && env[UNATTENDED_ENV] !== "1";
}

/** 다른 세션이 맡긴 일을 하는 워커인가. 워커는 다시 일을 맡기지 않는다 */
export function isWorker(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[WORKER_ENV] === "1";
}

/** 앱이 데몬에 띄워 두는 스케줄러 세션에 주는 환경 변수 */
export const SCHEDULER_ENV = "PI_DESKTOP_AGENT_SCHEDULER";

/** 예약을 돌리는 상주 스케줄러 세션인가 */
export function isScheduler(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SCHEDULER_ENV] === "1";
}

/** "0"이면 턴이 끝난 뒤 기억을 자동으로 뽑지 않는다 (모델을 한 번 더 부르므로 끌 수 있게 한다) */
export const LEARN_ENV = "PI_DESKTOP_AGENT_LEARN";

export function learning(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[LEARN_ENV] !== "0";
}

/** 다른 에이전트(피어)의 질문에 답하는 워커에 주는 환경 변수. 기억 중 선호는 싣지 않는다 */
export const PEER_ENV = "PI_DESKTOP_AGENT_PEER";

export function isPeerAnswer(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PEER_ENV] === "1";
}

/**
 * 피어가 맡긴 작업의 워커에 주는 환경 변수: 읽기·쓰기를 이 폴더 안으로 가둔다.
 * 이 PC의 다른 파일(예: 키·설정)을 읽어 상대에게 돌려주지 않게 한다.
 */
export const CONFINE_ENV = "PI_DESKTOP_AGENT_CONFINE";

export function confinedTo(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[CONFINE_ENV] || undefined;
}
