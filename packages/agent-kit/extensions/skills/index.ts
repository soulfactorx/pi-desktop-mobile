import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isScheduler, isWorker } from "../../src/runtime";
import { saveSkill, toSkillName, userSkillsDir, validSkillName } from "./store";

/**
 * 스킬 저장 (설계 DESIGN-AGENT.md §4 "스킬"). 대화에서 다듬은 작업 방법을 Pi 스킬(SKILL.md)로 남겨 다음에도 같은 방식으로 하게 한다.
 * 앞으로의 동작을 바꾸는 파일이라 permissions가 "쓰기"로 묻는다. 워커·예약에는 주지 않는다.
 * 스킬을 보고 고치는 일은 앱의 스킬 화면에서 한다.
 */
export default function skills(pi: ExtensionAPI): void {
  if (isWorker() || isScheduler()) return;

  pi.registerTool({
    name: "skill_save",
    label: "스킬 저장",
    description:
      "되풀이할 작업 방법을 Pi 스킬로 저장한다. 사용자가 '이걸 스킬로 만들어', '다음에도 이렇게 해'라고 하거나, 대화에서 여러 번 다듬은 절차가 있을 때 쓴다. " +
      "name은 영어 소문자·숫자·하이픈(예: weekly-report), description은 무엇을 하고 언제 쓰는지 한두 문장(모델이 이것을 보고 고른다), " +
      "instructions는 다른 대화에서 이 스킬만 읽고도 따라 할 수 있는 구체적인 단계(Markdown). 이미 있는 스킬을 고치려면 replace: true.",
    promptSnippet: "skill_save: 되풀이할 작업 방법을 스킬로 저장한다",
    parameters: Type.Object({
      name: Type.String({ description: "스킬 이름 (영어 소문자·숫자·하이픈)" }),
      description: Type.String({ description: "무엇을 하고 언제 쓰는지" }),
      instructions: Type.String({ description: "따라 할 단계 (Markdown)" }),
      model_invocation: Type.Optional(Type.Boolean({ description: "모델이 알아서 고를지 (기본 true). false면 /skill:이름으로만" })),
      replace: Type.Optional(Type.Boolean({ description: "같은 이름의 스킬을 고칠 때 true" })),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const name = validSkillName(params.name) ? params.name : toSkillName(params.name);
      if (!validSkillName(name)) throw new Error("스킬 이름은 영어 소문자·숫자·하이픈으로 다시 정하라 (예: weekly-report)");
      const dir = userSkillsDir();
      const exists = existsSync(join(dir, name, "SKILL.md"));
      if (exists && !params.replace) throw new Error(`이미 ${name} 스킬이 있다. 고치려면 replace: true로 다시 불러라 (사용자에게 먼저 확인)`);
      const path = await saveSkill(
        dir,
        { name, description: params.description, instructions: params.instructions, modelInvocation: params.model_invocation !== false },
        exists ? name : undefined,
      );
      ctx.ui.notify(`스킬을 ${exists ? "고쳤습니다" : "저장했습니다"}: ${name} (새 대화부터 /skill:${name})`, "info");
      return {
        content: [{ type: "text", text: `${path}에 저장했다. 다음 대화부터 쓸 수 있고, 사용자는 /skill:${name}으로 부를 수 있다. 앱의 스킬 화면에서 고칠 수 있다.` }],
        details: { name, path },
      };
    },
  });
}
