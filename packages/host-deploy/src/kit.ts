import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import { shQuote, type RemoteRunner } from "./bundle";

/**
 * Pi가 `-e`로 불러올 TypeScript 확장 폴더(kit)를 그 호스트에 올린다 (설계 DESIGN-APPS.md §4, DESIGN-MATE-REMOTE.md §3.2).
 * `<앱 홈>/kits/<내용 해시>/<이름>/`에 두고, 같은 내용이면 다시 올리지 않는다.
 */

/** 올릴 파일 하나 (kit 폴더 기준 상대 경로, `/`로 잇는다) */
export interface KitFile {
  rel: string;
  data: Buffer;
}

export interface KitBundle {
  /** 내용 해시. 원격 폴더 이름이 된다 */
  hash: string;
  files: KitFile[];
}

/** 설치본에 싣는 것과 같은 범위 (electron-builder.yml의 agent-kit·mate-kit·pi-isolation filter). 테스트는 뺀다 */
const KIT_PARTS = ["package.json", "src", "extensions"];

async function collectDir(root: string, prefix: string, out: KitFile[]): Promise<void> {
  for (const part of KIT_PARTS) {
    const path = join(root, part);
    const info = await stat(path).catch(() => undefined);
    if (!info) continue;
    if (info.isFile()) {
      out.push({ rel: `${prefix}/${part}`, data: await readFile(path) });
      continue;
    }
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) out.push({ rel: `${prefix}/${relative(root, full).split(sep).join("/")}`, data: await readFile(full) });
      }
    };
    await walk(path);
  }
}

/** 로컬 폴더들을 이름 붙여 모으고 내용 해시를 붙인다 (예: agent-kit·pi-isolation, mate-kit·pi-isolation) */
export async function collectKit(parts: Array<{ name: string; dir: string }>): Promise<KitBundle> {
  const files: KitFile[] = [];
  for (const part of parts) await collectDir(part.dir, part.name, files);
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const hash = createHash("sha256");
  for (const file of files) hash.update(file.rel).update("\0").update(file.data).update("\0");
  return { hash: hash.digest("hex").slice(0, 16), files };
}

/** 원격에서 kit을 풀어 놓는 셸 스크립트. 임시 폴더에 다 쓴 뒤 바꿔치기해, 반쯤 올라간 kit을 쓰지 않게 한다 */
export function unpackScript(base: string, bundle: KitBundle): string {
  const lines = ["set -e", `base=${shQuote(base)}`, 'tmp="$base.uploading.$$"', 'rm -rf "$tmp"', 'mkdir -p "$tmp"'];
  const dirs = new Set(bundle.files.map((f) => posix.dirname(f.rel)).filter((d) => d !== "."));
  for (const dir of [...dirs].sort()) lines.push(`mkdir -p "$tmp"/${shQuote(dir)}`);
  for (const file of bundle.files) {
    const encoded = file.data.toString("base64").replace(/.{1,76}/g, "$&\n");
    lines.push(`base64 -d > "$tmp"/${shQuote(file.rel)} <<'PI_KIT_EOF'`, `${encoded}PI_KIT_EOF`);
  }
  lines.push('touch "$tmp/.complete"', 'mkdir -p "$(dirname "$base")"', 'rm -rf "$base"', 'mv "$tmp" "$base"', "echo pi-desktop-kit=ok");
  return `${lines.join("\n")}\n`;
}

/** kit이 그 호스트에 없으면 올린다. 올린 폴더(<앱 홈>/kits/<해시>)를 돌려준다 */
export async function deployKit(run: RemoteRunner, appHome: string, bundle: KitBundle): Promise<string> {
  const base = `${appHome}/kits/${bundle.hash}`;
  const probe = await run(`if [ -f ${shQuote(`${base}/.complete`)} ]; then echo pi-desktop-kit=1; else echo pi-desktop-kit=0; fi`);
  if (!probe.includes("pi-desktop-kit=1")) {
    // 스크립트를 표준 입력으로 넘겨 그 셸이 읽게 한다 (명령 줄 길이 제한을 피한다)
    const out = await run("sh -s", Buffer.from(unpackScript(base, bundle), "utf8"));
    if (!out.includes("pi-desktop-kit=ok")) throw new Error("kit을 올리지 못했습니다");
  }
  return base;
}
