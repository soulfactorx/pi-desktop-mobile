/**
 * 스킬 화면이 쓰는 모양. 렌더러도 쓰므로 아무것도 import하지 않는다 (파일 읽기·쓰기는 store.ts).
 */

export interface SkillInput {
  /** 규격 이름: 소문자·숫자·하이픈 (/skill:이름 명령이 된다) */
  name: string;
  /** 무엇을 하고 언제 쓰는지. 모델이 이것을 보고 고른다 */
  description: string;
  /** SKILL.md 본문 (Markdown 지시) */
  instructions: string;
  /** false면 모델이 알아서 고르지 않고 /skill:이름으로만 쓴다 (disable-model-invocation) */
  modelInvocation: boolean;
}

export interface SkillView extends SkillInput {
  /** 폴더 이름 (보통 name과 같다) */
  folder: string;
  /** SKILL.md 경로 */
  path: string;
  /** SKILL.md 말고 함께 든 파일·폴더 (scripts/, references/ 등) */
  extraFiles: string[];
}
