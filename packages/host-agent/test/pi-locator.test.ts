import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ErrorCodes } from "@pi-desktop/host-protocol";
import { locatePi, memoizeLookup, PI_PACKAGE_NAME } from "../src/pi-locator";

/** 가짜 Pi 패키지 디렉터리를 만든다. */
async function fakePi(root: string, version: string): Promise<{ packageDir: string; cliPath: string }> {
  const packageDir = join(root, "node_modules", ...PI_PACKAGE_NAME.split("/"));
  await mkdir(join(packageDir, "dist", "bundle"), { recursive: true });
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify({ name: PI_PACKAGE_NAME, version, bin: { pi: "dist/bundle/cli.js" } }),
  );
  const cliPath = join(packageDir, "dist", "bundle", "cli.js");
  await writeFile(cliPath, "");
  return { packageDir, cliPath };
}

describe("locatePi", () => {
  let root: string;
  let pi: { packageDir: string; cliPath: string };
  const noGlobal = async () => undefined;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-locator-"));
    pi = await fakePi(root, "1.3.0");
  });

  it("파라미터로 준 cli 경로를 가장 먼저 쓰고, package.json에서 버전을 읽는다", async () => {
    const found = await locatePi({ piCliPath: pi.cliPath, env: {}, npmGlobalRoot: noGlobal });
    expect(found).toMatchObject({ cliPath: pi.cliPath, packageDir: pi.packageDir, version: "1.3.0", source: "param" });
  });

  it("PI_DESKTOP_PI_CLI 환경 변수를 쓴다", async () => {
    const found = await locatePi({ env: { PI_DESKTOP_PI_CLI: pi.cliPath }, npmGlobalRoot: noGlobal });
    expect(found.source).toBe("env");
  });

  it("npm 전역 설치 위치에서 bin 경로를 찾는다", async () => {
    const found = await locatePi({ env: {}, homeDir: root, npmGlobalRoot: async () => join(root, "node_modules") });
    expect(found).toMatchObject({ cliPath: pi.cliPath, version: "1.3.0", source: "npm-global" });
  });

  it("존재하지 않는 경로는 건너뛰고 다음 후보를 시도한다", async () => {
    const found = await locatePi({
      piCliPath: join(root, "missing.js"),
      env: {},
      homeDir: root,
      npmGlobalRoot: async () => join(root, "node_modules"),
    });
    expect(found.source).toBe("npm-global");
  });

  it("아무 데서도 못 찾으면 PiNotFound 오류와 시도한 경로를 준다", async () => {
    const emptyHome = await mkdtemp(join(tmpdir(), "pi-locator-empty-"));
    await expect(
      locatePi({ piCliPath: join(root, "missing.js"), env: {}, homeDir: emptyHome, npmGlobalRoot: noGlobal }),
    ).rejects.toMatchObject({
      code: ErrorCodes.PiNotFound,
      data: { tried: [join(root, "missing.js"), join(emptyHome, ".pi", "agent", "install")] },
    });
  });
});

describe("locatePi — 관리형 설치 (공식 설치기)", () => {
  /** 설치기가 만드는 구조: ~/.pi/agent/install/{current-version, releases/<v>/node_modules/...} */
  async function managedHome(version: string, withPiNode: boolean): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), "pi-managed-"));
    const installRoot = join(home, ".pi", "agent", "install");
    await fakePi(join(installRoot, "releases", version), version);
    await writeFile(join(installRoot, "current-version"), `${version}\n`);
    if (withPiNode) {
      const nodeBin = join(home, ".local", "share", "pi-node", "current", "bin");
      await mkdir(nodeBin, { recursive: true });
      await writeFile(join(nodeBin, "node"), "");
    }
    return home;
  }
  const noGlobal = async () => undefined;

  it("current-version이 가리키는 릴리스를 찾고 PI_MANAGED_INSTALL_ROOT를 넘긴다", async () => {
    const home = await managedHome("1.3.0", false);
    const found = await locatePi({ env: {}, homeDir: home, npmGlobalRoot: noGlobal });
    expect(found).toMatchObject({ version: "1.3.0", source: "managed" });
    expect(found.cliPath).toContain(join("releases", "1.3.0"));
    expect(found.env).toEqual({ PI_MANAGED_INSTALL_ROOT: join(home, ".pi", "agent", "install") });
    expect(found.nodePath).toBeUndefined();
  });

  it("설치기가 깐 pi-node가 있으면 그 node로 실행하고 PATH 앞에 둔다", async () => {
    const home = await managedHome("1.3.0", true);
    const nodeBin = join(home, ".local", "share", "pi-node", "current", "bin");
    const found = await locatePi({ env: { PATH: "/usr/bin" }, homeDir: home, npmGlobalRoot: noGlobal });
    expect(found.nodePath).toBe(join(nodeBin, "node"));
    expect(found.env?.PATH).toBe(`${nodeBin}${delimiter}/usr/bin`);
  });

  it("PI_CODING_AGENT_DIR로 바뀐 agent 디렉터리에서 찾는다", async () => {
    const home = await managedHome("1.2.0", false);
    const found = await locatePi({
      env: { PI_CODING_AGENT_DIR: join(home, ".pi", "agent") },
      homeDir: await mkdtemp(join(tmpdir(), "other-home-")),
      npmGlobalRoot: noGlobal,
    });
    expect(found.version).toBe("1.2.0");
  });

  it("current-version 값이 경로 조작 문자를 포함하면 무시한다", async () => {
    const home = await managedHome("1.3.0", false);
    await writeFile(join(home, ".pi", "agent", "install", "current-version"), "../../etc\n");
    await expect(locatePi({ env: {}, homeDir: home, npmGlobalRoot: noGlobal })).rejects.toMatchObject({
      code: ErrorCodes.PiNotFound,
    });
  });

  it("npm 전역 설치보다 관리형 설치를 먼저 쓴다 (PATH의 pi가 관리형 런처이므로)", async () => {
    const home = await managedHome("1.3.0", false);
    const globalRoot = await mkdtemp(join(tmpdir(), "pi-global-"));
    await fakePi(globalRoot, "1.1.0");
    const found = await locatePi({ env: {}, homeDir: home, npmGlobalRoot: async () => join(globalRoot, "node_modules") });
    expect(found.source).toBe("managed");
  });
});

describe("memoizeLookup — npm root -g 결과 기억", () => {
  function counter(values: Array<string | undefined>) {
    let calls = 0;
    const query = async () => values[Math.min(calls++, values.length - 1)];
    return { query, calls: () => calls };
  }

  it("한 번 찾은 값은 다시 조회하지 않고 바로 돌려준다", async () => {
    const q = counter(["/npm/a"]);
    const lookup = memoizeLookup(q.query, 60_000);
    expect(await lookup.get()).toEqual({ value: "/npm/a", cached: false });
    expect(await lookup.get()).toEqual({ value: "/npm/a", cached: true });
    expect(q.calls()).toBe(1);
  });

  it("동시에 여러 번 물어도 조회는 한 번만 한다", async () => {
    const q = counter(["/npm/a"]);
    const lookup = memoizeLookup(q.query, 60_000);
    const results = await Promise.all([lookup.get(), lookup.get(), lookup.get()]);
    expect(results.map((r) => r.value)).toEqual(["/npm/a", "/npm/a", "/npm/a"]);
    expect(q.calls()).toBe(1);
  });

  it("찾지 못했거나 실패한 결과는 기억하지 않는다", async () => {
    let calls = 0;
    const lookup = memoizeLookup(async () => {
      calls++;
      if (calls === 1) throw new Error("npm 없음");
      return calls === 2 ? undefined : "/npm/a";
    }, 60_000);
    expect((await lookup.get()).value).toBeUndefined();
    expect((await lookup.get()).value).toBeUndefined();
    expect((await lookup.get()).value).toBe("/npm/a");
    expect(calls).toBe(3);
  });

  it("오래된 값은 기다리지 않고 쓰면서 뒤에서 새로 조회한다", async () => {
    let time = 0;
    const q = counter(["/npm/old", "/npm/new"]);
    const lookup = memoizeLookup(q.query, 1_000, () => time);
    await lookup.get();
    time = 5_000;
    expect(await lookup.get()).toEqual({ value: "/npm/old", cached: true });
    await Promise.resolve();
    await Promise.resolve();
    expect((await lookup.get()).value).toBe("/npm/new");
    expect(q.calls()).toBe(2);
  });

  it("fresh면 기억한 값 대신 새로 조회해 기다린다", async () => {
    const q = counter(["/npm/old", "/npm/new"]);
    const lookup = memoizeLookup(q.query, 60_000);
    await lookup.get();
    expect(await lookup.get(true)).toEqual({ value: "/npm/new", cached: false });
    expect((await lookup.get()).value).toBe("/npm/new");
  });
});
