import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild, type Plugin } from "esbuild";

/**
 * 웹 껍데기 묶음을 만드는 도구 (설계 DESIGN.md §5.11). apps/agent-web·apps/mate-web의 scripts/build.mjs가 쓴다.
 *
 * 서버: 앱의 main 코드를 고치지 않고 Node용 한 파일로 묶는다. 그때
 * - "electron"은 web-shell의 Electron 대체 모듈로
 * - 웹에서 할 일이 다른 모듈(자동 업데이트, 로그인 항목 등)은 replace로 웹용 파일로 바꾼다
 */

const here = dirname(fileURLToPath(import.meta.url));
/** 화면 묶기(vite)에서 "electron" 대신 쓸 파일 */
export const electronRendererShim = join(here, "client", "electron-renderer.ts");
const electronMainShim = join(here, "electron", "main.ts");

export interface Replacement {
  /** 바꿀 모듈 파일 (확장자 없이 절대 경로, 예: apps/agent/src/main/updater) */
  module: string;
  /** 대신 쓸 파일 */
  with: string;
}

const EXTENSIONS = ["", ".ts", ".tsx", ".js", ".mjs"];

function replacePlugin(replacements: Replacement[]): Plugin {
  const table = new Map(replacements.map((r) => [resolve(r.module), r.with]));
  return {
    name: "web-shell-replace",
    setup(build) {
      build.onResolve({ filter: /^electron$/ }, () => ({ path: electronMainShim }));
      build.onResolve({ filter: /^electron-updater$/ }, () => ({ errors: [{ text: "electron-updater는 웹 묶음에 넣지 않는다. 그 모듈을 replace로 바꿔라" }] }));
      build.onResolve({ filter: /^\.\.?\// }, (args) => {
        const target = resolve(args.resolveDir, args.path).replace(/\.(ts|tsx|js|mjs)$/, "");
        const replacement = table.get(target);
        return replacement ? { path: replacement } : undefined;
      });
    },
  };
}

export interface ServerBundleOptions {
  entry: string;
  outfile: string;
  replace?: Replacement[];
}

/** 웹 서버를 한 파일(ESM)로 묶는다. ws의 선택 의존성은 없어도 된다 */
export async function bundleServer(options: ServerBundleOptions): Promise<void> {
  for (const r of options.replace ?? []) {
    if (!EXTENSIONS.some((ext) => existsSync(`${r.module}${ext}`))) throw new Error(`바꿀 모듈이 없습니다: ${r.module} (앱 구조가 바뀌었는지 확인)`);
  }
  await esbuild({
    entryPoints: [options.entry],
    outfile: options.outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["bufferutil", "utf-8-validate"],
    plugins: [replacePlugin(options.replace ?? [])],
    // CommonJS 의존성(ws 등)이 묶은 ESM 안에서 require를 쓴다
    banner: { js: 'import { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);' },
    logLevel: "warning",
  });
}

/** 패키지 폴더에서 고른 것만 복사한다 (electron-builder.yml의 extraResources filter와 같은 목록을 준다) */
export function copyPackage(from: string, to: string, entries: string[]): void {
  mkdirSync(to, { recursive: true });
  for (const entry of entries) {
    const source = join(from, entry);
    if (existsSync(source)) cpSync(source, join(to, entry), { recursive: true, filter: (path) => !/[\\/](node_modules|test)([\\/]|$)/.test(path.slice(from.length)) });
  }
}
