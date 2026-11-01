import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { importSkill, listImportables } from "../src/imports";
import type { AppHome } from "../src/types";
import { listPackages, PACKAGE_PATHS_FILE, PACKAGE_TOOLS_FILE, packageDirs, packageName, packageToolNames, parsePiList, validPackageSource } from "../src/packages";

describe("pi list 읽기", () => {
  it("사용자 패키지의 출처와 설치 폴더를 읽는다 (프로젝트 패키지는 뺀다)", () => {
    const output = [
      "User packages:",
      "  npm:pi-web-access",
      "    /home/u/.pi-desktop-agent/npm/node_modules/pi-web-access",
      "  git:github.com/a/b@v1 (filtered)",
      "    /home/u/.pi-desktop-agent/git/github.com/a/b",
      "Project packages:",
      "  npm:other",
      "    /p/.pi/npm/node_modules/other",
    ].join("\n");
    expect(parsePiList(output)).toEqual({
      "npm:pi-web-access": "/home/u/.pi-desktop-agent/npm/node_modules/pi-web-access",
      "git:github.com/a/b@v1": "/home/u/.pi-desktop-agent/git/github.com/a/b",
    });
  });

  it("출처에서 이름을 만든다", () => {
    expect(packageName("npm:pi-web-access")).toBe("pi-web-access");
    expect(packageName("npm:@scope/tools@1.2.0")).toBe("@scope/tools");
    expect(packageName("git:github.com/x/my-pack@v1")).toBe("my-pack");
    expect(packageName("https://github.com/x/repo.git")).toBe("repo");
  });

  it("설치할 수 있는 출처만 받는다 (경로·명령은 받지 않는다)", () => {
    for (const ok of ["npm:pi-web-access", "npm:@scope/tools@1.2.0", "git:github.com/x/y@v1", "https://github.com/x/y"]) expect(validPackageSource(ok)).toBe(true);
    for (const bad of ["./local", "/etc", "npm:a; rm -rf /", "pi-web-access", "git:../../x", "npm:"]) expect(validPackageSource(bad)).toBe(false);
  });
});

describe("앱 홈의 패키지", () => {
  it("settings.json의 패키지와 적어 둔 폴더로 목록·세션 폴더를 만든다", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-res-pkg-"));
    const installed = join(home, "npm", "node_modules", "pi-web-access");
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(home, "settings.json"), JSON.stringify({ packages: ["npm:pi-web-access", { source: "npm:gone" }] }));
    writeFileSync(join(home, PACKAGE_PATHS_FILE), JSON.stringify({ "npm:pi-web-access": installed, "npm:gone": join(home, "nope"), "npm:removed": installed }));
    expect(await listPackages(home)).toEqual([
      { source: "npm:pi-web-access", name: "pi-web-access", path: installed },
      { source: "npm:gone", name: "gone" },
    ]);
    // settings.json에서 빠진 것(removed)과 폴더가 없는 것(gone)은 세션에 올리지 않는다
    expect(packageDirs(home)).toEqual([installed]);
    // 도구 이름도 settings.json에 남은 패키지 것만
    writeFileSync(join(home, PACKAGE_TOOLS_FILE), JSON.stringify({ "npm:pi-web-access": ["web_search", "fetch_content"], "npm:removed": ["old_tool"] }));
    expect(packageToolNames(home)).toEqual(["web_search", "fetch_content"]);
  });

  it("파일이 없으면 빈 목록", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-res-pkg-"));
    expect(await listPackages(home)).toEqual([]);
    expect(packageDirs(home)).toEqual([]);
    expect(packageToolNames(home)).toEqual([]);
  });
});

describe("다른 앱에서 가져오기", () => {
  const skill = (home: string, name: string) => {
    mkdirSync(join(home, "skills", name), { recursive: true });
    writeFileSync(join(home, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} 설명\n---\n지시\n`);
  };

  it("다른 앱의 스킬·패키지를 보이고, 스킬은 폴더째 복사한다", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-res-imp-"));
    const homes: AppHome[] = [
      { app: "desktop", label: "Pi Desktop", home: join(root, "desktop") },
      { app: "agent", label: "Agent", home: join(root, "agent") },
      { app: "mate", label: "Mate", home: join(root, "mate") },
    ];
    skill(homes[0]!.home, "weekly-report");
    skill(homes[0]!.home, "shared");
    skill(homes[1]!.home, "shared");
    writeFileSync(join(homes[0]!.home, "settings.json"), JSON.stringify({ packages: ["npm:pi-web-access"] }));
    const items = await listImportables(homes[1]!.home, homes);
    expect(items.skills.map((s) => [s.from, s.name, s.exists])).toEqual([
      ["desktop", "shared", true],
      ["desktop", "weekly-report", false],
    ]);
    expect(items.packages).toEqual([{ from: "desktop", fromLabel: "Pi Desktop", source: "npm:pi-web-access", name: "pi-web-access", exists: false }]);

    await importSkill(homes[1]!.home, homes, "desktop", "weekly-report");
    const after = await listImportables(homes[1]!.home, homes);
    expect(after.skills.find((s) => s.name === "weekly-report")?.exists).toBe(true);
    await expect(importSkill(homes[1]!.home, homes, "desktop", "shared")).rejects.toThrow("이미");
    await expect(importSkill(homes[1]!.home, homes, "desktop", "../x")).rejects.toThrow("올바르지");
  });
});
