// 실행기를 의존성 없는 단일 파일(dist/mate-runner.mjs)로 번들한다 (Host Agent와 같은 방식).
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const at = (relative) => fileURLToPath(new URL(relative, import.meta.url));

await build({
  entryPoints: [at("../src/main.ts")],
  outfile: at("../dist/mate-runner.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: "linked",
  logLevel: "warning",
});
