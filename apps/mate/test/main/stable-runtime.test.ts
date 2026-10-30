import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { placeRunnerFiles } from "../../src/main/stable-runtime";

/** AppImage 리소스처럼 사라질 수 있는 곳의 실행기·kit을 Mate 홈에 복사해 쓴다 */
describe("실행기 파일 옮겨 두기", () => {
  it("번들과 mate-kit·pi-isolation을 Mate 홈에 두고, 내용이 같으면 다시 쓰지 않는다", async () => {
    const resources = mkdtempSync(join(tmpdir(), "mate-res-"));
    const home = mkdtempSync(join(tmpdir(), "mate-home-"));
    mkdirSync(join(resources, "mate-runner"));
    writeFileSync(join(resources, "mate-runner", "mate-runner.mjs"), "console.log(1);\n");
    mkdirSync(join(resources, "mate-kit", "extensions", "mate-guard"), { recursive: true });
    writeFileSync(join(resources, "mate-kit", "package.json"), '{"name":"mate-kit"}');
    writeFileSync(join(resources, "mate-kit", "extensions", "mate-guard", "index.ts"), "export default 1;\n");
    mkdirSync(join(resources, "pi-isolation", "src"), { recursive: true });
    writeFileSync(join(resources, "pi-isolation", "src", "paths.ts"), "export {};\n");
    const source = { runnerScript: join(resources, "mate-runner", "mate-runner.mjs"), kitDir: join(resources, "mate-kit"), version: "0.5.8" };

    const placed = await placeRunnerFiles(home, source);
    expect(placed.runnerScript.startsWith(join(home, "runner", "mate-runner-0.5.8-"))).toBe(true);
    expect(readFileSync(placed.runnerScript, "utf8")).toBe("console.log(1);\n");
    expect(placed.kitDir.startsWith(join(home, "kits"))).toBe(true);
    expect(existsSync(join(placed.kitDir, "extensions", "mate-guard", "index.ts"))).toBe(true);
    // 실행기가 mate-kit 옆에서 pi-isolation을 찾는다
    expect(existsSync(join(placed.kitDir, "..", "pi-isolation", "src", "paths.ts"))).toBe(true);

    const written = statSync(join(placed.kitDir, "package.json")).mtimeMs;
    expect(await placeRunnerFiles(home, source)).toEqual(placed);
    expect(statSync(join(placed.kitDir, "package.json")).mtimeMs).toBe(written);

    // 내용이 바뀌면 새 폴더에 둔다
    writeFileSync(join(resources, "mate-kit", "extensions", "mate-guard", "index.ts"), "export default 2;\n");
    expect((await placeRunnerFiles(home, source)).kitDir).not.toBe(placed.kitDir);
  });
});
