// Host Agent를 의존성 없는 단일 파일(dist/host-agent.mjs)로 번들한다.
// 원격 호스트에는 이 파일 하나만 올리면 되도록 하기 위함이다 (설계 §3.2).
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const at = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const pkg = JSON.parse(await readFile(at("../package.json"), "utf8"));

await build({
  entryPoints: [at("../src/main.ts")],
  outfile: at("../dist/host-agent.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: "linked",
  define: {
    __AGENT_VERSION__: JSON.stringify(pkg.version),
    // 확장 관리 툴의 소스 (Pi가 -e로 불러오도록 데몬이 파일로 써 둔다)
    __MANAGE_EXTENSION_SOURCE__: JSON.stringify(await readFile(at("../../pi-resources/extensions/manage.ts"), "utf8")),
  },
  logLevel: "warning",
});
