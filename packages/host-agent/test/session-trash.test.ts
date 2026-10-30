import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSessionPath, emptyTrash, listTrash, moveToTrash, restoreFromTrash, summarize, trashDirs } from "../src/session-trash";
import { loadArchive, setArchived } from "../src/session-archive";

const header = (cwd = "/tmp/x") => `${JSON.stringify({ type: "session", version: 3, id: "s1", cwd })}\n`;
const user = (text: string) => `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }] } })}\n`;
const named = (name: string) => `${JSON.stringify({ type: "session_info", name })}\n`;

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "trash-"));
  const home = join(dir, "home");
  const piDir = join(dir, "pi");
  const file = join(dir, "sessions", "2026-10-30_s1.jsonl");
  await mkdir(join(dir, "sessions"), { recursive: true });
  await writeFile(file, `${header()}${user("첫 요청")}${named("이름1")}${named("이름2")}`);
  return { dir, home, piDir, file };
}

describe("세션 휴지통", () => {
  it("지우면 휴지통으로 옮기고 원래 자리를 적어 두며, 되살리면 그 자리로 돌아간다", async () => {
    const { home, piDir, file } = await setup();
    const result = await moveToTrash(file, home, new Date("2026-10-30T07:30:00Z"));
    expect(existsSync(file)).toBe(false);
    expect(result).toEqual({ path: file, backup: join(trashDirs(home).trash, "20261030-073000-2026-10-30_s1.jsonl"), trashId: "20261030-073000-2026-10-30_s1.jsonl" });

    const items = await listTrash(home, piDir);
    expect(items).toEqual([
      {
        id: result.trashId,
        originalPath: file,
        deletedAt: Date.UTC(2026, 9, 30, 7, 30),
        sessionId: "s1",
        cwd: "/tmp/x",
        name: "이름2",
        firstMessage: "첫 요청",
        size: expect.any(Number),
      },
    ]);

    expect(await restoreFromTrash(home, result.trashId!, piDir)).toBe(file);
    expect(readFileSync(file, "utf8")).toContain("첫 요청");
    expect(await listTrash(home, piDir)).toEqual([]);
  });

  it("원래 자리에 파일이 다시 생겼으면 덮어쓰지 않는다", async () => {
    const { home, piDir, file } = await setup();
    const { trashId } = await moveToTrash(file, home);
    await writeFile(file, header());
    await expect(restoreFromTrash(home, trashId!, piDir)).rejects.toThrow(/이미 파일이 있습니다/);
  });

  it("예전 삭제의 백업도 보이고, 원래 자리는 Pi 기본 규칙으로 계산한다", async () => {
    const { home, piDir } = await setup();
    const { legacy } = trashDirs(home);
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "20261029-010203-old_s2.jsonl"), `${header("/work/repo")}${user("예전")}`);
    const [item] = await listTrash(home, piDir);
    expect(item).toMatchObject({ id: "20261029-010203-old_s2.jsonl", legacy: true, deletedAt: Date.UTC(2026, 9, 29, 1, 2, 3), firstMessage: "예전" });
    expect(item!.originalPath).toBe(defaultSessionPath(piDir, "/work/repo", "old_s2.jsonl"));
    const restored = await restoreFromTrash(home, item!.id, piDir);
    expect(readFileSync(restored, "utf8")).toContain("예전");
  });

  it("비우기는 고른 것만 또는 전부 정말 지운다", async () => {
    const { home, piDir, file, dir } = await setup();
    const first = await moveToTrash(file, home, new Date("2026-10-30T01:00:00Z"));
    const second = join(dir, "sessions", "b.jsonl");
    await writeFile(second, header());
    await moveToTrash(second, home, new Date("2026-10-30T02:00:00Z"));
    expect(await emptyTrash(home, [first.trashId!])).toBe(1);
    expect((await listTrash(home, piDir)).map((i) => i.id)).toEqual(["20261030-020000-b.jsonl"]);
    expect(await emptyTrash(home)).toBe(1);
    expect(await listTrash(home, piDir)).toEqual([]);
  });

  it("세션 파일이 아니거나 휴지통 밖을 가리키면 거절한다", async () => {
    const { home, dir } = await setup();
    const notes = join(dir, "notes.txt");
    await writeFile(notes, header());
    await expect(moveToTrash(notes, home)).rejects.toThrow(/\.jsonl/);
    const other = join(dir, "data.jsonl");
    await writeFile(other, '{"type":"log"}\n');
    await expect(moveToTrash(other, home)).rejects.toThrow(/Pi 세션 파일이 아닙니다/);
    await expect(emptyTrash(home, ["../sessions/2026-10-30_s1.jsonl"])).rejects.toThrow(/잘못된/);
    expect(await moveToTrash(join(dir, "none.jsonl"), home)).toEqual({ path: join(dir, "none.jsonl") });
  });

  it("summarize는 헤더가 아니면 undefined", () => {
    expect(summarize('{"type":"log"}')).toBeUndefined();
    expect(summarize(`${header()}${user("a".repeat(300))}`)?.firstMessage).toHaveLength(200);
  });
});

describe("세션 아카이브", () => {
  it("아카이브하고 되돌린다 (동시에 고쳐도 사라지지 않는다)", async () => {
    const home = await mkdtemp(join(tmpdir(), "archive-"));
    await Promise.all([setArchived(home, "/a.jsonl", true, 1), setArchived(home, "/b.jsonl", true, 2)]);
    expect(await loadArchive(home)).toEqual({ "/a.jsonl": 1, "/b.jsonl": 2 });
    await setArchived(home, "/a.jsonl", false);
    expect(await loadArchive(home)).toEqual({ "/b.jsonl": 2 });
  });
});
