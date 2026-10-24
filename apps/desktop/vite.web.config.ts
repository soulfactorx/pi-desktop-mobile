import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// 웹(pi-web) 화면 (설계 §5.10). 데스크톱과 같은 renderer를 src/web/main.ts가 WebSocket API와 함께 불러온다.
// 결과는 out/web/public. 서버(server.mjs)가 이 폴더를 내준다. scripts/build-web.mjs가 부른다.
const at = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  root: at("src/web"),
  base: "./",
  publicDir: at("src/web/public"),
  plugins: [react()],
  build: {
    outDir: at("out/web/public"),
    emptyOutDir: true,
    // 코드 강조(shiki)의 언어 문법이 커서 경고가 많다. 데스크톱 화면과 같은 묶음이다.
    chunkSizeWarningLimit: 4096,
  },
});
