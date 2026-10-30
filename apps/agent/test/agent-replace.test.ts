import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionSummary } from "@pi-desktop/host-protocol";
import { HostConnection } from "../src/vendor/main/host-connection";
import type { ConnectionState } from "../src/shared/api";

/**
 * 예전 데몬 바꾸기 (설계 §3.4). 앱보다 예전 번들의 데몬이라도, 늘 떠 있는 예약 작업 세션만 돌고 있으면 바로 바꾼다.
 * 연결기 대신 가짜 데몬 스크립트를 띄운다: host.info에 예전 빌드를 알리고, daemon.shutdown을 받으면 파일에 남기고 끝난다.
 */
function fakeDaemon(dir: string, sessions: Array<Pick<SessionSummary, "cwd" | "state">>): string {
  const script = join(dir, "fake-daemon.cjs");
  writeFileSync(
    script,
    `
const sessions = ${JSON.stringify(sessions)};
let buf = "";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === "host.info") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentVersion: "0.0.1", agentBuild: "old", platform: "linux", arch: "x64", nodeVersion: "v22", pid: process.pid } });
    else if (m.method === "daemon.status") send({ jsonrpc: "2.0", id: m.id, result: { pid: process.pid, agentVersion: "0.0.1", agentBuild: "old", startedAt: 0, clients: 1, sessions, idleShutdownMs: 0 } });
    else if (m.method === "daemon.shutdown") {
      require("node:fs").writeFileSync(${JSON.stringify(join(dir, "shutdown"))}, "1");
      send({ jsonrpc: "2.0", id: m.id, result: null });
      setTimeout(() => process.exit(0), 50);
    }
  }
});
`,
  );
  return script;
}

const SCHEDULER = "/home/u/.pi-desktop-agent/scheduler";
let connection: HostConnection | undefined;
afterEach(() => connection?.dispose());

function connect(sessions: Array<Pick<SessionSummary, "cwd" | "state">>, blocksReplace?: (s: SessionSummary) => boolean) {
  const dir = mkdtempSync(join(tmpdir(), "agent-replace-"));
  const script = fakeDaemon(dir, sessions);
  const states: ConnectionState[] = [];
  const ignore = () => {};
  connection = new HostConnection({
    prepare: async () => ({ command: process.execPath, args: [script], agentBuild: "new" }),
    onState: (s) => states.push(s),
    onSessionEvent: ignore,
    onSessionExit: ignore,
    onUiResolved: ignore,
    onStoredChanged: ignore,
    onExternalWrite: ignore,
    onWriterChanged: ignore,
    onFilesChanged: ignore,
    onPlaygroundOutput: ignore,
    onPiUpdateOutput: ignore,
    ...(blocksReplace ? { blocksReplace } : {}),
  });
  connection.start();
  return { dir, states };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 50 && !check(); i++) await new Promise((r) => setTimeout(r, 100));
};

describe("예전 데몬 바꾸기", () => {
  it("예약 작업 세션만 돌고 있으면 바로 끄고 새 번들로 다시 붙는다", async () => {
    const { dir } = connect([{ cwd: SCHEDULER, state: "running" }], (s) => s.cwd !== SCHEDULER);
    await until(() => existsSync(join(dir, "shutdown")));
    expect(readFileSync(join(dir, "shutdown"), "utf8")).toBe("1");
  });

  it("대화가 돌고 있으면 그대로 쓰면서 업데이트 대기를 알린다 (예약 세션은 세지 않는다)", async () => {
    const { dir, states } = connect(
      [
        { cwd: SCHEDULER, state: "running" },
        { cwd: "/home/u/work", state: "running" },
      ],
      (s) => s.cwd !== SCHEDULER,
    );
    await until(() => states.some((s) => s.status === "connected"));
    expect(states.find((s) => s.status === "connected")).toMatchObject({ agentUpdate: { liveSessions: 1 } });
    expect(existsSync(join(dir, "shutdown"))).toBe(false);
  });
});
