// API 키 없이 Mate 앱을 실행해 보는 개발용 스크립트 (Pi Desktop·Agent의 dev-mock과 같은 방식).
//
// 1. OpenAI 호환 mock LLM 서버를 고정 포트로 띄운다 (host-agent 테스트 fixture 재사용)
// 2. 저장소의 Pi devDependency와, mock 프로바이더만 등록한 격리된 Pi 설정을 쓰도록 환경 변수를 정한다
// 3. Mate 홈(.dev/mate-home)과 Pi 설정(.dev/mate-pi-agent)을 Pi Desktop·Agent의 개발 실행과 나눈다
// 4. electron-vite dev를 실행한다
//
// 임무 지시 예: "안녕" → echo, 'tool:mate_propose {"title":"…","summary":"…"}' → 제안, "bash:rm x" → 막힘 확인
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const devDir = join(repo, ".dev");
const piAgentDir = join(devDir, "mate-pi-agent");
const mateHome = join(devDir, "mate-home");
// Pi Desktop(18911)·Agent(18912)의 dev:mock과 동시에 띄울 수 있게 포트를 나눈다.
const port = Number(process.env.MOCK_LLM_PORT ?? 18913);

const { startMockLlm } = await import(
  new URL("../../../packages/host-agent/test/fixtures/mock-llm.ts", import.meta.url).href
);
const llm = await startMockLlm(port);

mkdirSync(piAgentDir, { recursive: true });
writeFileSync(
  join(piAgentDir, "models.json"),
  JSON.stringify(
    { providers: { mock: { baseUrl: llm.baseUrl, api: "openai-completions", apiKey: "mock", models: [{ id: "mock-model" }] } } },
    null,
    2,
  ),
);
// 처음 실행이면 기본 모델을 mock으로 (실제 기본값은 anthropic/claude-haiku-5-5)
mkdirSync(mateHome, { recursive: true });
if (!existsSync(join(mateHome, "config.json"))) {
  writeFileSync(join(mateHome, "config.json"), JSON.stringify({ model: "mock/mock-model" }, null, 2));
}

const env = {
  ...process.env,
  MATE_HOME: mateHome,
  PI_DESKTOP_PI_CLI: join(repo, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
  PI_CODING_AGENT_DIR: piAgentDir,
  PI_CODING_AGENT_SESSION_DIR: join(piAgentDir, "sessions"),
};

console.log(`[dev-mock] mock LLM: ${llm.baseUrl}, Mate 홈: ${mateHome}`);

const child = spawn("npm", ["run", "dev"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});
child.on("exit", async (code) => {
  await llm.close();
  process.exit(code ?? 0);
});
