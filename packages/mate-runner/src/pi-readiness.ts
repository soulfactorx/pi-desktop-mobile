import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { listPiModels } from "../../host-agent/src/pi-models";
import { piStatus } from "../../host-agent/src/pi-status";
import type { PiReadiness } from "./pi-readiness-types";

export type { PiReadiness };

/**
 * Mate가 Pi를 쓸 준비가 되었는지 (설계 DESIGN-MATE.md §9 Pi 준비).
 *
 * Pi Desktop의 Host Agent와 같은 코드로 Pi를 찾고(수정 없이 번들), 읽기만 한다.
 * - 설치: 관리형 설치 → npm 전역 (Pi Desktop과 같은 Pi를 쓴다)
 * - 로그인: `pi --list-models`에 모델이 하나라도 나오면 쓸 수 있다 (auth.json, 환경 변수, models.json 모두 반영)
 * - Pi의 기본 모델(settings.json defaultProvider/defaultModel)을 함께 알려 준다
 */
export async function piReadiness(env: NodeJS.ProcessEnv = process.env): Promise<PiReadiness> {
  const status = await piStatus({ env });
  const defaultModel = await piDefaultModel(env);
  const base = {
    node: status.node,
    ...(status.gitBash ? { gitBash: status.gitBash } : {}),
    authProviders: status.data.authProviders,
    ...(defaultModel ? { piDefaultModel: defaultModel } : {}),
  };
  if (!status.pi) return { stage: "no-pi", ...(status.piError ? { piError: status.piError } : {}), ...base, models: [] };
  const pi = { version: status.pi.version, cliPath: status.pi.cliPath, source: status.pi.source };
  const listed = await listPiModels(status.pi, env);
  return {
    stage: listed.models.length > 0 ? "ready" : "no-models",
    pi,
    ...base,
    models: listed.models,
    ...(listed.error ? { modelsError: listed.error } : {}),
  };
}

async function piDefaultModel(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const agentDir = env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  try {
    const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
    const provider = typeof settings.defaultProvider === "string" ? settings.defaultProvider : undefined;
    const model = typeof settings.defaultModel === "string" ? settings.defaultModel : undefined;
    if (!model) return undefined;
    return provider && !model.includes("/") ? `${provider}/${model}` : model;
  } catch {
    return undefined;
  }
}
