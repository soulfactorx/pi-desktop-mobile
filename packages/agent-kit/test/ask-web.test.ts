import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APPROVAL_MARKER, parseApprovalTitle } from "../src/approval";
import { classify, originPattern } from "../extensions/permissions/rules";
import { FREE_ANSWER } from "../extensions/ask-user/index";
import { htmlTitle, htmlToText } from "../extensions/web/html";
import { startPi, type RpcPi, type RpcRecord } from "./helpers/rpc-pi";
import { startScriptLlm, type ScriptLlm } from "./helpers/script-llm";

describe("분류와 HTML 변환", () => {
  it("ask_user는 묻지 않고, web_fetch는 사이트 단위 패턴으로 네트워크 승인", () => {
    expect(classify("ask_user", { question: "?" })).toEqual({ risk: "read" });
    expect(classify("web_fetch", { url: "https://a.com/x?q=1" }).request).toMatchObject({
      risk: "network",
      target: "https://a.com/x?q=1",
      pattern: "https://a.com/**",
    });
    expect(originPattern("엉뚱한 값")).toBe("엉뚱한 값");
  });

  it("본문만 남기고 엔티티를 푼다", () => {
    const html =
      "<html><head><title>공지 &amp; 안내</title><style>p{}</style></head>" +
      "<body><script>alert(1)</script><h1>제목</h1><p>첫&nbsp;문단 &lt;중요&gt;</p><ul><li>하나</li><li>둘 &#44608;</li></ul></body></html>";
    expect(htmlTitle(html)).toBe("공지 & 안내");
    expect(htmlToText(html)).toBe("제목\n첫 문단 <중요>\n하나\n둘 김");
  });
});

describe("ask_user·web_fetch (실제 Pi)", () => {
  let llm: ScriptLlm;
  let pi: RpcPi;
  let site: Server;
  let siteUrl: string;

  beforeAll(async () => {
    site = createServer((req, res) => {
      if (req.url === "/page") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<html><head><title>테스트 페이지</title></head><body><p>최신 버전은 1.4.0 입니다</p></body></html>");
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
    siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    llm = await startScriptLlm("mock-model");
    ({ pi } = await startPi(llm.baseUrl));
  });

  afterAll(async () => {
    pi?.close();
    await llm?.close();
    await new Promise((resolve) => site?.close(resolve));
  });

  const lastToolEnd = (from: number) => pi.records.slice(from).filter((r: RpcRecord) => r.type === "tool_execution_end").at(-1);
  const selects = (from: number) => pi.records.slice(from).filter((r) => r.type === "extension_ui_request" && r.method === "select");

  it("ask_user는 승인 없이 선택지로 묻고 답을 돌려준다", async () => {
    llm.setScript([{ tool: "ask_user", args: { question: "어느 폴더를 정리할까요?", options: ["다운로드", "바탕화면"] } }, { text: "알겠다" }]);
    const from = pi.mark;
    await pi.request({ type: "prompt", message: "정리해" });
    const asked = await pi.waitFor((r) => r.type === "extension_ui_request" && r.method === "select", from);
    expect(asked.title).toBe("어느 폴더를 정리할까요?");
    expect(asked.options).toEqual(["다운로드", "바탕화면", FREE_ANSWER]);
    pi.write({ type: "extension_ui_response", id: asked.id, value: "바탕화면" });
    await pi.waitFor((r) => r.type === "agent_settled", from);

    expect(selects(from).some((r) => String(r.title).startsWith(APPROVAL_MARKER))).toBe(false);
    expect(JSON.stringify(lastToolEnd(from)?.result)).toContain("사용자의 답: 바탕화면");
  });

  it("직접 입력을 고르면 글로 다시 묻는다", async () => {
    llm.setScript([{ tool: "ask_user", args: { question: "이름은?", options: ["a", "b"] } }, { text: "응" }]);
    const from = pi.mark;
    await pi.request({ type: "prompt", message: "물어봐" });
    const asked = await pi.waitFor((r) => r.type === "extension_ui_request" && r.method === "select", from);
    pi.write({ type: "extension_ui_response", id: asked.id, value: FREE_ANSWER });
    const input = await pi.waitFor((r) => r.type === "extension_ui_request" && r.method === "input", from);
    pi.write({ type: "extension_ui_response", id: input.id, value: "직접 쓴 답" });
    await pi.waitFor((r) => r.type === "agent_settled", from);
    expect(JSON.stringify(lastToolEnd(from)?.result)).toContain("사용자의 답: 직접 쓴 답");
  });

  it("web_fetch는 네트워크 승인을 받은 뒤 본문을 읽는다", async () => {
    llm.setScript([{ tool: "web_fetch", args: { url: `${siteUrl}/page` } }, { text: "확인" }]);
    const from = pi.mark;
    await pi.request({ type: "prompt", message: "읽어" });
    const asked = await pi.waitFor((r) => r.type === "extension_ui_request" && r.method === "select", from);
    expect(parseApprovalTitle(String(asked.title))).toMatchObject({ toolName: "web_fetch", riskLabel: "네트워크", target: `${siteUrl}/page` });
    pi.write({ type: "extension_ui_response", id: asked.id, value: (asked.options as string[])[0] });
    await pi.waitFor((r) => r.type === "agent_settled", from);

    const result = JSON.stringify(lastToolEnd(from)?.result);
    expect(result).toContain("제목: 테스트 페이지");
    expect(result).toContain("최신 버전은 1.4.0 입니다");
  });

  it("없는 페이지는 오류로 돌려준다", async () => {
    llm.setScript([{ tool: "web_fetch", args: { url: `${siteUrl}/nope` } }, { text: "없네" }]);
    const from = pi.mark;
    await pi.request({ type: "prompt", message: "읽어" });
    const asked = await pi.waitFor((r) => r.type === "extension_ui_request" && r.method === "select", from);
    pi.write({ type: "extension_ui_response", id: asked.id, value: (asked.options as string[])[0] });
    await pi.waitFor((r) => r.type === "agent_settled", from);
    const end = lastToolEnd(from);
    expect(end?.isError).toBe(true);
    expect(JSON.stringify(end?.result)).toContain("HTTP 404");
  });
});
