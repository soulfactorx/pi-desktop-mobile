import { ollamaRoot } from "./budget";

export interface OllamaProbe {
  /** 서버가 이 모델에 실제로 연 창 (/api/ps). 모델이 아직 올라가지 않았으면 없음 */
  contextLength?: number;
  /** 사고(thinking)를 지원하는 모델인지 (/api/show capabilities). 모르면 없음 */
  thinking?: boolean;
}

const TIMEOUT_MS = 1500;

/**
 * Ollama 서버에 이 모델의 실제 창과 사고 지원 여부를 묻는다.
 * Ollama가 아니거나 느리면 빈 결과다. 진단 실패가 대화를 막으면 안 된다.
 */
export async function probeOllama(baseUrl: string, modelId: string): Promise<OllamaProbe> {
  const root = ollamaRoot(baseUrl);
  const result: OllamaProbe = {};
  try {
    const res = await fetch(`${root}/api/ps`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.ok) {
      const body = (await res.json()) as { models?: Array<{ name?: string; model?: string; context_length?: number }> };
      const hit = body.models?.find((m) => m.model === modelId || m.name === modelId);
      if (hit?.context_length && hit.context_length > 0) result.contextLength = hit.context_length;
    }
  } catch {
    // Ollama가 아니거나 응답이 없다
  }
  try {
    const res = await fetch(`${root}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: modelId }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) {
      const body = (await res.json()) as { capabilities?: unknown };
      if (Array.isArray(body.capabilities)) result.thinking = body.capabilities.includes("thinking");
    }
  } catch {
    // 위와 같음
  }
  return result;
}
