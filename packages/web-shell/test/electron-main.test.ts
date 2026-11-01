import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clickNotification, configureShell, hub, menuGroups, Notification, onBackgroundNotify, safeStorage, shell, app } from "../src/electron/main";
import { listDir } from "../src/server/web-server";

describe("Electron 대체 모듈 (web-shell)", () => {
  it("메뉴: 역할(role)만 있는 항목과 구분선은 빼고, 누를 수 있는 항목만 묶는다", () => {
    const clicked: string[] = [];
    const { groups, clicks } = menuGroups([
      { label: "&파일", submenu: [{ role: "quit" }, { type: "separator" }, { label: "새 대화", accelerator: "CmdOrCtrl+N", click: () => clicked.push("new") }] },
      { label: "편집", submenu: [{ role: "copy" }, { role: "paste" }] },
      {
        label: "보기",
        submenu: [
          { label: "지식베이스", click: () => clicked.push("kb") },
          { label: "개발", submenu: [{ label: "로그", type: "checkbox", checked: true, click: () => clicked.push("log") }] },
          { label: "숨김", visible: false, click: () => clicked.push("hidden") },
        ],
      },
    ]);
    expect(groups).toEqual([
      { label: "파일", items: [{ id: "m1", label: "새 대화", accelerator: "CmdOrCtrl+N" }] },
      {
        label: "보기",
        items: [
          { id: "m2", label: "지식베이스" },
          { id: "m3", label: "개발 › 로그", checked: true },
        ],
      },
    ]);
    clicks.get("m3")!();
    expect(clicked).toEqual(["log"]);
  });

  it("safeStorage: 데이터 폴더의 키(0600)로 암호화하고 푼다", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ws-safe-"));
    configureShell({ name: "t", version: "1.0.0", dataDir, appPath: dataDir, packaged: true });
    const secret = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ";
    const encrypted = safeStorage.encryptString(secret);
    expect(encrypted.toString("utf8")).not.toContain("ABCdef");
    expect(safeStorage.decryptString(encrypted)).toBe(secret);
    if (process.platform !== "win32") expect(statSync(join(dataDir, "secret.key")).mode & 0o777).toBe(0o600);
    expect(app.getPath("userData")).toBe(dataDir);
    expect(app.getVersion()).toBe("1.0.0");
  });

  it("Notification: 보는 탭이 없으면 click id와 함께 웹 푸시로 보내고, 누를 때마다 click 처리를 부른다 (새로 읽힌 화면이 다시 보낼 수 있다)", () => {
    const sent: Array<{ title: string; clickId?: string }> = [];
    onBackgroundNotify((note) => sent.push(note));
    const controls: unknown[] = [];
    const original = hub.controlAll.bind(hub);
    hub.controlAll = (control) => (controls.push(control), original(control));
    let clicked = 0;
    new Notification({ title: "답이 끝났습니다", body: "b" }).on("click", () => clicked++).show();
    hub.controlAll = original;
    expect(sent).toHaveLength(1);
    const id = sent[0]!.clickId!;
    expect(id).toBeTruthy();
    expect(controls[0]).toMatchObject({ kind: "notify", title: "답이 끝났습니다", clickId: id });
    clickNotification(id);
    expect(clicked).toBe(1);
    clickNotification(id);
    expect(clicked).toBe(2);
    clickNotification("unknown");
    expect(clicked).toBe(2);
    // click이 없으면 id도 없다
    new Notification({ title: "t" }).show();
    expect(sent[1]!.clickId).toBeUndefined();
  });

  it("shell.openPath는 열 수 없다는 문구를 돌려준다 (Electron처럼 throw하지 않는다)", async () => {
    expect(await shell.openPath("/x")).toContain("웹 버전에서는");
  });

  it("폴더 훑기: 폴더를 먼저, 위 폴더를 알려 준다", async () => {
    const listing = await listDir(join(__dirname, ".."));
    expect(listing.parent).toBeDefined();
    const names = listing.entries.map((e) => e.name);
    expect(names.indexOf("src")).toBeLessThan(names.indexOf("package.json"));
  });
});
