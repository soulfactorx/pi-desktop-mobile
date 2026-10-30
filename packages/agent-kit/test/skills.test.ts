import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APPROVAL_MARKER, ApprovalChoice, parseApprovalTitle } from "../src/approval";
import { classify } from "../extensions/permissions/rules";
import { deleteSkill, formatSkill, listSkills, parseSkill, saveSkill, toSkillName, validSkillName } from "../extensions/skills/store";
import { startPi, type RpcPi, type RpcRecord } from "./helpers/rpc-pi";
import { startScriptLlm, type ScriptLlm } from "./helpers/script-llm";

describe("스킬 파일", () => {
  it("이름 규칙과 이름 만들기", () => {
    expect(validSkillName("weekly-report")).toBe(true);
    expect(validSkillName("Weekly")).toBe(false);
    expect(validSkillName("a--b")).toBe(false);
    expect(validSkillName("-a")).toBe(false);
    expect(validSkillName("a".repeat(65))).toBe(false);
    expect(toSkillName("PDF Tools!")).toBe("pdf-tools");
    expect(toSkillName("주간 보고")).toBe("");
  });

  it("SKILL.md를 왕복한다 (설명의 콜론·따옴표, 모델 자동 사용 끄기)", () => {
    const input = { name: "weekly-report", description: '주간 보고서를 만든다: "지난주" 커밋 요약에 쓴다', instructions: "1. git log를 본다\n2. 정리한다", modelInvocation: false };
    const text = formatSkill(input);
    expect(text).toContain("disable-model-invocation: true");
    expect(parseSkill(text)).toEqual(input);
    expect(parseSkill("---\nname: x\n---\n설명 없음")).toBeUndefined();
    expect(parseSkill("---\nname: x\ndescription: 쉬운 설명\n---\n본문")).toMatchObject({ description: "쉬운 설명", modelInvocation: true });
  });

  it("앱 홈의 스킬 폴더를 읽고, 만들기·같은 이름 거절·이름 바꾸기·지우기(휴지통)", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "skills-agent-"));
    const env = { PI_DESKTOP_AGENT_HOME: agentDir };
    const userDir = join(agentDir, "skills");
    mkdirSync(join(userDir, "not-a-skill"), { recursive: true });

    await saveSkill(userDir, { name: "alpha", description: "알파", instructions: "하라", modelInvocation: true });
    mkdirSync(join(userDir, "alpha", "scripts"));
    await expect(saveSkill(userDir, { name: "alpha", description: "x", instructions: "y", modelInvocation: true })).rejects.toThrow(/같은 이름/);
    await expect(saveSkill(userDir, { name: "Bad Name", description: "x", instructions: "y", modelInvocation: true })).rejects.toThrow(/소문자/);
    await expect(saveSkill(userDir, { name: "beta", description: " ", instructions: "y", modelInvocation: true })).rejects.toThrow(/설명/);

    let list = await listSkills(env);
    expect(list.map((s) => s.name)).toEqual(["alpha"]);
    expect(list[0]!.extraFiles).toEqual(["scripts"]);

    await saveSkill(userDir, { name: "alpha-two", description: "알파 고침", instructions: "하라", modelInvocation: false }, "alpha");
    list = await listSkills(env);
    expect(list[0]).toMatchObject({ name: "alpha-two", description: "알파 고침", modelInvocation: false, extraFiles: ["scripts"] });
    expect(existsSync(join(userDir, "alpha"))).toBe(false);

    const trash = join(agentDir, "trash");
    await deleteSkill(userDir, "alpha-two", trash);
    expect(existsSync(join(userDir, "alpha-two"))).toBe(false);
    expect(readdirSync(trash)[0]).toMatch(/^alpha-two-/);
  });

  it("skill_save는 사용자 스킬 폴더에 쓰는 일로 묻는다", () => {
    const { request } = classify("skill_save", { name: "weekly-report" });
    expect(request).toMatchObject({ risk: "write", summary: "스킬 저장" });
    expect(request!.target).toMatch(/skills\/weekly-report\/SKILL\.md$/);
    expect(request!.pattern).toMatch(/skills\/\*\*$/);
  });
});

describe("스킬 (실제 Pi)", () => {
  let llm: ScriptLlm;
  let pi: RpcPi;
  let agentHome: string;

  beforeAll(async () => {
    llm = await startScriptLlm("mock-model");
    ({ pi, agentHome } = await startPi(llm.baseUrl));
  });

  afterAll(async () => {
    pi?.close();
    await llm?.close();
  });

  it("skill_save는 승인을 받고 <앱 홈>/skills/<이름>/SKILL.md로 저장하고, 같은 이름은 replace 없이는 거절한다", async () => {
    llm.setScript([
      { tool: "skill_save", args: { name: "weekly-report", description: "주간 보고서를 만든다. 금요일 보고에 쓴다", instructions: "1. 커밋을 본다\n2. 세 줄로" } },
      { tool: "skill_save", args: { name: "weekly-report", description: "다시", instructions: "다시" } },
      { text: "저장했어" },
    ]);
    const from = pi.mark;
    await pi.request({ type: "prompt", message: "이걸 스킬로 만들어" });
    const isApproval = (r: RpcRecord) => r.type === "extension_ui_request" && r.method === "select" && String(r.title).startsWith(APPROVAL_MARKER);
    const approval = await pi.waitFor(isApproval, from);
    expect(parseApprovalTitle(String(approval.title))).toMatchObject({ toolName: "skill_save", summary: "스킬 저장" });
    pi.write({ type: "extension_ui_response", id: approval.id, value: ApprovalChoice.once });
    // 두 번째 호출도 승인을 묻는다 (거부하지 않고 허용해도 replace가 없으니 도구가 거절한다)
    const second = await pi.waitFor((r) => isApproval(r) && r.id !== approval.id, from);
    pi.write({ type: "extension_ui_response", id: second.id, value: ApprovalChoice.once });
    await pi.waitFor((r) => r.type === "agent_settled", from);

    const file = join(agentHome, "skills", "weekly-report", "SKILL.md");
    expect(parseSkill(readFileSync(file, "utf8"))).toMatchObject({ name: "weekly-report", description: "주간 보고서를 만든다. 금요일 보고에 쓴다", modelInvocation: true });
    const ends = pi.records.slice(from).filter((r) => r.type === "tool_execution_end");
    expect(JSON.stringify(ends[1]?.result)).toContain("replace: true");
  });
});
