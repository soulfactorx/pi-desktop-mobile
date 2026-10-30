// 웹(pi-web) 묶음을 만든다 (설계 §5.10).
//
//   node scripts/build-web.mjs          → out/web/  (바로 실행: node out/web/server.mjs)
//   node scripts/build-web.mjs --pack   → 위에 더해 release/web/pi-web.tar.gz, install-termux.sh
//
// out/web/
//   server.mjs              웹 서버 (ws까지 한 파일로 묶는다. node-pty만 밖에 둔다: 네이티브 모듈)
//   public/                 화면 (vite.web.config.ts)
//   host-agent/             Host Agent 번들과 package.json (데스크톱 앱의 extraResources와 같다)
//   bin/pi-web              실행 명령 (scripts/web/pi-web.sh)
//   package.json            버전
//   agent/                  Pi Desktop Agent 웹 버전 (apps/agent-web, 설계 §5.11)
//   mate/                   Pi Desktop Mate 웹 버전 (apps/mate-web)
//
// 설치 스크립트는 릴리스가 올라가는 저장소에서 묶음을 받는다. 저장소는 GITHUB_REPOSITORY(Actions),
// 없으면 git origin 주소에서 읽는다.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";

const at = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const app = at("..");
const agent = at("../../../packages/host-agent");
const out = join(app, "out", "web");
const pack = process.argv.includes("--pack");
const version = JSON.parse(readFileSync(join(app, "package.json"), "utf8")).version;

rmSync(out, { recursive: true, force: true });

await viteBuild({ configFile: join(app, "vite.web.config.ts"), logLevel: "warn" });
copyFileSync(join(app, "build", "icon.png"), join(out, "public", "icon.png"));

await esbuild({
  entryPoints: [join(app, "src", "server", "index.ts")],
  outfile: join(out, "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // ws의 선택 의존성(bufferutil 등)은 없어도 된다. node-pty는 설치 스크립트가 --terminal일 때 따로 깐다.
  external: ["node-pty", "bufferutil", "utf-8-validate"],
  // ws는 CommonJS라 묶은 ESM 안에서 require가 필요하다.
  banner: { js: 'import { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);' },
  logLevel: "warning",
});

// Host Agent: 데몬과 연결기. 먼저 packages/host-agent에서 npm run build로 만들어 둔다.
mkdirSync(join(out, "host-agent"), { recursive: true });
copyFileSync(join(agent, "dist", "host-agent.mjs"), join(out, "host-agent", "host-agent.mjs"));
copyFileSync(join(agent, "package.json"), join(out, "host-agent", "package.json"));

mkdirSync(join(out, "bin"), { recursive: true });
copyFileSync(join(app, "scripts", "web", "pi-web.sh"), join(out, "bin", "pi-web"));
chmodSync(join(out, "bin", "pi-web"), 0o755);
writeFileSync(join(out, "package.json"), `${JSON.stringify({ name: "pi-web", version, private: true, type: "module" }, null, 2)}\n`);

// Agent·Mate 웹 버전: 각 앱의 묶기 스크립트로 만들어 agent/·mate/로 넣는다. 버전은 Pi Web과 같게 한다
for (const name of ["agent", "mate"]) {
  const dir = at(`../../${name}-web`);
  execFileSync(process.execPath, [join(dir, "scripts", "build.mjs")], { stdio: "inherit", env: { ...process.env, PI_WEB_VERSION: version } });
  cpSync(join(dir, "out", "web"), join(out, name), { recursive: true });
}

console.log(`[build-web] ${out} (버전 ${version})`);

if (pack) {
  const release = join(app, "release", "web");
  rmSync(release, { recursive: true, force: true });
  mkdirSync(release, { recursive: true });
  // 압축 파일 안의 폴더 이름은 pi-web
  const staging = join(app, "out", "web-pack");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  cpSync(out, join(staging, "pi-web"), { recursive: true });
  execFileSync("tar", ["-czf", join(release, "pi-web.tar.gz"), "-C", staging, "pi-web"], { stdio: "inherit" });
  rmSync(staging, { recursive: true, force: true });

  const repo = process.env.GITHUB_REPOSITORY || originRepo();
  const installer = readFileSync(join(app, "scripts", "web", "install-termux.sh"), "utf8").replaceAll("__PI_WEB_REPO__", repo);
  writeFileSync(join(release, "install-termux.sh"), installer, { mode: 0o755 });
  console.log(`[build-web] ${release}/pi-web.tar.gz, install-termux.sh (저장소 ${repo})`);
}

/** git origin 주소에서 owner/repo를 읽는다 */
function originRepo() {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd: app, encoding: "utf8" }).trim();
    const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
    if (match) return match[1];
  } catch {
    // 아래 오류
  }
  throw new Error("릴리스 저장소를 알 수 없습니다. GITHUB_REPOSITORY=owner/repo로 알려 주세요.");
}
