import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

// 워크스페이스 패키지(@pi-desktop/*)는 TS 소스 그대로이므로 번들에 포함한다.
const workspace = ["@pi-desktop/mate-kit", "@pi-desktop/mate-runner", "@pi-desktop/host-protocol"];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: workspace })],
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: workspace })],
    // sandbox가 켜진 preload는 ESM을 쓸 수 없으므로 CommonJS로 내보낸다.
    build: { rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } } },
  },
  renderer: {
    plugins: [react()],
  },
});
