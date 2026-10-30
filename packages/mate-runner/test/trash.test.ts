import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendChat, readChat } from "@pi-desktop/mate-kit";
import { matePaths, type MatePaths } from "../src/paths";
import { clearChat, deleteDuty, deleteRun, deleteSkill, listRuns, pruneRuns, saveDuty, writeRun } from "../src/store";
import { emptyTrash, listTrash, restoreTrash } from "../src/trash";
import type { RunRecord } from "../src/types";

async function home(): Promise<MatePaths> {
  const paths = matePaths(await mkdtemp(join(tmpdir(), "mate-trash-")));
  await mkdir(paths.sessions, { recursive: true });
  return paths;
}

const run = (paths: MatePaths, id: string, startedAt: number): RunRecord => ({
  id,
  dutyId: "ci",
  dutyName: "CI 확인",
  reason: "manual",
  status: "done",
  startedAt,
  model: "",
  profile: "observe",
  sessionFile: join(paths.sessions, `${id}_s.jsonl`),
});

describe("Mate 휴지통", () => {
  it("임무를 지우면 휴지통으로 가고 되살리면 돌아온다. 같은 임무가 다시 생겼으면 거절한다", async () => {
    const paths = await home();
    const duty = await saveDuty(paths, { id: "ci", name: "CI 확인", cwd: "/repo", prompt: "봐", profile: "observe", trigger: { kind: "manual" } });
    await deleteDuty(paths, duty.id);
    expect(existsSync(join(paths.duties, `${duty.id}.json`))).toBe(false);
    const [item] = await listTrash(paths);
    expect(item).toMatchObject({ kind: "duty", title: "CI 확인", detail: "/repo", files: 1 });

    await saveDuty(paths, { ...duty });
    await expect(restoreTrash(paths, item!.id)).rejects.toThrow(/이미 파일이 있습니다/);
    await deleteDuty(paths, duty.id);
    // 두 항목 모두 휴지통에 있고, 하나를 되살린다
    const items = await listTrash(paths);
    expect(items).toHaveLength(2);
    await restoreTrash(paths, items[1]!.id);
    expect(existsSync(join(paths.duties, `${duty.id}.json`))).toBe(true);
  });

  it("실행 기록은 세션 파일과 함께 옮기고, 200개를 넘는 것은 한 항목으로 묶어 정리한다", async () => {
    const paths = await home();
    for (let i = 0; i < 5; i++) {
      const record = run(paths, `20261030-00000${i}-aaaaaa`, Date.UTC(2026, 9, 30, 0, 0, i));
      await writeRun(paths, record);
      await writeFile(record.sessionFile!, "{}\n");
    }
    await deleteRun(paths, "20261030-000004-aaaaaa");
    expect((await listTrash(paths))[0]).toMatchObject({ kind: "run", title: "CI 확인 실행", files: 2 });

    await pruneRuns(paths, 2);
    expect((await listRuns(paths)).map((r) => r.id)).toEqual(["20261030-000003-aaaaaa", "20261030-000002-aaaaaa"]);
    const pruned = (await listTrash(paths)).find((i) => i.title.startsWith("오래된 실행 기록"))!;
    expect(pruned).toMatchObject({ title: "오래된 실행 기록 2개 정리", files: 4 });
    expect(await readdir(paths.sessions)).toHaveLength(2);

    await restoreTrash(paths, pruned.id);
    expect(await listRuns(paths)).toHaveLength(4);
    expect(await readdir(paths.sessions)).toHaveLength(4);
  });

  it("대화 기록을 지우면 새 대화가 되고, 되살리면 그사이 대화와 시각 순으로 합친다", async () => {
    const paths = await home();
    await mkdir(paths.chatSessions, { recursive: true });
    await appendChat(paths.chat, { role: "user", text: "옛 질문", at: 1 });
    await appendChat(paths.chat, { role: "mate", text: "옛 답", at: 2 });
    await writeFile(join(paths.chatSessions, "a_mate-chat-1.jsonl"), "{}\n");
    expect(await clearChat(paths)).toBe(true);
    expect(await readChat(paths.chat)).toEqual([]);
    expect(await readdir(paths.chatSessions)).toEqual([]);
    // 지울 것이 없으면 항목을 만들지 않는다
    expect(await clearChat(paths)).toBe(false);

    await appendChat(paths.chat, { role: "user", text: "새 질문", at: 3 });
    const [item] = await listTrash(paths);
    await restoreTrash(paths, item!.id);
    expect((await readChat(paths.chat)).map((l) => l.text)).toEqual(["옛 질문", "옛 답", "새 질문"]);
    expect(await readdir(paths.chatSessions)).toEqual(["a_mate-chat-1.jsonl"]);
    expect(readFileSync(paths.chat, "utf8").trim().split("\n")).toHaveLength(3);
  });

  it("스킬은 폴더째(딸린 파일 포함) 휴지통으로 가고 되살아난다", async () => {
    const paths = await home();
    await mkdir(join(paths.skills, "hn-summary", "scripts"), { recursive: true });
    await writeFile(join(paths.skills, "hn-summary", "SKILL.md"), "---\nname: hn-summary\ndescription: d\n---\nx\n");
    await writeFile(join(paths.skills, "hn-summary", "scripts", "a.txt"), "a");
    await deleteSkill(paths, "hn-summary");
    expect(existsSync(join(paths.skills, "hn-summary"))).toBe(false);
    const [item] = await listTrash(paths);
    expect(item).toMatchObject({ kind: "skill", title: "hn-summary" });
    await restoreTrash(paths, item!.id);
    expect(readFileSync(join(paths.skills, "hn-summary", "scripts", "a.txt"), "utf8")).toBe("a");
    await expect(deleteSkill(paths, "../x")).rejects.toThrow(/이름/);
  });

  it("비우기는 고른 것만 또는 전부 정말 지우고, 이상한 id는 거절한다", async () => {
    const paths = await home();
    for (const name of ["a", "b"]) {
      const duty = await saveDuty(paths, { id: name, name, cwd: "/r", prompt: "p", profile: "observe", trigger: { kind: "manual" } });
      await deleteDuty(paths, duty.id);
    }
    const [first] = await listTrash(paths);
    expect(await emptyTrash(paths, [first!.id])).toBe(1);
    expect(await listTrash(paths)).toHaveLength(1);
    expect(await emptyTrash(paths)).toBe(1);
    expect(await listTrash(paths)).toEqual([]);
    await expect(emptyTrash(paths, ["../duties"])).rejects.toThrow(/잘못된/);
  });
});
