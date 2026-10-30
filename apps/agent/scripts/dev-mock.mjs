// API 키 없이 에이전트 앱을 실행해 보는 개발용 스크립트 (Pi Desktop의 dev-mock과 같은 방식).
//
// 1. OpenAI 호환 mock LLM 서버를 고정 포트로 띄운다 (host-agent 테스트 fixture 재사용)
// 2. 저장소의 Pi devDependency와, mock 프로바이더만 등록한 격리된 Pi 설정을 쓰도록 환경 변수를 정한다
// 3. 앱 홈(데몬·세션·스킬·MCP·agent-kit 상태)은 Pi Desktop의 개발 실행과도 나눈다 (.dev/agent-home).
//    Pi 설정(로그인·모델)은 같은 .dev/pi-agent를 함께 쓴다
// 4. electron-vite dev를 실행한다
//
// mock-llm.ts는 Node 22.18+/24의 TypeScript 타입 제거 기능으로 바로 import한다.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const devDir = join(repo, ".dev");
const piAgentDir = join(devDir, "pi-agent");
// Pi Desktop의 dev:mock(18911)과 동시에 띄울 수 있게 포트를 나눈다.
const port = Number(process.env.MOCK_LLM_PORT ?? 18912);

const { startMockLlm } = await import(
  new URL("../../../packages/host-agent/test/fixtures/mock-llm.ts", import.meta.url).href
);
const llm = await startMockLlm(port);

mkdirSync(piAgentDir, { recursive: true });
writeFileSync(
  join(piAgentDir, "models.json"),
  JSON.stringify(
    {
      providers: {
        mock: { baseUrl: llm.baseUrl, api: "openai-completions", apiKey: "mock", models: [{ id: "mock-model" }] },
      },
    },
    null,
    2,
  ),
);

const env = {
  ...process.env,
  PI_DESKTOP_HOME: join(devDir, "agent-home"),
  PI_DESKTOP_PI_CLI: join(repo, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
  PI_DESKTOP_PI_ARGS: "--provider mock --model mock-model --tools read,bash,edit,write,grep,find,ls",
  PI_CODING_AGENT_DIR: piAgentDir,
};

console.log(`[dev-mock] mock LLM: ${llm.baseUrl}`);
console.log('[dev-mock] 프롬프트 예: "안녕" → echo, "read:package.json" → read 툴 호출, "/agent:status" → agent-kit 버전 알림');

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
