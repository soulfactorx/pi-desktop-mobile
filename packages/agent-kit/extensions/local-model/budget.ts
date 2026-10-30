/**
 * 로컬(온디바이스) 모델의 좁은 창에 맞춘 계산. 파일·네트워크·Pi에 손대지 않는 순수 로직이다.
 *
 * desktop-agent에서 겪은 일 (설계 DESIGN-AGENT.md §4 "로컬 모델 대응"):
 * - Ollama 서버의 실제 창(num_ctx, 기본 4096)이 설정값과 달라 프롬프트가 조용히 잘렸다. 오류가 아니라
 *   없는 도구 이름을 지어내거나, 되묻거나, 출력이 중간에 끊기는 것으로 나타난다.
 * - 도구 결과 한 건이 대화 전체를 창 밖으로 밀어냈다.
 * - qwen3 계열은 매 응답 앞에 사고 블록을 만들어 좁은 창에서 답을 밀어냈다 (reasoning_effort: "none"으로 269 → 10토큰).
 */

/** 로컬 서버로 볼 주소 */
const LOCAL_HOST = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal)(:\d+)?(\/|$)/i;

export function isLocalBaseUrl(baseUrl: string | undefined): boolean {
  return LOCAL_HOST.test((baseUrl ?? "").trim());
}

/** OpenAI 호환 주소(…/v1)에서 Ollama 진단 API의 뿌리 주소를 만든다 */
export function ollamaRoot(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

/** Pi 압축 설정 기본값 (compaction.md) */
export const PI_COMPACTION_DEFAULTS = { reserveTokens: 16384, keepRecentTokens: 20000 };

export interface CompactionSettings {
  reserveTokens: number;
  keepRecentTokens: number;
}

/** 창 크기(토큰)에 맞는 압축 설정. 남은 창에 시스템 프롬프트·도구 정의·요약이 들어갈 자리를 남긴다 */
export function suggestedCompaction(contextWindow: number): CompactionSettings {
  return {
    reserveTokens: Math.max(1024, Math.floor(contextWindow * 0.25)),
    keepRecentTokens: Math.floor(contextWindow * 0.35),
  };
}

/**
 * 지금 압축 설정이 이 창에 맞지 않으면 그 이유. 맞으면 undefined.
 * 기본값(16384·20000)은 8192 창에서 압축 기준이 음수가 되어 매번 압축하거나, 압축 뒤에도 창을 넘는다.
 */
export function compactionProblem(contextWindow: number, current: CompactionSettings): string | undefined {
  if (current.reserveTokens >= contextWindow * 0.5) {
    return `압축 여유분(reserveTokens ${current.reserveTokens})이 창(${contextWindow})의 절반 이상입니다`;
  }
  if (current.keepRecentTokens >= contextWindow * 0.6) {
    return `압축 뒤 남기는 최근 대화(keepRecentTokens ${current.keepRecentTokens})가 창(${contextWindow})에 비해 너무 큽니다`;
  }
  return undefined;
}

/** Pi 설정(settings.json)에서 이 모델에 실제로 적용되는 압축 설정을 읽는다 (modelOverrides → 일반 설정 → 기본값) */
export function effectiveCompaction(settings: unknown, modelKey: string): CompactionSettings {
  const compaction = (settings as { compaction?: Record<string, unknown> } | undefined)?.compaction ?? {};
  const override = ((compaction.modelOverrides as Record<string, Record<string, unknown>> | undefined) ?? {})[modelKey] ?? {};
  const pick = (name: keyof CompactionSettings): number => {
    const value = override[name] ?? compaction[name];
    return typeof value === "number" && value > 0 ? value : PI_COMPACTION_DEFAULTS[name];
  };
  return { reserveTokens: pick("reserveTokens"), keepRecentTokens: pick("keepRecentTokens") };
}

/** 도구 결과 한 건에 허용할 글자 수. 창의 1/4 정도 (한 토큰을 3글자로 어림) */
export function toolResultChars(contextWindow: number): number {
  return Math.max(1200, Math.floor(contextWindow * 0.25 * 3));
}

/** 예산을 넘는 글을 앞부분만 남긴다. 넘지 않으면 undefined */
export function shrink(text: string, maxChars: number): { preview: string; total: number } | undefined {
  if (text.length <= maxChars) return undefined;
  return { preview: text.slice(0, Math.max(200, Math.floor(maxChars * 0.8))), total: text.length };
}
