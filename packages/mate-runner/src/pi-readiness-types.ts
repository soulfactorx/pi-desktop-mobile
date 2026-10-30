import type { PiStatus } from "@pi-desktop/host-protocol/messages";

/** Pi 준비 상태 (pi-readiness.ts). 화면도 쓰므로 Node 코드 없이 타입만 둔다 */
export interface PiReadiness {
  /** 준비 단계: Pi 없음 → 쓸 수 있는 모델 없음 → 준비됨 */
  stage: "no-pi" | "no-models" | "ready";
  pi?: { version: string; cliPath: string; source: string };
  piError?: string;
  node: PiStatus["node"];
  /** Windows: Pi의 bash 도구가 쓸 Git Bash */
  gitBash?: PiStatus["gitBash"];
  /** auth.json에 로그인한 프로바이더 이름 (값은 읽지 않음) */
  authProviders: string[];
  models: Array<{ provider: string; id: string }>;
  modelsError?: string;
  /** Pi 설정의 기본 모델 (provider/id) */
  piDefaultModel?: string;
}
