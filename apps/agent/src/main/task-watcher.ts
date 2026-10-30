import type { TaskRecord } from "@pi-desktop/agent-kit/task-types";

/**
 * 작업 기록(tasks/<id>.json)을 주기적으로 읽어, 새로 끝난 작업을 알린다 (설계 DESIGN-AGENT.md §4 "알림").
 *
 * 작업은 대화 세션의 워커나 데몬의 스케줄러 세션이 남긴다. 앱이 꺼져 있던 동안 끝난 것은 처음 읽을 때
 * 기준선으로 삼고 알리지 않는다 (앱을 켤 때마다 지난 알림이 한꺼번에 뜨지 않게). 목록은 화면에서 본다.
 * fs.watch는 Windows에서 놓치거나 겹쳐 오는 일이 있어 주기적으로 읽는다.
 */
export class TaskWatcher {
  private readonly known = new Map<string, TaskRecord["status"]>();
  private started = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly load: () => Promise<TaskRecord[]>,
    private readonly onFinished: (task: TaskRecord) => void,
    private readonly onChanged: () => void,
  ) {}

  start(intervalMs = 5000): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async poll(): Promise<void> {
    let tasks: TaskRecord[];
    try {
      tasks = await this.load();
    } catch {
      return;
    }
    let changed = false;
    for (const task of tasks) {
      const before = this.known.get(task.id);
      if (before === task.status) continue;
      changed = true;
      this.known.set(task.id, task.status);
      // 처음 읽은 것은 기준선. 그 뒤로 새로 생기거나 실행 중에서 끝으로 바뀐 것만 알린다
      if (this.started && task.status !== "running") this.onFinished(task);
    }
    this.started = true;
    if (changed) this.onChanged();
  }
}
