import { describe, expect, it } from "vitest";
import type { TaskRecord } from "@pi-desktop/agent-kit/task-types";
import { TaskWatcher } from "../src/main/task-watcher";

const task = (id: string, status: TaskRecord["status"]): TaskRecord => ({
  id,
  status,
  title: id,
  instruction: "",
  origin: "schedule",
  cwd: "",
  startedAt: "",
});

describe("TaskWatcher", () => {
  it("처음 읽은 것은 알리지 않고, 그 뒤 끝난 것만 한 번씩 알린다", async () => {
    let tasks = [task("old", "done"), task("t1", "running")];
    const finished: string[] = [];
    let changes = 0;
    const watcher = new TaskWatcher(
      async () => tasks,
      (t) => finished.push(`${t.id}:${t.status}`),
      () => changes++,
    );
    await watcher.poll();
    expect(finished).toEqual([]);
    expect(changes).toBe(1);

    tasks = [task("old", "done"), task("t1", "done"), task("t2", "failed")];
    await watcher.poll();
    expect(finished).toEqual(["t1:done", "t2:failed"]);

    await watcher.poll();
    expect(finished).toHaveLength(2);
    expect(changes).toBe(2);
  });

  it("읽기에 실패하면 조용히 넘어간다", async () => {
    const watcher = new TaskWatcher(
      async () => {
        throw new Error("x");
      },
      () => {
        throw new Error("알리면 안 된다");
      },
      () => {
        throw new Error("바뀌면 안 된다");
      },
    );
    await watcher.poll();
  });
});
