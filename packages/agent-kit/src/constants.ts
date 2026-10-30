/**
 * agent-kit과 앱이 함께 쓰는 값.
 *
 * 확장은 대상 호스트의 Pi가 jiti로 불러오므로 이 파일은 다른 모듈을 import하지 않는다.
 */

/** package.json의 version과 같아야 한다 (테스트로 확인) */
export const KIT_VERSION = "0.0.1";

/**
 * agent-kit이 세션에 올라갔는지 앱이 확인하는 명령 (설계 DESIGN-AGENT.md §2.1).
 * 앱은 프롬프트를 보내기 전에 get_commands에 이 이름이 있는지 본다.
 */
export const STATUS_COMMAND = "agent:status";
