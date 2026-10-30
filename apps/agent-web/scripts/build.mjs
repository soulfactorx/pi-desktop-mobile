// Pi Desktop Agent 웹 묶음을 만든다 (설계 DESIGN.md §5.11).
//
//   node scripts/build.mjs   → out/web/  (바로 실행: node out/web/server.mjs)
//
// out/web/
//   server.mjs        웹 서버 + Agent main (electron은 web-shell 대체 모듈)
//   public/           화면 (vite.config.ts)
//   resources/        host-agent, agent-kit, pi-isolation (Agent 설치본의 extraResources와 같다)
//   package.json      버전
//
// Pi Web 묶음(apps/desktop/scripts/build-web.mjs)이 이 결과를 agent/로 넣는다.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build as viteBuild } from "vite";
import { bundleServer, copyPackage } from "../../../packages/web-shell/src/build.ts";

const at = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const app = at("..");
const agentApp = at("../../agent");
const packages = at("../../../packages");
const out = join(app, "out", "web");
const version = process.env.PI_WEB_VERSION ?? JSON.parse(readFileSync(join(app, "package.json"), "utf8")).version;

rmSync(out, { recursive: true, force: true });

await viteBuild({ configFile: join(app, "vite.config.ts"), logLevel: "warn" });
copyFileSync(join(agentApp, "build", "icon.png"), join(out, "public", "icon.png"));

await bundleServer({
  entry: join(app, "src", "server.ts"),
  outfile: join(out, "server.mjs"),
  replace: [{ module: join(agentApp, "src", "main", "updater"), with: join(packages, "web-shell", "src", "stubs", "updater.ts") }],
});

// Agent 설치본의 extraResources (apps/agent/electron-builder.yml)
const resources = join(out, "resources");
mkdirSync(join(resources, "host-agent"), { recursive: true });
copyFileSync(join(packages, "host-agent", "dist", "host-agent.mjs"), join(resources, "host-agent", "host-agent.mjs"));
copyFileSync(join(packages, "host-agent", "package.json"), join(resources, "host-agent", "package.json"));
copyPackage(join(packages, "agent-kit"), join(resources, "agent-kit"), ["package.json", "src", "extensions"]);
copyPackage(join(packages, "pi-isolation"), join(resources, "pi-isolation"), ["package.json", "src", "extensions"]);

writeFileSync(join(out, "package.json"), `${JSON.stringify({ name: "pi-agent-web", version, private: true, type: "module" }, null, 2)}\n`);
console.log(`[agent-web] ${out} (버전 ${version})`);
