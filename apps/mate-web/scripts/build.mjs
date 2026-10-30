// Pi Desktop Mate 웹 묶음을 만든다 (설계 DESIGN.md §5.11).
//
//   node scripts/build.mjs   → out/web/  (바로 실행: node out/web/server.mjs)
//
// out/web/
//   server.mjs        웹 서버 + Mate main (electron은 web-shell 대체 모듈)
//   public/           화면 (vite.config.ts)
//   resources/        mate-runner, mate-kit, pi-isolation (Mate 설치본의 extraResources와 같다)
//   package.json      버전
//
// Pi Web 묶음(apps/desktop/scripts/build-web.mjs)이 이 결과를 mate/로 넣는다.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build as viteBuild } from "vite";
import { bundleServer, copyPackage } from "../../../packages/web-shell/src/build.ts";

const at = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const app = at("..");
const mateApp = at("../../mate");
const packages = at("../../../packages");
const out = join(app, "out", "web");
const version = process.env.PI_WEB_VERSION ?? JSON.parse(readFileSync(join(app, "package.json"), "utf8")).version;

rmSync(out, { recursive: true, force: true });

await viteBuild({ configFile: join(app, "vite.config.ts"), logLevel: "warn" });
copyFileSync(join(mateApp, "build", "icon.png"), join(out, "public", "icon.png"));

await bundleServer({
  entry: join(app, "src", "server.ts"),
  outfile: join(out, "server.mjs"),
  replace: [
    { module: join(mateApp, "src", "main", "updater"), with: join(packages, "web-shell", "src", "stubs", "updater.ts") },
    { module: join(mateApp, "src", "main", "autostart"), with: join(packages, "web-shell", "src", "stubs", "autostart.ts") },
  ],
});

// Mate 설치본의 extraResources (apps/mate/electron-builder.yml). pi-isolation은 mate-kit 옆에 있어야 실행기가 찾는다
const resources = join(out, "resources");
mkdirSync(join(resources, "mate-runner"), { recursive: true });
copyFileSync(join(packages, "mate-runner", "dist", "mate-runner.mjs"), join(resources, "mate-runner", "mate-runner.mjs"));
copyPackage(join(packages, "mate-kit"), join(resources, "mate-kit"), ["package.json", "extensions", "src"]);
copyPackage(join(packages, "pi-isolation"), join(resources, "pi-isolation"), ["package.json", "extensions", "src"]);

writeFileSync(join(out, "package.json"), `${JSON.stringify({ name: "pi-mate-web", version, private: true, type: "module" }, null, 2)}\n`);
console.log(`[mate-web] ${out} (버전 ${version})`);
