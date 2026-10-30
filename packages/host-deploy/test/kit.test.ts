import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectKit, deployKit, execCommand, prepareRemote, unpackScript, type KitBundle } from "../src/index";

/** 이 PC의 sh로 원격 셸을 흉내 낸다 (sh -c <스크립트>, 표준 입력). HOME은 임시 폴더 */
function localRun(home: string) {
  return (script: string, input?: Buffer): Promise<string> =>
    new Promise((done, fail) => {
      const child = spawn("sh", ["-c", script], { env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
      child.stderr.on("data", (c: Buffer) => (err += c.toString("utf8")));
      child.on("exit", (code) => (code === 0 ? done(out) : fail(new Error(err))));
      child.stdin.end(input);
    });
}

function fakeKit(): { parts: Array<{ name: string; dir: string }>; root: string } {
  const root = mkdtempSync(join(tmpdir(), "kit-src-"));
  const a = join(root, "a-kit");
  mkdirSync(join(a, "extensions", "x"), { recursive: true });
  mkdirSync(join(a, "test"), { recursive: true });
  writeFileSync(join(a, "package.json"), '{"name":"a"}');
  writeFileSync(join(a, "extensions", "x", "index.ts"), "export default 1;\n");
  writeFileSync(join(a, "test", "skip.test.ts"), "x");
  const b = join(root, "b-iso");
  mkdirSync(join(b, "src"), { recursive: true });
  writeFileSync(join(b, "src", "paths.ts"), "export {};\n");
  return { parts: [{ name: "a-kit", dir: a }, { name: "pi-isolation", dir: b }], root };
}

describe("kit 모으기", () => {
  it("설치본 범위(package.json·src·extensions)만 이름 붙여 모으고, 내용이 같으면 해시도 같다", async () => {
    const { parts } = fakeKit();
    const one = await collectKit(parts);
    expect(one.files.map((f) => f.rel)).toEqual(["a-kit/extensions/x/index.ts", "a-kit/package.json", "pi-isolation/src/paths.ts"]);
    expect((await collectKit(parts)).hash).toBe(one.hash);
  });
});

describe.skipIf(process.platform === "win32")("원격 흉내 (sh)", () => {
  it("올린 kit은 원본과 같고, 이미 있으면 다시 올리지 않는다", async () => {
    const home = mkdtempSync(join(tmpdir(), "kit-remote-"));
    const bundle: KitBundle = {
      hash: "abc123",
      files: [
        { rel: "a-kit/package.json", data: Buffer.from('{"name":"x"}') },
        { rel: "a-kit/extensions/a b/index.ts", data: Buffer.from("export default 1;\n// '따옴표' \"와\" $HOME\n") },
        { rel: "pi-isolation/src/big.ts", data: Buffer.alloc(5000, 0x41) },
      ],
    };
    expect(unpackScript(`${home}/kits/abc123`, bundle)).toContain("PI_KIT_EOF");
    const calls: string[] = [];
    const run = localRun(home);
    const counted = (script: string, input?: Buffer) => (calls.push(script), run(script, input));
    const base = await deployKit(counted, home, bundle);
    expect(base).toBe(`${home}/kits/abc123`);
    for (const file of bundle.files) expect(readFileSync(join(base, file.rel))).toEqual(file.data);
    const uploads = calls.length;
    await deployKit(counted, home, bundle);
    expect(calls.length).toBe(uploads + 1);
  });

  it("번들과 kit을 앱 홈에 올리고, 그 호스트에서 실행할 명령을 만든다", async () => {
    const home = mkdtempSync(join(tmpdir(), "remote-home-"));
    const { parts, root } = fakeKit();
    const bundlePath = join(root, "app.mjs");
    writeFileSync(bundlePath, 'console.log(JSON.stringify({ cmd: process.argv[2], home: process.env.APP_HOME }));\n');
    const prepared = await prepareRemote("흉내", localRun(home), (script) => ({ command: "sh", args: ["-c", script] }), "", {
      homeDir: ".my-app",
      bundle: { path: bundlePath, version: "1.2.3", prefix: "my-runner", dir: "runner" },
      kit: () => collectKit(parts),
      command: (placed) => execCommand(placed, "connect", { APP_HOME: placed.appHome }),
    });
    expect(prepared.placed).toMatchObject({ userHome: home, appHome: `${home}/.my-app` });
    expect(prepared.placed.bundle).toMatch(new RegExp(`^${home}/\\.my-app/runner/my-runner-1\\.2\\.3-[0-9a-f]{12}\\.mjs$`));
    expect(existsSync(join(prepared.placed.kitBase, "a-kit", "extensions", "x", "index.ts"))).toBe(true);
    const out = execFileSync(prepared.spec.command, prepared.spec.args, { env: { ...process.env, HOME: home } }).toString();
    expect(JSON.parse(out)).toEqual({ cmd: "connect", home: `${home}/.my-app` });
  });
});
