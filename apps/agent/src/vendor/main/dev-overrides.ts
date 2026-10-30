import type { SessionOpenParams } from "@pi-desktop/host-protocol";

/**
 * 개발·테스트용으로 세션 열기 파라미터를 환경 변수에서 덧붙인다.
 *
 * - PI_DESKTOP_PI_CLI: 사용할 Pi CLI 경로 (설치된 Pi 대신 저장소의 devDependency를 쓸 때)
 * - PI_DESKTOP_PI_ARGS: `pi --mode rpc` 뒤에 붙일 인자 (공백 구분, 예: "--provider mock --model mock-model")
 * - PI_CODING_AGENT_*: Pi 설정 위치 등을 Pi 프로세스에 그대로 전달 (예: mock LLM용 격리 설정)
 *
 * 데몬은 처음 뜰 때의 환경을 계속 쓰므로, 세션마다 명시적으로 넘겨야 이미 떠 있는 데몬에도 적용된다.
 * 정식 설정 화면은 M2(Pi Manager)에서 만든다.
 */
export function devSessionOverrides(env: NodeJS.ProcessEnv = process.env): Partial<SessionOpenParams> {
  const overrides: Partial<SessionOpenParams> = {};
  if (env.PI_DESKTOP_PI_CLI) overrides.piCliPath = env.PI_DESKTOP_PI_CLI;
  const args = env.PI_DESKTOP_PI_ARGS?.trim();
  if (args) overrides.piArgs = args.split(/\s+/);
  const piEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("PI_CODING_AGENT_") && value !== undefined) piEnv[key] = value;
  }
  if (Object.keys(piEnv).length > 0) overrides.env = piEnv;
  return overrides;
}
