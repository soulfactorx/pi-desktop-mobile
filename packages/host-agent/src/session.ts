import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { DaemonEvents, type PiLocation, type PiResponse, type SessionSummary } from "@pi-desktop/host-protocol";
import { ExternalWriteDetector, type WatchFn } from "./external-write";
import { ActivityTracker } from "./activity";
import { EventJournal, type JournalEntry } from "./journal";
import { PendingDialogs } from "./pending-dialogs";
import { PiProcess, type PiExit } from "./pi-process";
import { TREE_COMMAND } from "./bridge";

/** 같은 Pi 프로세스 안에서 다른 세션 파일로 옮겨 가는 명령 */
const SESSION_SWITCHING_COMMANDS = new Set(["fork", "clone", "switch_session", "new_session"]);

export interface AgentSessionOptions {
  cwd: string;
  pi: PiLocation;
  nodePath: string;
  sessionFile?: string;
  /** 이 세션 파일에서 분기한 새 세션으로 연다 (pi --fork) */
  forkFrom?: string;
  piArgs?: string[];
  env?: NodeJS.ProcessEnv;
  journalCapacity?: number;
  /** 세션 파일 감시 (다른 프로그램이 쓰는지 감지용) */
  files: WatchFn;
  /** 우리 Pi가 이 시간 동안 조용한데 파일이 바뀌면 다른 프로그램이 쓴 것으로 본다 (ms) */
  externalWriteGraceMs?: number;
}

/**
 * 데몬이 소유하는 세션 하나 = Pi RPC 프로세스 하나 + 이벤트 저널.
 *
 * 앱 연결과 수명이 무관하다. 앱이 모두 떠나도 Pi는 계속 돌고 이벤트는 저널에 쌓인다 (설계 §3.4).
 */
export class AgentSession {
  readonly id = randomUUID();
  readonly startedAt = Date.now();
  readonly journal: EventJournal;
  private readonly process: PiProcess;
  private sessionFile: string | undefined;
  private exitInfo: PiExit | undefined;
  private readonly entryListeners = new Set<(entry: JournalEntry) => void>();
  private readonly exitListeners = new Set<(exit: PiExit) => void>();
  private readonly dialogListeners = new Set<(id: string) => void>();
  /** 아직 아무도 답하지 않은 확장 다이얼로그 */
  readonly dialogs = new PendingDialogs((id) => {
    for (const listener of this.dialogListeners) listener(id);
  });
  private readonly externalWriteListeners = new Set<(path: string, at: number) => void>();
  /** 활동 패널용: 일하는 중인지, 제목 */
  private readonly activity = new ActivityTracker();
  /** 다른 프로그램(TUI 등)이 이 세션 파일에 쓰는지 감지 (설계 §5.4) */
  private readonly externalWrite: ExternalWriteDetector;

  constructor(private readonly options: AgentSessionOptions) {
    this.journal = new EventJournal(options.journalCapacity);
    const args = [...(options.piArgs ?? [])];
    if (options.sessionFile) args.push("--session", options.sessionFile);
    if (options.forkFrom) args.push("--fork", options.forkFrom);
    this.process = new PiProcess({
      nodePath: options.nodePath,
      cliPath: options.pi.cliPath,
      cwd: options.cwd,
      args,
      env: options.env,
    });
    this.sessionFile = options.sessionFile;
    this.externalWrite = new ExternalWriteDetector(
      options.files,
      (path, at) => {
        for (const listener of this.externalWriteListeners) listener(path, at);
      },
      options.externalWriteGraceMs,
    );
  }

  /**
   * Pi를 띄우고 `get_state`로 준비 완료를 확인한다.
   * 이때 Pi가 정한 세션 파일 경로를 알아 두어, 나중에 프로세스가 죽어도 이어 열 수 있게 한다.
   */
  async start(): Promise<void> {
    this.process.onRecord((record) => {
      this.externalWrite.activity();
      this.dialogs.observe(record);
      this.activity.observe(record);
      this.record(record);
    });
    this.process.onExit((exit) => {
      this.exitInfo = exit;
      this.dialogs.clear();
      this.externalWrite.dispose();
      for (const listener of this.exitListeners) listener(exit);
    });
    this.process.start();

    let state: Awaited<ReturnType<PiProcess["send"]>>;
    try {
      state = await this.process.send({ type: "get_state" });
    } catch (error) {
      // 시작 중에 죽었다면 stderr에 원인이 있으므로 함께 알린다 (예: 잘못된 인자, 모델 없음).
      const detail = this.exitInfo?.stderrTail.trim();
      throw new Error(
        detail ? `Pi가 시작 중 종료되었습니다:\n${detail.split("\n").slice(-10).join("\n")}` : String(error),
      );
    }
    const data = state.data as Record<string, unknown> | undefined;
    if (state.success === true) this.activity.setName(data?.sessionName);
    if (state.success === true && typeof data?.sessionFile === "string") {
      this.sessionFile = data.sessionFile;
    } else if (state.success !== true) {
      throw new Error(`Pi 초기화 실패: ${String(state.error ?? "get_state 실패")}`);
    }
    await this.trackSessionFile(this.sessionFile);
  }

  /**
   * Pi RPC 명령을 보낸다. 같은 프로세스 안에서 다른 세션 파일로 옮겨 가는 명령
   * (fork, clone, switch_session, new_session)이 성공하면 세션 파일 경로를 다시 읽어 둔다.
   * 그래야 나중에 Pi가 종료되었을 때 "다시 열기"가 지금 보던 파일로 열린다.
   */
  async send(command: Record<string, unknown>): Promise<PiResponse> {
    // 명령 처리(모델 변경 등)로 Pi가 파일에 쓸 수 있으므로 보내기 전후를 활동으로 친다.
    this.externalWrite.activity();
    const response =
      command.type === "bash"
        ? await this.sendBash(command)
        : isTreeCommand(command)
          ? // 트리 이동은 떠나는 갈래를 LLM으로 요약할 수 있어 오래 걸린다. 명령이 끝나야 응답이 온다
            await this.process.send(command, { timeoutMs: TREE_TIMEOUT_MS })
          : await this.process.send(command);
    this.externalWrite.activity();
    if (response.success === true && SESSION_SWITCHING_COMMANDS.has(String(command.type))) {
      this.activity.resetForNewSession();
      await this.refreshSessionFile();
    }
    if (response.success === true && command.type === "set_session_name") this.activity.setName(command.name);
    return response;
  }

  /**
   * `!` 셸 명령. 끝나야 응답이 오므로 시간 제한 없이 기다린다.
   * Pi에는 시작·끝 이벤트가 없어서 데몬이 저널에 남긴다 (DaemonEvents 참고).
   */
  private async sendBash(command: Record<string, unknown>): Promise<PiResponse> {
    let id: string | undefined;
    const end = (fields: Record<string, unknown>) => {
      if (id) this.record({ type: DaemonEvents.bashEnd, id, ...fields });
    };
    try {
      const response = await this.process.send(command, {
        timeoutMs: null,
        onWrite: (sent) => {
          id = sent;
          this.record({
            type: DaemonEvents.bashStart,
            id,
            command: String(command.command ?? ""),
            excludeFromContext: command.excludeFromContext === true,
          });
        },
      });
      const data = (response.data ?? {}) as Record<string, unknown>;
      if (response.success === true) {
        end({
          exitCode: data.exitCode,
          cancelled: data.cancelled === true,
          truncated: data.truncated === true,
          ...(typeof data.fullOutputPath === "string" ? { fullOutputPath: data.fullOutputPath } : {}),
        });
      } else {
        end({ error: String(response.error ?? "bash 실패") });
      }
      return response;
    } catch (error) {
      end({ error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /** 저널에 남기고 붙어 있는 앱들에 알린다. */
  private record(event: unknown): void {
    const entry = this.journal.append(event);
    for (const listener of this.entryListeners) listener(entry);
  }

  private async refreshSessionFile(): Promise<void> {
    try {
      const state = await this.process.send({ type: "get_state" });
      const data = state.data as { sessionFile?: unknown; sessionName?: unknown } | undefined;
      // 옮겨 간 세션(switch_session 등)에 이미 이름이 있으면 그것을 제목으로 쓴다.
      this.activity.setName(data?.sessionName);
      const file = data?.sessionFile;
      if (typeof file === "string") {
        this.sessionFile = file;
        await this.trackSessionFile(file);
      }
    } catch {
      // 다음 기회에 다시 읽는다. 명령 자체의 응답은 그대로 돌려준다.
    }
  }

  /** 다른 프로그램의 끼어들기 감시 대상을 이 파일로 옮긴다. 지금 크기 뒤로 덧붙는 부분만 본다. */
  private async trackSessionFile(file: string | undefined): Promise<void> {
    const size = file ? ((await stat(file).catch(() => undefined))?.size ?? 0) : 0;
    this.externalWrite.track(file, size);
  }

  /** 응답이 없는 레코드를 Pi에 보낸다. 확장 다이얼로그 응답이면 대기 목록에서 뺀다. */
  sendRaw(record: Record<string, unknown>): void {
    this.externalWrite.activity();
    this.process.sendRaw(record);
    if (record.type === "extension_ui_response" && typeof record.id === "string") this.dialogs.resolve(record.id);
  }

  /** 다른 프로그램이 이 세션 파일에 쓴 것을 감지했을 때 */
  onExternalWrite(listener: (path: string, at: number) => void): () => void {
    this.externalWriteListeners.add(listener);
    return () => this.externalWriteListeners.delete(listener);
  }

  /** 사용자가 "무시하고 계속"을 골랐다 */
  clearExternalWrite(): void {
    this.externalWrite.clear();
  }

  /** 확장 다이얼로그가 처리될 때 (응답, 제한 시간, Pi 종료) */
  onDialogResolved(listener: (id: string) => void): () => void {
    this.dialogListeners.add(listener);
    return () => this.dialogListeners.delete(listener);
  }

  onEntry(listener: (entry: JournalEntry) => void): () => void {
    this.entryListeners.add(listener);
    return () => this.entryListeners.delete(listener);
  }

  onExit(listener: (exit: PiExit) => void): () => void {
    if (this.exitInfo) {
      listener(this.exitInfo);
      return () => {};
    }
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  stop(): Promise<PiExit> {
    return this.process.stop();
  }

  get isRunning(): boolean {
    return this.process.isRunning;
  }

  summary(): SessionSummary {
    const summary: SessionSummary = {
      sessionId: this.id,
      cwd: this.options.cwd,
      state: this.exitInfo ? "exited" : "running",
      lastSeq: this.journal.lastSeq,
      piVersion: this.options.pi.version,
      startedAt: this.startedAt,
      pendingUi: this.dialogs.size,
      busy: this.activity.busy && !this.exitInfo,
    };
    const title = this.activity.title;
    if (title) summary.title = title;
    if (this.sessionFile) summary.sessionFile = this.sessionFile;
    if (this.exitInfo) summary.exitCode = this.exitInfo.exitCode;
    const externalWriteAt = this.externalWrite.detectedAt;
    if (externalWriteAt !== undefined) summary.externalWriteAt = externalWriteAt;
    return summary;
  }
}

/** 트리 이동(요약 포함)을 기다리는 시간 */
const TREE_TIMEOUT_MS = 10 * 60 * 1000;

function isTreeCommand(command: Record<string, unknown>): boolean {
  return command.type === "prompt" && typeof command.message === "string" && command.message.startsWith(`/${TREE_COMMAND} `);
}
