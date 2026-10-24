// API 키 없이 앱을 실행해 보는 개발용 스크립트.
//
// 1. OpenAI 호환 mock LLM 서버를 고정 포트로 띄운다 (host-agent 테스트 fixture 재사용)
// 2. 저장소의 Pi devDependency와, mock 프로바이더만 등록한 격리된 Pi 설정을 쓰도록 환경 변수를 정한다
// 3. 데몬 홈도 저장소의 .dev/ 아래로 격리해 실제 ~/.pi-desktop, ~/.pi 와 섞이지 않게 한다
// 4. electron-vite dev를 실행한다
//
// --demo-ext: Pi 패키지에 들어 있는 rpc-demo 확장을 함께 불러온다 (확장 UI 다이얼로그 확인용).
// --web: 앱 대신 웹 서버(pi-web)를 묶어서 띄운다. 브라우저로 출력된 주소를 연다 (데이터는 .dev/pi-web).
//
// 앱을 껐다 켜도 같은 데몬·세션에 다시 붙는지 확인할 수 있도록 경로와 포트를 고정한다.
// mock-llm.ts는 Node 22.18+/24의 TypeScript 타입 제거 기능으로 바로 import한다.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const devDir = join(repo, ".dev");
const piAgentDir = join(devDir, "pi-agent");
const port = Number(process.env.MOCK_LLM_PORT ?? 18911);
const web = process.argv.includes("--web");
const demoExtension = process.argv.includes("--demo-ext")
  ? join(repo, "node_modules", "@earendil-works", "pi-coding-agent", "examples", "extensions", "rpc-demo.ts")
  : undefined;

const { startMockLlm } = await import(
  new URL("../../../packages/host-agent/test/fixtures/mock-llm.ts", import.meta.url).href
);
const llm = await startMockLlm(port);

mkdirSync(piAgentDir, { recursive: true });
writeFileSync(
  join(piAgentDir, "models.json"),
  JSON.stringify(
    {
      // 모델 선택기 확인용: 기본 모델 외에 추론 모델과, openrouter처럼 모델이 많은 프로바이더를 흉내 낸다.
      // 모두 같은 mock 서버로 간다.
      providers: {
        mock: {
          baseUrl: llm.baseUrl,
          api: "openai-completions",
          apiKey: "mock",
          models: [
            { id: "mock-model" },
            { id: "mock-reasoning", name: "Mock Reasoning", reasoning: true, contextWindow: 200000 },
            // 이미지 첨부 확인용 (나머지 모델은 이미지를 받지 않는다)
            { id: "mock-vision", name: "Mock Vision", input: ["text", "image"] },
          ],
        },
        "mock-router": {
          baseUrl: llm.baseUrl,
          api: "openai-completions",
          apiKey: "mock",
          models: Array.from({ length: 30 }, (_, i) => ({
            id: `vendor-${i % 5}/model-${i}`,
            name: `Vendor ${i % 5} Model ${i}`,
            contextWindow: 32000 * ((i % 4) + 1),
          })),
        },
      },
    },
    null,
    2,
  ),
);

const env = {
  ...process.env,
  PI_DESKTOP_HOME: join(devDir, "pi-desktop-home"),
  PI_DESKTOP_PI_CLI: join(repo, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
  // 툴 카드를 모두 확인할 수 있게 기본(read·bash·edit·write)에 grep·find·ls도 켠다.
  PI_DESKTOP_PI_ARGS: [
    "--provider mock --model mock-model --tools read,bash,edit,write,grep,find,ls",
    demoExtension ? `-e ${demoExtension}` : "",
  ]
    .join(" ")
    .trim(),
  PI_CODING_AGENT_DIR: piAgentDir,
  PI_CODING_AGENT_SESSION_DIR: join(piAgentDir, "sessions"),
};

console.log(`[dev-mock] mock LLM: ${llm.baseUrl}`);
console.log(`[dev-mock] 프롬프트 예: "안녕" → echo, "read:package.json" → read 툴 호출, "bash:<명령>" → bash 툴 호출`);
if (demoExtension) {
  console.log("[dev-mock] rpc-demo 확장 사용: /rpc-input, /rpc-editor, /rpc-prefill, \"bash:rm -rf ./x\"(위험 명령 확인)");
}

const appDir = fileURLToPath(new URL("..", import.meta.url));
if (web) {
  const built = spawnSync("npm", ["run", "build:web"], { cwd: appDir, stdio: "inherit", shell: process.platform === "win32" });
  if (built.status !== 0) process.exit(built.status ?? 1);
}
const child = web
  ? spawn(process.execPath, [join(appDir, "out", "web", "server.mjs"), "--home", join(devDir, "pi-web")], { env, stdio: "inherit" })
  : spawn("npm", ["run", "dev"], { cwd: appDir, env, stdio: "inherit", shell: process.platform === "win32" });
child.on("exit", async (code) => {
  await llm.close();
  process.exit(code ?? 0);
});
