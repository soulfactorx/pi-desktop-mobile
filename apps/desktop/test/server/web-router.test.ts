import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { WebRouter, type PeerSocket } from "../../src/server/web-router";
import { packArgs, parseClientMessage, unpackArgs, type ServerMessage } from "../../src/shared/web-protocol";

/** 보낸 메시지를 모으는 가짜 WebSocket */
class FakeSocket extends EventEmitter implements PeerSocket {
  readyState = 1;
  sent: ServerMessage[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMessage);
  }
  receive(message: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(message)));
  }
  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("web-protocol", () => {
  it("undefined였던 인자를 되살린다 (null은 그대로)", () => {
    const packed = packArgs(["h", undefined, null, 3]);
    const wire = JSON.parse(JSON.stringify(packed)) as { args: unknown[]; u?: number[] };
    expect(unpackArgs(wire.args, wire.u)).toEqual(["h", undefined, null, 3]);
    expect(packArgs(["a"])).toEqual({ args: ["a"] });
  });

  it("모양이 틀린 메시지는 버린다", () => {
    expect(parseClientMessage("not json")).toBeUndefined();
    expect(parseClientMessage(JSON.stringify({ t: "invoke", ch: "x", args: [] }))).toBeUndefined();
    expect(parseClientMessage(JSON.stringify({ t: "send", ch: "x", args: "a" }))).toBeUndefined();
    expect(parseClientMessage(JSON.stringify({ t: "send", ch: "x", args: [], u: ["0"] }))).toBeUndefined();
    expect(parseClientMessage(JSON.stringify({ t: "invoke", id: 1, ch: "x", args: [1] }))).toEqual({ t: "invoke", id: 1, ch: "x", args: [1] });
  });
});

describe("WebRouter", () => {
  it("요청을 처리기로 보내고 결과를 돌려준다. 처리기는 요청한 연결을 받는다", async () => {
    const router = new WebRouter();
    const seen: unknown[] = [];
    router.handle("pi:echo", (peer, a, b) => {
      seen.push(peer.isDestroyed(), a, b);
      return { a, b };
    });
    const socket = new FakeSocket();
    router.attach(socket);
    socket.receive({ t: "invoke", id: 7, ch: "pi:echo", args: ["x", null], u: [1] });
    await tick();
    expect(seen).toEqual([false, "x", undefined]);
    expect(socket.sent).toEqual([{ t: "result", id: 7, ok: true, value: { a: "x" } }]);
  });

  it("오류와 모르는 채널은 Electron과 같은 문구로 실패를 돌려준다", async () => {
    const router = new WebRouter();
    router.handle("pi:fail", async () => {
      throw new Error("안 됨");
    });
    const socket = new FakeSocket();
    router.attach(socket);
    socket.receive({ t: "invoke", id: 1, ch: "pi:fail", args: [] });
    socket.receive({ t: "invoke", id: 2, ch: "pi:nope", args: [] });
    await tick();
    // 응답은 처리가 끝나는 차례로 온다
    expect([...socket.sent].sort((x, y) => ("id" in x && "id" in y ? x.id - y.id : 0))).toEqual([
      { t: "result", id: 1, ok: false, error: "Error invoking remote method 'pi:fail': Error: 안 됨" },
      { t: "result", id: 2, ok: false, error: "Error invoking remote method 'pi:nope': Error: 알 수 없는 채널입니다: pi:nope" },
    ]);
  });

  it("응답 없는 메시지를 처리하고, 알림은 열린 연결 모두에 보낸다", async () => {
    const router = new WebRouter();
    const writes: unknown[] = [];
    router.on("pi:write", (_peer, id, data) => writes.push([id, data]));
    const a = new FakeSocket();
    const b = new FakeSocket();
    router.attach(a);
    router.attach(b);
    a.receive({ t: "send", ch: "pi:write", args: ["t1", "ls\r"] });
    await tick();
    expect(writes).toEqual([["t1", "ls\r"]]);

    router.broadcast("pi:session-event", "local", { seq: 1 });
    expect(a.sent).toEqual([{ t: "event", ch: "pi:session-event", args: ["local", { seq: 1 }] }]);
    expect(b.sent).toEqual(a.sent);
  });

  it("닫힌 연결은 destroyed를 알리고 더 받지 않는다", () => {
    const router = new WebRouter();
    const socket = new FakeSocket();
    const peer = router.attach(socket);
    let destroyed = false;
    peer.once("destroyed", () => (destroyed = true));
    socket.close();
    expect(destroyed).toBe(true);
    expect(peer.isDestroyed()).toBe(true);
    expect(router.size).toBe(0);
    peer.send("pi:terminal-data", "t1", "x");
    expect(socket.sent).toEqual([]);
  });
});
