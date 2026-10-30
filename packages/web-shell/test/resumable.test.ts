import { describe, expect, it } from "vitest";
import { IpcHub } from "../src/server/ipc-hub";
import type { SessionSocket } from "../src/server/session";
import { ResumableTransport, type SocketLike } from "../src/client/transport";
import type { Control } from "../src/protocol";

/** 브라우저 쪽 소켓과 서버 쪽 소켓을 메모리로 잇는다. drop()은 말없이 끊긴 것처럼 양쪽을 닫는다 */
class Link {
  open = true;
  client: SocketLike;
  server: SessionSocket;
  private serverMessage: ((data: unknown) => void) | undefined;
  private serverClose: (() => void) | undefined;

  constructor() {
    const link = this;
    this.client = {
      get readyState() {
        return link.open ? 1 : 3;
      },
      onopen: null,
      onmessage: null,
      onclose: null,
      send(data: string) {
        if (link.open) queueMicrotask(() => link.serverMessage?.(data));
      },
      close() {
        link.drop();
      },
    };
    this.server = {
      get readyState() {
        return link.open ? 1 : 3;
      },
      send(data: string) {
        if (link.open) queueMicrotask(() => link.client.onmessage?.({ data }));
      },
      close() {
        link.drop();
      },
      on(_event: "message", listener: (data: unknown) => void) {
        link.serverMessage = listener;
      },
      once(_event: "close", listener: () => void) {
        link.serverClose = listener;
      },
    };
  }

  drop(): void {
    if (!this.open) return;
    this.open = false;
    this.serverClose?.();
    this.client.onclose?.({});
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5));

/** 서버(hub)와 브라우저(transport)를 잇는다. connect할 때마다 새 Link를 만든다 */
function setup(hub = new IpcHub()) {
  const links: Link[] = [];
  const controls: Control[] = [];
  let resets = 0;
  const statuses: string[] = [];
  const state = { hub };
  const transport = new ResumableTransport(
    (last) => `client=abcdefgh1234&last=${last}`,
    { onControl: (c) => controls.push(c), onReset: () => resets++, onStatus: (s) => statuses.push(s) },
    (url) => {
      const link = new Link();
      links.push(link);
      const last = Number(/last=(\d+)/.exec(url)![1]);
      queueMicrotask(() => {
        const { session, resumed } = state.hub.sessions.open("abcdefgh1234", last);
        session.attach(link.server, { t: "hello", resumed, app: "test", version: "1" }, last);
        state.hub.attached(session, resumed);
      });
      return link.client;
    },
  );
  return { transport, links, controls, state, resets: () => resets, statuses };
}

describe("이어지는 연결 (web-shell)", () => {
  it("invoke·send·알림이 오간다", async () => {
    const hub = new IpcHub();
    const sent: unknown[] = [];
    hub.handle("add", (_e, a: number, b: number) => a + b);
    hub.on("note", (_e, value: unknown) => sent.push(value));
    const { transport } = setup(hub);
    const events: unknown[] = [];
    transport.on("tick", (...args) => events.push(args));
    transport.connect();
    expect(await transport.invoke("add", 2, 3)).toBe(5);
    transport.send("note", undefined);
    await tick();
    expect(sent).toEqual([undefined]);
    hub.broadcast("tick", 1, undefined);
    await tick();
    expect(events).toEqual([[1, undefined]]);
    await expect(transport.invoke("missing")).rejects.toThrow("No handler registered for 'missing'");
  });

  it("끊긴 동안의 알림과 응답을 다시 붙으면 받고, 끊긴 동안 보낸 것은 한 번만 처리된다", async () => {
    const hub = new IpcHub();
    let release: (v: string) => void = () => {};
    hub.handle("slow", () => new Promise<string>((r) => (release = r)));
    const calls: number[] = [];
    hub.on("count", (_e, n: number) => calls.push(n));
    const { transport, links } = setup(hub);
    const events: unknown[] = [];
    transport.on("ev", (n) => events.push(n));
    transport.connect();
    await tick();
    const slow = transport.invoke("slow");
    transport.send("count", 1);
    await tick();
    links[0]!.drop();
    // 끊긴 동안: 서버는 알림을 보내고 응답을 끝낸다. 브라우저는 메시지를 보낸다
    hub.broadcast("ev", "a");
    hub.broadcast("ev", "b");
    release("done");
    transport.send("count", 2);
    await tick();
    expect(events).toEqual([]);
    transport.connect();
    expect(await slow).toBe("done");
    await tick();
    expect(events).toEqual(["a", "b"]);
    expect(calls).toEqual([1, 2]);
    // 다시 붙은 뒤도 정상
    hub.broadcast("ev", "c");
    await tick();
    expect(events).toEqual(["a", "b", "c"]);
  });

  it("서버가 세션을 잃었으면(서버를 다시 켬) 기다리던 요청을 실패로 끝내고 새로 읽게 한다", async () => {
    const hub = new IpcHub();
    hub.handle("never", () => new Promise(() => {}));
    const { transport, links, state, resets } = setup(hub);
    transport.connect();
    await tick();
    const waiting = transport.invoke("never");
    await tick();
    links[0]!.drop();
    state.hub = new IpcHub();
    transport.connect();
    await expect(waiting).rejects.toThrow("세션이 끊겼습니다");
    expect(resets()).toBe(1);
  });

  it("끊긴 동안 버퍼가 넘치면 세션을 버리고, 다시 붙으면 새로 읽게 한다", async () => {
    const hub = new IpcHub({ maxBufferBytes: 2000 });
    const { transport, links, resets } = setup(hub);
    transport.connect();
    await tick();
    links[0]!.drop();
    for (let i = 0; i < 50; i++) hub.broadcast("big", "x".repeat(100));
    transport.connect();
    await tick();
    expect(resets()).toBe(1);
  });

  it("대화상자: 요청을 보낸 탭에 묻고 답을 돌려준다", async () => {
    const hub = new IpcHub();
    hub.handle("pick", () => hub.ask({ kind: "open", directory: true, multiple: false }));
    const { transport, controls } = setup(hub);
    transport.connect();
    const answer = transport.invoke("pick");
    await tick();
    const dialog = controls.find((c) => c.kind === "dialog");
    expect(dialog).toMatchObject({ kind: "dialog", request: { kind: "open", directory: true } });
    transport.answer((dialog as Extract<Control, { kind: "dialog" }>).id, ["/home/u/proj"]);
    expect(await answer).toEqual(["/home/u/proj"]);
  });

  it("열린 탭이 없으면 대화상자는 바로 취소", async () => {
    const hub = new IpcHub();
    expect(await hub.ask({ kind: "save" })).toBeUndefined();
  });

  it("메뉴는 새로 붙는 탭에도 보낸다", async () => {
    const hub = new IpcHub();
    hub.setMenu([{ label: "보기", items: [{ id: "m1", label: "지식베이스" }] }]);
    const { transport, controls } = setup(hub);
    transport.connect();
    await tick();
    expect(controls).toContainEqual({ kind: "menu", groups: [{ label: "보기", items: [{ id: "m1", label: "지식베이스" }] }] });
  });
});
