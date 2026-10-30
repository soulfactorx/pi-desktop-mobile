import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { bundleFileName, collectKit } from "@pi-desktop/host-deploy";

/**
 * 실행기가 앱이 꺼진 뒤에도 쓸 수 있는 곳에 실행기 번들과 mate-kit·pi-isolation을 둔다.
 *
 * Linux AppImage는 실행할 때마다 `/tmp/.mount_…`에 풀렸다가 앱이 끝나면 사라진다. 실행기는 앱을 닫아도 남아
 * 임무를 돌리는데, 그때마다 Pi에 `-e <mate-kit>/extensions/…`를 넘기므로 kit 경로가 사라지면 임무가 실패한다.
 * 그래서 원격 호스트와 같은 배치로 Mate 홈 아래에 복사해 쓴다 (`runner/mate-runner-<버전>-<빌드>.mjs`, `kits/<내용 해시>/`).
 * 내용이 같으면 다시 쓰지 않는다.
 */
export async function placeRunnerFiles(
  home: string,
  source: { runnerScript: string; kitDir: string; version: string },
): Promise<{ runnerScript: string; kitDir: string }> {
  const bundle = await readFile(source.runnerScript);
  const runnerScript = join(home, "runner", bundleFileName("mate-runner", source.version, bundle));
  if (!existsSync(runnerScript)) {
    await mkdir(dirname(runnerScript), { recursive: true });
    const tmp = `${runnerScript}.${process.pid}.tmp`;
    await writeFile(tmp, bundle);
    await rename(tmp, runnerScript);
  }

  const kit = await collectKit([
    { name: "mate-kit", dir: source.kitDir },
    { name: "pi-isolation", dir: resolve(source.kitDir, "..", "pi-isolation") },
  ]);
  const base = join(home, "kits", kit.hash);
  if (!existsSync(join(base, ".complete"))) {
    // 다 쓴 뒤 바꿔치기해, 반쯤 쓴 kit을 쓰지 않게 한다
    const tmp = `${base}.${process.pid}.tmp`;
    await rm(tmp, { recursive: true, force: true });
    for (const file of kit.files) {
      const target = join(tmp, file.rel);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.data);
    }
    await writeFile(join(tmp, ".complete"), "");
    await rm(base, { recursive: true, force: true });
    await rename(tmp, base);
  }
  return { runnerScript, kitDir: join(base, "mate-kit") };
}
