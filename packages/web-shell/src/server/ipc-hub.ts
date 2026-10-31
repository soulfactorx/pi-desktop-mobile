import { AsyncLocalStorage } from "node:async_hooks";
import { packArgs, ShellChannels, unpackArgs, type ClientData, type Control, type DialogRequest, type MenuGroup } from "../protocol";
import { SessionTable, type ClientSession, type SessionLimits } from "./session";

/** ipcMain.handle 처리기의 첫 인자 (Electron의 IpcMainInvokeEvent 중 앱이 쓰는 부분) */
export interface HubEvent {
  sender: HubSender;
}

/** 그 요청을 보낸 탭 (Electron의 WebContents 자리) */
export interface HubSender {
  id: string;
  send(channel: string, ...args: unknown[]): void;
  isDestroyed(): boolean;
}

type Handler = (event: HubEvent, ...args: any[]) => unknown;

export interface HubOptions extends Partial<SessionLimits> {
  /** 끊긴 탭의 세션을 이만큼 가지고 있는다 (그 안에 다시 붙으면 놓친 것을 받는다) */
  expireMs?: number;
}

/**
 * ipcMain 자리를 맡는다: 브라우저 탭들(세션)의 메시지를 앱이 건 처리기로 나눠 주고,
 * webContents.send를 모든 탭에 보낸다. 대화상자·메뉴·알림처럼 Electron이 OS로 하던 일은 탭에 시킨다 (Control).
 */
export class IpcHub {
  readonly sessions: SessionTable;
  private readonly handlers = new Map<string, Handler>();
  private readonly listeners = new Map<string, Set<Handler>>();
  /** 지금 처리 중인 요청을 보낸 세션 (열기·대화상자를 그 탭에 보낸다) */
  private readonly current = new AsyncLocalStorage<ClientSession>();
  private nextDialog = 1;
  private readonly dialogs = new Map<number, (value: unknown) => void>();
  private menu: MenuGroup[] = [];

  constructor(options: HubOptions = {}) {
    this.sessions = new SessionTable(
      (session, data) => this.dispatch(session, data),
      { maxBufferBytes: options.maxBufferBytes ?? 64 * 1024 * 1024 },
      options.expireMs ?? 15 * 60_000,
    );
  }

  handle(channel: string, handler: Handler): void {
    if (this.handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
    this.handlers.set(channel, handler);
  }

  /** 앱이 건 처리기를 웹에 맞게 바꾼다 (웹 서버 진입점에서만 쓴다) */
  override(channel: string, handler: Handler): void {
    this.handlers.set(channel, handler);
  }

  /** 지금 걸린 처리기 (감싸서 바꿀 때) */
  handler(channel: string): Handler | undefined {
    return this.handlers.get(channel);
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }

  on(channel: string, listener: Handler): void {
    let set = this.listeners.get(channel);
    if (!set) this.listeners.set(channel, (set = new Set()));
    set.add(listener);
  }

  removeListener(channel: string, listener: Handler): void {
    this.listeners.get(channel)?.delete(listener);
  }

  /** 모든 탭에 알린다 (webContents.send) */
  broadcast(channel: string, ...args: unknown[]): void {
    for (const session of this.sessions.live()) session.send({ t: "event", ch: channel, ...packArgs(args) });
  }

  /** 모든 탭에 시킨다 */
  controlAll(control: Control): void {
    for (const session of this.sessions.live()) session.send({ t: "control", control });
  }

  /** 지금 요청을 보낸 탭, 없으면 마지막으로 쓴 탭에 시킨다 */
  controlOne(control: Control): void {
    this.target()?.send({ t: "control", control });
  }

  /**
   * 대화상자를 띄우고 답을 기다린다. 지금 요청을 보낸 탭에 묻고, 모르면 붙어 있는 탭 모두에 묻는다 (먼저 답한 것).
   * 열린 탭이 없으면 바로 undefined (취소).
   */
  ask(request: DialogRequest): Promise<unknown> {
    const current = this.current.getStore();
    const targets = current && !current.dead ? [current] : this.sessions.live().filter((s) => s.connected);
    if (targets.length === 0) return Promise.resolve(undefined);
    const id = this.nextDialog++;
    return new Promise((resolve) => {
      this.dialogs.set(id, (value) => {
        this.dialogs.delete(id);
        if (targets.length > 1) this.controlAll({ kind: "dialog-done", id });
        resolve(value);
      });
      for (const session of targets) session.send({ t: "control", control: { kind: "dialog", id, request } });
    });
  }

  /** 이 앱을 보고 있는 탭이 있는가 (붙어 있고 화면이 보이는 탭) */
  anyVisible(): boolean {
    return this.sessions.live().some((s) => s.connected && s.visible);
  }

  /** 앱 메뉴를 바꾼다. 새로 붙는 탭에도 보낸다 */
  setMenu(groups: MenuGroup[]): void {
    this.menu = groups;
    this.controlAll({ kind: "menu", groups });
  }

  /** 세션이 (다시) 붙었다. 새 세션이면 메뉴를 보낸다 */
  attached(session: ClientSession, resumed: boolean): void {
    if (!resumed && this.menu.length > 0) session.send({ t: "control", control: { kind: "menu", groups: this.menu } });
  }

  private target(): ClientSession | undefined {
    const current = this.current.getStore();
    if (current && !current.dead) return current;
    return this.sessions
      .live()
      .filter((s) => s.connected)
      .sort((a, b) => b.lastActive - a.lastActive)[0];
  }

  private sender(session: ClientSession): HubSender {
    return {
      id: session.id,
      send: (channel, ...args) => session.send({ t: "event", ch: channel, ...packArgs(args) }),
      isDestroyed: () => session.dead,
    };
  }

  async dispatch(session: ClientSession, data: ClientData): Promise<void> {
    if (data.t === "answer") {
      this.dialogs.get(data.id)?.(data.value);
      return;
    }
    const args = unpackArgs(data.args, data.u);
    if (data.t === "send" && data.ch === ShellChannels.visibility) {
      session.visible = args[0] === true;
      return;
    }
    const event: HubEvent = { sender: this.sender(session) };
    if (data.t === "send") {
      for (const listener of this.listeners.get(data.ch) ?? []) {
        try {
          await this.current.run(session, () => listener(event, ...args));
        } catch {
          // 응답 없는 메시지의 오류는 돌려줄 곳이 없다
        }
      }
      return;
    }
    const handler = this.handlers.get(data.ch);
    try {
      if (!handler) throw new Error(`No handler registered for '${data.ch}'`);
      const value = await this.current.run(session, () => handler(event, ...args));
      session.send({ t: "result", id: data.id, ok: true, ...(value === undefined ? {} : { value }) });
    } catch (error) {
      // Electron과 같은 문구로 돌려준다. 화면이 이 접두사를 떼어 보여 주는 곳이 있다
      session.send({ t: "result", id: data.id, ok: false, error: `Error invoking remote method '${data.ch}': ${String(error)}` });
    }
  }
}
