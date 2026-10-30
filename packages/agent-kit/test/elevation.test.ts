import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APPROVAL_MARKER, ApprovalChoice, approvalOptions, parseApprovalTitle } from "../src/approval";
import { argvLine, compileElevated, ELEVATED_TOOL } from "../extensions/elevation/compile";
import { classify, hardBlockReason } from "../extensions/permissions/rules";
import { startPi, type RpcPi, type RpcRecord } from "./helpers/rpc-pi";
import { startScriptLlm, type ScriptLlm } from "./helpers/script-llm";

describe("권한 상승: 작업을 argv로", () => {
  it("플랫폼마다 패키지·서비스·복사를 argv로 바꾼다 (셸을 거치지 않음)", () => {
    expect(compileElevated({ op: "package_install", names: ["git"] }, "linux", "apt-get")).toEqual(["apt-get", "install", "-y", "git"]);
    expect(compileElevated({ op: "package_remove", names: ["git"] }, "linux", "pacman")).toEqual(["pacman", "-R", "--noconfirm", "git"]);
    expect(compileElevated({ op: "package_install", names: ["Git.Git"] }, "win32")).toEqual([
      "winget",
      "install",
      "--silent",
      "--accept-source-agreements",
      "--accept-package-agreements",
      "--id",
      "Git.Git",
    ]);
    expect(compileElevated({ op: "service", action: "restart", unit: "nginx" }, "linux", "dnf")).toEqual(["systemctl", "restart", "nginx"]);
    expect(compileElevated({ op: "service", action: "stop", unit: "Spooler" }, "win32")).toEqual(["sc.exe", "stop", "Spooler"]);
    expect(compileElevated({ op: "copy_file", from: "C:\\a b.txt", to: "C:\\Windows\\x.txt" }, "win32").at(-1)).toBe(
      "Copy-Item -LiteralPath 'C:\\a b.txt' -Destination 'C:\\Windows\\x.txt' -Force",
    );
    expect(compileElevated({ op: "raw", argv: ["ls", "; rm -rf /"] }, "darwin")).toEqual(["ls", "; rm -rf /"]);
  });

  it("잘못된 입력은 이유와 함께 거절한다", () => {
    expect(() => compileElevated({ op: "package_install", names: ["git; rm -rf /"] }, "linux", "apt-get")).toThrow(/패키지 이름/);
    expect(() => compileElevated({ op: "raw", argv: ["sudo", "ls"] }, "linux")).toThrow(/sudo는 넣지 말라/);
    expect(() => compileElevated({ op: "raw", argv: ["C:\\tools\\gsudo.exe", "x"] }, "win32")).toThrow(/gsudo/);
    expect(() => compileElevated({ op: "copy_file", from: "~/a", to: "/etc/a" }, "linux")).toThrow(/절대 경로/);
    expect(() => compileElevated({ op: "package_install", names: ["a", "b"] }, "win32")).toThrow(/한 패키지/);
    expect(() => compileElevated({ op: "package_update" }, "linux", "pacman")).toThrow(/pacman/);
    expect(() => compileElevated({ op: "package_install", names: ["git"] }, "darwin")).toThrow(/Homebrew/);
    expect(() => compileElevated({ op: "service", unit: "x" }, "linux")).toThrow(/action/);
  });

  it("승인 화면 한 줄: 공백이 든 인자는 따옴표로", () => {
    expect(argvLine(["cp", "-f", "/a b", "/c"])).toBe('cp -f "/a b" /c');
  });
});

describe("권한 상승: 승인", () => {
  it("한 번만 묻는 요청이고 저장할 패턴이 없다. 잘못된 입력은 invalid", () => {
    const { request } = classify(ELEVATED_TOOL, { op: "raw", argv: ["whoami"] });
    expect(request).toMatchObject({ toolName: ELEVATED_TOOL, risk: "exec", target: "whoami", onceOnly: true });
    expect(approvalOptions(request!)).toEqual([ApprovalChoice.once, ApprovalChoice.deny]);
    expect(classify(ELEVATED_TOOL, { op: "raw", argv: ["sudo", "x"] }).invalid).toMatch(/sudo/);
  });

  it("bash의 sudo는 막고, 상승 도구를 안내한다", () => {
    expect(hardBlockReason("sudo apt install git")).toContain(ELEVATED_TOOL);
  });
});

describe("권한 상승 (실제 Pi)", () => {
  let llm: ScriptLlm;
  const started: RpcPi[] = [];

  beforeAll(async () => {
    llm = await startScriptLlm("mock-model");
  });

  afterAll(async () => {
    for (const pi of started) pi.close();
    await llm?.close();
  });

  const tools = (request: Record<string, unknown> | undefined) =>
    ((request?.tools as Array<{ function?: { name?: string } }> | undefined) ?? []).map((t) => t.function?.name);

  /** 한 번 말을 걸고 모델이 받은 도구 이름들 */
  async function toolsSeen(pi: RpcPi): Promise<Array<string | undefined>> {
    llm.setScript([{ text: "응" }]);
    const from = pi.mark;
    await pi.request({ type: "prompt", message: "안녕" });
    await pi.waitFor((r) => r.type === "agent_settled", from);
    return tools(llm.requests.at(-1));
  }

  it("기본은 꺼져 있어 모델에게 보이지 않는다", async () => {
    const { pi } = await startPi(llm.baseUrl);
    started.push(pi);
    const seen = await toolsSeen(pi);
    expect(seen).toContain("bash");
    expect(seen).not.toContain(ELEVATED_TOOL);
  });

  it("켜면 보이고, 부르면 '이번만 허용·거부'로만 묻는다. 거부하면 실행하지 않는다", async () => {
    const { pi } = await startPi(llm.baseUrl, { dataFiles: { "elevation.json": JSON.stringify({ enabled: true }) } });
    started.push(pi);
    expect(await toolsSeen(pi)).toContain(ELEVATED_TOOL);

    llm.setScript([{ tool: ELEVATED_TOOL, args: { op: "raw", argv: ["whoami"] } }, { text: "알겠어" }]);
    const from = pi.mark;
    await pi.request({ type: "prompt", message: "관리자로 whoami" });
    const isApproval = (r: RpcRecord) => r.type === "extension_ui_request" && r.method === "select" && String(r.title).startsWith(APPROVAL_MARKER);
    const asked = await pi.waitFor(isApproval, from);
    expect(parseApprovalTitle(String(asked.title))).toMatchObject({ toolName: ELEVATED_TOOL, target: "whoami" });
    expect(asked.options).toEqual([ApprovalChoice.once, ApprovalChoice.deny]);
    // 테스트에서는 절대 허용하지 않는다 (실제 OS 인증 창이 뜬다)
    pi.write({ type: "extension_ui_response", id: asked.id, value: ApprovalChoice.deny });
    const end = await pi.waitFor((r) => r.type === "tool_execution_end", from);
    await pi.waitFor((r) => r.type === "agent_settled", from);
    expect(end.isError).toBe(true);
    expect(JSON.stringify(end.result)).toContain("사용자가 거부했다");
  });

  it("켜 있어도 사람이 없는 실행(워커·예약)에는 보이지 않는다", async () => {
    const { pi } = await startPi(llm.baseUrl, {
      dataFiles: { "elevation.json": JSON.stringify({ enabled: true }) },
      env: { PI_DESKTOP_AGENT_UNATTENDED: "1" },
    });
    started.push(pi);
    expect(await toolsSeen(pi)).not.toContain(ELEVATED_TOOL);
  });
});
