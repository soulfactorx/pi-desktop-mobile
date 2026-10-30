// build/icon.svg를 build/icon.png(1024×1024)로 그린다. 아이콘을 고친 뒤 한 번 실행한다.
//   npx electron apps/agent/scripts/render-icon.mjs
// electron-builder는 이 PNG로 Windows .ico·macOS .icns·Linux 아이콘을 만든다.
// 이미 설치된 Electron(Chromium)으로 SVG를 그리므로 다른 도구가 필요 없다.
import { app, BrowserWindow } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const svgPath = join(here, "..", "build", "icon.svg");
const pngPath = join(here, "..", "build", "icon.png");
const SIZE = 1024;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 200, height: 200, webPreferences: { offscreen: true } });
  await win.loadURL("data:text/html,<html><body></body></html>");
  const svg = readFileSync(svgPath, "utf8");
  const dataUrl = await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = ${SIZE};
        canvas.height = ${SIZE};
        canvas.getContext("2d").drawImage(img, 0, 0, ${SIZE}, ${SIZE});
        resolve(canvas.toDataURL("image/png"));
      };
      img.onerror = () => reject(new Error("SVG를 그리지 못했습니다"));
      img.src = "data:image/svg+xml;base64," + ${JSON.stringify(Buffer.from(svg).toString("base64"))};
    })
  `);
  writeFileSync(pngPath, Buffer.from(dataUrl.split(",")[1], "base64"));
  console.log(`saved ${pngPath}`);
  app.quit();
});
