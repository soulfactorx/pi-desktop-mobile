import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { digestRun, extractPrompt, looksSecret, parseOps } from "../extensions/memory/extract";
import { loadAutoLearn, saveAutoLearn } from "../extensions/memory/store";
import { startPi, type RpcPi, type RpcRecord } from "./helpers/rpc-pi";
import { startScriptLlm, type ScriptLlm } from "./helpers/script-llm";

const user = (text: string) => ({ role: "user", content: text, timestamp: 0 });
const assistant = (...content: unknown[]) => ({ role: "assistant", content });
const result = (toolName: string, text: string, isError = false) => ({
  role: "toolResult",
  toolName,
  content: [{ type: "text", text }],
  isError,
});

describe("실행 정리 (digestRun)", () => {
  it("대화 기록을 만들고, 실패한 도구는 실패 신호로 모은다", () => {
    const digest = digestRun([
      user("설정 파일 고쳐 줘"),
      assistant({ type: "thinking", thinking: "생각" }, { type: "text", text: "고칠게요" }, { type: "toolCall", name: "edit", arguments: { path: "a.json" } }),
      result("edit", "사용자가 거부했다. 같은 작업을 다시 시도하지 말고", true),
      assistant({
        type: "toolCall",
        name: "bash",
        arguments: { command: "npm tset" },
      }),
      result("bash", "npm error Unknown command: tset", true),
    ]);
    expect(digest.hasUser).toBe(true);
    expect(digest.verified).toBe(false);
    expect(digest.transcript).toContain("사용자: 설정 파일 고쳐 줘");
    expect(digest.transcript).toContain("에이전트: 고칠게요");
    expect(digest.transcript).not.toContain("생각");
    expect(digest.failures.map((f) => f.kind)).toEqual(["approval-denied", "tool-error"]);
  });

  it("관찰 도구가 성공하면 확인된 실행이고, 사용자 메시지가 없으면 hasUser가 false", () => {
    expect(digestRun([user("읽어 줘"), result("read", "내용")]).verified).toBe(true);
    expect(digestRun([user("써 줘"), result("write", "썼다")]).verified).toBe(false);
    expect(digestRun([assistant({ type: "text", text: "작업 끝 알림" })]).hasUser).toBe(false);
  });
});

describe("추출 요청과 응답 읽기", () => {
  it("요청 본문: 기존 항목 id·종류·제목, 실패 신호, 긴 기록은 끝을 남긴다", () => {
    const prompt = extractPrompt(
      [{ id: "m1", type: "user", title: "회사 PC는 Windows", content: "본문", tags: [], status: "active", pinned: false, origin: "agent", created: "", updated: "" }],
      {
        transcript: `${"앞".repeat(5000)}마지막 말`,
        failures: [{ kind: "tool-error", detail: "bash — 실패" }],
        verified: false,
        hasUser: true,
      },
      1000,
    );
    expect(prompt).toContain("id=m1 [user] 회사 PC는 Windows");
    expect(prompt).toContain("(tool-error) bash — 실패");
    expect(prompt).toContain("마지막 말");
    expect(prompt.length).toBeLessThan(1500);
  });

  it("사고 블록·코드 펜스를 걷어 내고, 모르는 id·형식이 틀린 op·민감 정보는 버린다", () => {
    const raw =
      '<think>음</think>```json\n{"ops":[{"op":"create","type":"user","title":"답은 짧게","content":"세 줄 이내","tags":["답"]},' +
      '{"op":"create","type":"weird","title":"x","content":"x"},{"op":"create","type":"user","content":"제목 없음"},{"op":"update","id":"nope","content":"y"},' +
      '{"op":"update","id":"m1","content":"회사 PC는 Windows 11"},{"op":"forget","id":"m1"},' +
      '{"op":"create","type":"reference","title":"키","content":"API key: sk-abcdefghijklmnop1234"}]}\n```';
    expect(parseOps(raw, new Set(["m1"]))).toEqual([
      { op: "create", type: "user", title: "답은 짧게", content: "세 줄 이내", tags: ["답"] },
      { op: "update", id: "m1", content: "회사 PC는 Windows 11" },
      { op: "archive", id: "m1" },
    ]);
  });

  it("출력이 중간에 끊겨도 앞의 온전한 op는 살린다", () => {
    const raw = '{"ops":[{"op":"create","type":"user","title":"하나","content":"일"},{"op":"create","type":"user","title":"둘","content":"이';
    expect(parseOps(raw, new Set())).toEqual([{ op: "create", type: "user", title: "하나", content: "일", tags: [] }]);
    expect(parseOps("저장할 것 없음", new Set())).toEqual([]);
    expect(() => parseOps('{"ops":[', new Set())).toThrow(/JSON/);
  });

  it("민감 정보 판별: 키·토큰은 걸리고 경로·평범한 문장은 통과", () => {
    expect(looksSecret("ghp_abcdefghijklmnopqrstuvwxyz")).toBe(true);
    expect(looksSecret("비밀번호: hunter2")).toBe(true);
    expect(looksSecret("작업 폴더는 C:/Users/07912/Documents/GitHub/pi-desktop-agent")).toBe(false);
    expect(looksSecret("토큰은 환경 변수에 둔다")).toBe(false);
  });
});

describe("턴 뒤 기억 추출 (실제 Pi)", () => {
  let llm: ScriptLlm;
  let pi: RpcPi;
  let dataDir: string;
  const isExtract = (text: string) => text.includes("## 기존 항목");

  beforeAll(async () => {
    llm = await startScriptLlm("mock-model");
    // 추출 요청은 차례로 이 답을 받는다
    llm.route(isExtract, [
      {
        text: '{"ops":[{"op":"create","type":"lesson","title":"없는 파일 읽기","content":"**재발 방지:** 읽기 전에 ls로 이름을 확인한다","tags":["read"]}]}',
      },
      { text: '{"ops":[]}' },
    ]);
    ({ pi, dataDir } = await startPi(llm.baseUrl, {
      env: { PI_DESKTOP_AGENT_LEARN: "1" },
    }));
  });

  afterAll(async () => {
    pi?.close();
    await llm?.close();
  });

  const notices = (from: number) =>
    pi.records
      .slice(from)
      .filter((r: RpcRecord) => r.type === "extension_ui_request" && r.method === "notify")
      .map((r) => String(r.message));

  it("실행이 끝나면 지금 모델로 기억을 뽑아 저장하고 알린다 (실패 신호를 함께 넘김)", async () => {
    llm.setScript([{ tool: "read", args: { path: "no-such-file.txt" } }, { text: "파일이 없네요" }]);
    const from = pi.mark;
    await pi.request({ type: "prompt", message: "no-such-file.txt 읽어 줘" });
    await pi.waitFor((r) => r.type === "extension_ui_request" && r.method === "notify" && String(r.message).startsWith("지식베이스에 남겼습니다"), from);
    expect(notices(from)).toContain("지식베이스에 남겼습니다: [교훈] 없는 파일 읽기");

    const files = readdirSync(join(dataDir, "memory")).filter((n) => n.endsWith(".md"));
    expect(files).toHaveLength(1);
    const saved = readFileSync(join(dataDir, "memory", files[0]!), "utf8");
    expect(saved).toContain("origin: agent");
    // 관찰 도구가 성공하지 않은 대화에서 나온 항목이라 "확인 안 됨"이 붙는다
    expect(saved).toContain("unverified: true");
    // 추출 호출은 세션에 남지 않으므로 usage.jsonl에 따로 적힌다
    expect(readFileSync(join(dataDir, "usage.jsonl"), "utf8")).toContain('"source":"memory"');

    const request = llm.requests.find((r) => isExtract(JSON.stringify(r.messages)));
    const sent = JSON.stringify(request?.messages);
    expect(sent).toContain("(tool-error) read");
    // 관찰 도구가 성공하지 않았으므로 확인 안 된 사실은 저장하지 말라는 규칙이 붙는다
    expect(sent).toContain("도구로 확인한 것이 하나도 없다");
  });

  it("뽑을 것이 없으면 아무것도 알리지 않는다", async () => {
    llm.setScript([{ text: "안녕하세요" }]);
    const from = pi.mark;
    const before = llm.requests.length;
    await pi.request({ type: "prompt", message: "안녕" });
    await pi.waitFor((r) => r.type === "agent_settled", from);
    // 추출 요청이 갈 때까지 기다린다
    for (let i = 0; i < 50 && llm.requests.length < before + 2; i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 300));
    expect(llm.requests.length).toBe(before + 2);
    expect(notices(from).filter((m) => m.includes("지식"))).toEqual([]);
  });

  it("기억 화면에서 끄면(settings.json autoLearn: false) 추출 요청을 보내지 않는다", async () => {
    const dir = join(dataDir, "memory");
    expect(await loadAutoLearn(dir)).toBe(true);
    await saveAutoLearn(dir, false);
    expect(await loadAutoLearn(dir)).toBe(false);
    llm.setScript([{ text: "네" }]);
    const from = pi.mark;
    const before = llm.requests.length;
    await pi.request({ type: "prompt", message: "고마워" });
    await pi.waitFor((r) => r.type === "agent_settled", from);
    await new Promise((r) => setTimeout(r, 800));
    expect(llm.requests.length).toBe(before + 1);
    await saveAutoLearn(dir, true);
  });
});
