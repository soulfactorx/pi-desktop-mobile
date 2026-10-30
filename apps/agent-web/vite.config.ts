import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Agent 웹 화면 (설계 DESIGN.md §5.11). Agent의 renderer와 preload를 그대로 묶고 "electron"만 web-shell 대체 모듈로 바꾼다.
// 결과는 out/web/public. scripts/build.mjs가 부른다.
const at = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const electronRendererShim = at("../../packages/web-shell/src/client/electron-renderer.ts");

export default defineConfig({
  root: at("src/web"),
  base: "./",
  publicDir: at("src/web/public"),
  plugins: [react()],
  resolve: { alias: { electron: electronRendererShim } },
  build: {
    outDir: at("out/web/public"),
    emptyOutDir: true,
    // 코드 강조(shiki)의 언어 문법이 커서 경고가 많다. 데스크톱 화면과 같은 묶음이다.
    chunkSizeWarningLimit: 4096,
  },
});
