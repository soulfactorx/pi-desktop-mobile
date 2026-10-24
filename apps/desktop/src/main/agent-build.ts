import { ErrorCodes, JsonRpcError } from "@pi-desktop/host-protocol";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Agent 번들의 빌드 식별자: 파일 SHA-256의 앞 12자리.
 * 데몬도 자기 번들로 같은 값을 계산해 host.info의 agentBuild로 알려 준다 (host-agent version.ts).
 * 둘이 다르면 떠 있는 데몬이 예전 번들이다 (설계 §3.4).
 */
export function agentBuildId(bundle: Buffer): string {
  return createHash("sha256").update(bundle).digest("hex").slice(0, 12);
}

/** 연결한 데몬을 어떻게 할지 */
export type AgentCheck =
  /** 같은 번들이거나 비교할 수 없다 */
  | "ok"
  /** 예전 데몬이고 실행 중인 세션이 없다: 끄고 새 번들로 다시 띄운다 */
  | "replace"
  /** 예전 데몬이지만 세션이 돌고 있거나 이미 한 번 바꿔 봤다: 그대로 쓰고 "업데이트 대기"를 알린다 */
  | "stale";

/**
 * @param expected 앱이 가진(올린) 번들의 빌드 식별자. 모르면 비교하지 않는다
 * @param running 데몬이 알려 준 빌드 식별자. 예전 데몬은 이 필드가 없다
 * @param liveSessions 데몬에서 실행 중인 Pi 세션 수
 * @param triedReplace 이 번들로 이미 교체를 시도했다 (같은 데몬이 다시 뜨면 되풀이하지 않는다)
 */
export function checkAgent(expected: string | undefined, running: string | undefined, liveSessions: number, triedReplace: boolean): AgentCheck {
  if (!expected || running === expected) return "ok";
  return liveSessions === 0 && !triedReplace ? "replace" : "stale";
}

/**
 * "업데이트 대기" 중인 예전 데몬이 새 기능 요청을 모르는 메서드·잘못된 인자로 거절했을 때,
 * 원인과 고치는 방법을 담은 오류로 바꾼다. 그 밖의 오류면 undefined (그대로 던진다).
 * 예: 확장 만들기를 v0.1.7 데몬에 보내면 "kind는 prompt·skill·agents…"로 거절된다.
 */
export function staleAgentError(error: unknown): JsonRpcError | undefined {
  if (!(error instanceof JsonRpcError)) return undefined;
  if (error.code !== ErrorCodes.MethodNotFound && error.code !== ErrorCodes.InvalidParams) return undefined;
  return new JsonRpcError(
    error.code,
    `Host Agent가 앱보다 이전 버전이라 이 기능을 처리하지 못했을 수 있습니다. 상단 바의 "Agent 업데이트 대기" → "지금 바꾸기"로 Agent를 바꾼 뒤 다시 해 보세요(실행 중인 세션은 끝나며 기록에서 다시 열 수 있습니다). 원래 오류: ${error.message}`,
    error.data,
  );
}

/** Agent 번들의 package.json에서 버전을 읽는다 (원격 배포 파일 이름에 쓰임). 설치본은 같은 폴더, 개발은 한 단계 위 */
export function agentVersion(script: string): string {
  for (const candidate of [join(dirname(script), "package.json"), join(dirname(script), "..", "package.json")]) {
    try {
      return String(JSON.parse(readFileSync(candidate, "utf8")).version ?? "0.0.0");
    } catch {
      // 다음 후보
    }
  }
  return "0.0.0";
}
