import { describe, expect, it } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import { appMenuTemplate, type MenuCommand } from "../src/main/app-menu";

const labels = (items: MenuItemConstructorOptions[]) => items.map((i) => i.label ?? i.role ?? i.type);
const sub = (items: MenuItemConstructorOptions[], label: string) =>
  (items.find((i) => i.label === label)?.submenu ?? []) as MenuItemConstructorOptions[];

describe("앱 메뉴", () => {
  const sent: string[] = [];
  const handlers = { command: (id: MenuCommand) => sent.push(id), checkForUpdates: () => sent.push("update"), openReleases: () => {}, about: () => {} };

  it("Windows: 파일·편집·보기·도움말, 기능 화면은 보기 메뉴에", () => {
    const menu = appMenuTemplate("win32", true, handlers);
    expect(labels(menu)).toEqual(["파일", "편집", "보기", "도움말"]);
    expect(labels(sub(menu, "보기")).slice(0, 10)).toEqual(["대화", "작업·예약", "지식베이스", "스킬", "승인", "사용량", "지난 대화", "웹 검색·MCP", "네트워크", "설정"]);
    // 설치본에는 개발 도구가 없다
    expect(sub(menu, "보기").some((i) => i.role === "toggleDevTools")).toBe(false);
  });

  it("항목을 누르면 화면에 명령 id를 보낸다", () => {
    const menu = appMenuTemplate("win32", false, handlers);
    sub(menu, "보기").find((i) => i.label === "지식베이스")!.click!({} as never, undefined, {} as never);
    sub(menu, "파일").find((i) => i.label === "새 대화")!.click!({} as never, undefined, {} as never);
    sub(menu, "도움말").find((i) => i.label === "업데이트 확인…")!.click!({} as never, undefined, {} as never);
    expect(sent).toEqual(["page:memory", "new-chat", "update"]);
    expect(sub(menu, "보기").some((i) => i.role === "toggleDevTools")).toBe(true);
  });

  it("macOS는 앱 메뉴를 앞에 둔다", () => {
    expect(appMenuTemplate("darwin", true, handlers)[0]).toEqual({ role: "appMenu" });
  });
});
