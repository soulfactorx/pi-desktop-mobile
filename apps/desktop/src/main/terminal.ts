import { randomUUID } from "node:crypto";
import type * as Pty from "node-pty";
import type { TerminalCommand } from "./terminal-command";

/** 터미널을 연 화면. Electron WebContents와 웹 서버의 WebSocket 연결(server/ws-peer.ts)이 이 모양을 갖는다 */
export interface TerminalOwner {
  send(channel: string, ...args: unknown[]): void;
  isDestroyed(): boolean;
  once(event: "destroyed", listener: () => void): unknown;
}

/**
 * node-pty는 처음 터미널을 열 때 불러온다. 네이티브 모듈이라 미리 빌드된 파일이 없는 곳(Android Termux)에서는
 * 없을 수 있다. 그래도 터미널 말고 다른 기능은 쓸 수 있게 한다.
 */
let ptyModule: Promise<typeof Pty> | undefined;
function loadPty(): Promise<typeof Pty> {
  ptyModule ??= import("node-pty").catch((error: unknown) => {
    ptyModule = undefined;
    throw new Error(
      `내장 터미널에 필요한 node-pty를 불러오지 못했습니다 (${error instanceof Error ? error.message : String(error)}).\n` +
        "Termux라면 설치 스크립트를 --terminal로 다시 실행하세요.",
    );
  });
  return ptyModule;
}

/**
 * 내장 터미널 프로세스 관리 (설계 §4.12). node-pty로 띄우고 출력·종료를 그 터미널을 연 렌더러에만 보낸다.
 * 렌더러가 사라지거나 앱이 끝나면 남은 터미널을 모두 끝낸다 (Windows ConPTY 보조 프로세스가 남지 않게).
 */
export class TerminalService {
  private readonly terminals = new Map<string, { proc: Pty.IPty; owner: TerminalOwner }>();

  constructor(
    private readonly channels: { data: string; exit: string },
    private readonly baseEnv: NodeJS.ProcessEnv = process.env,
  ) {}

  async open(owner: TerminalOwner, command: TerminalCommand, cols: number, rows: number): Promise<string> {
    const pty = await loadPty();
    const id = randomUUID();
    const proc = pty.spawn(command.file, command.args, {
      name: "xterm-256color",
      cols: clampSize(cols, 80),
      rows: clampSize(rows, 24),
      ...(command.cwd ? { cwd: command.cwd } : {}),
      env: { ...this.baseEnv, ...command.env, TERM: "xterm-256color", COLORTERM: "truecolor" } as Record<string, string>,
    });
    this.terminals.set(id, { proc, owner });
    proc.onData((data) => {
      if (!owner.isDestroyed()) owner.send(this.channels.data, id, data);
    });
    proc.onExit(({ exitCode }) => {
      this.terminals.delete(id);
      if (!owner.isDestroyed()) owner.send(this.channels.exit, id, exitCode);
    });
    // 이 터미널을 연 창이 닫히면 함께 끝낸다.
    owner.once("destroyed", () => this.close(id));
    return id;
  }

  write(id: string, data: string): void {
    this.terminals.get(id)?.proc.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const terminal = this.terminals.get(id);
    if (!terminal) return;
    try {
      terminal.proc.resize(clampSize(cols, 80), clampSize(rows, 24));
    } catch {
      // 이미 끝난 프로세스면 무시
    }
  }

  close(id: string): void {
    const terminal = this.terminals.get(id);
    if (!terminal) return;
    this.terminals.delete(id);
    try {
      terminal.proc.kill();
    } catch {
      // 이미 끝났으면 무시
    }
  }

  dispose(): void {
    for (const id of [...this.terminals.keys()]) this.close(id);
  }
}

function clampSize(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 2 && value <= 1000 ? Math.floor(value) : fallback;
}
