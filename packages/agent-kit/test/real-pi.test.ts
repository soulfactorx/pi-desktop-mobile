import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KIT_VERSION, STATUS_COMMAND } from "../src/index";
import { startPi, type RpcPi } from "./helpers/rpc-pi";

/** 실제 Pi에 agent-kit을 -e로 올려 기본 확장이 동작하는지 (LLM은 부르지 않음) */
describe("agent-kit (실제 Pi)", () => {
  let pi: RpcPi;

  beforeAll(async () => {
    ({ pi } = await startPi());
  });

  afterAll(() => pi?.close());

  it("명령 목록에 /agent:status가 있다", async () => {
    const response = await pi.request({ type: "get_commands" });
    const names = ((response.data as { commands: Array<{ name: string }> }).commands ?? []).map((c) => c.name);
    expect(names).toContain(STATUS_COMMAND);
  });

  it("/agent:status는 LLM을 부르지 않고 버전을 알린다", async () => {
    const response = await pi.request({ type: "prompt", message: `/${STATUS_COMMAND}` });
    expect(response.success).toBe(true);
    const notice = await pi.waitFor((r) => r.type === "extension_ui_request" && r.method === "notify");
    expect(notice.message).toBe(`agent-kit ${KIT_VERSION}`);
  });
});
