import { spawn } from "node:child_process";
import { looksSecret } from "../memory/extract";
import type { CardDraft, CardSkill } from "./types";
import { NO_SHARE_TAG, TYPE_LABEL, type MemoryType } from "../memory/types";

/**
 * 에이전트 카드 초안 만들기 (desktop-agent DESIGN-AGENT-NETWORK.md §2.2 "자동 생성").
 *
 * 지식베이스 항목의 제목·태그와 대화 이름을 재료로 Pi를 한 번 불러(--print, 도구·확장 없음) 소개와 잘하는 것을 뽑는다.
 * 카드는 다른 사람에게 공개되므로 바로 저장하지 않고 초안으로만 돌려준다. 사람이 확인하고 고쳐서 저장한다.
 * 사용자(user) 항목과 "공유제외" 태그 항목, 항목 본문은 재료로 쓰지 않는다.
 */

export interface CardMaterial {
  /** 지식베이스 항목의 종류·제목·태그 (본문은 쓰지 않는다) */
  memories: Array<{ type: MemoryType; title: string; tags: string[] }>;
  /** 사용자가 붙인 대화 이름들 (내용은 쓰지 않는다) */
  sessionNames: string[];
  current: CardDraft;
}

/** 명령줄에 싣는 짧은 지시. 재료는 stdin으로 준다 */
export const CARD_INSTRUCTION = `입력은 이 에이전트의 지식베이스 항목 제목과 대화 주제 목록이다. 이것을 보고 다른 사람에게 공개할 "에이전트 카드"의 소개와 잘하는 것을 한국어로 써라.
- description: 이 에이전트가 무엇을 잘 아는지 한 문장 (60자 이내)
- skills: 3~6개. name은 20자 이내, description은 60자 이내
- 공개되는 글이다. 사람 이름, 회사·고객·프로젝트의 내부 이름, 주소·경로·계정·비밀번호·토큰은 쓰지 마라. 기술·분야 수준으로 일반화하라
- 재료에 근거가 없는 능력은 지어내지 마라. 재료가 적으면 적게 써라
- 아래 JSON만 출력하라. 설명·코드 펜스 금지
{"description":"...","skills":[{"name":"...","description":"..."}]}`;

const MATERIAL_CHARS = 6000;

/** stdin으로 줄 재료. 너무 길면 뒤를 자른다 */
export function cardMaterial(material: CardMaterial): string {
  const memories = material.memories
    .filter((m) => m.type !== "user" && !m.tags.includes(NO_SHARE_TAG) && !looksSecret(m.title))
    .map((m) => `- [${TYPE_LABEL[m.type]}] ${m.title}${m.tags.length ? ` (${m.tags.join(", ")})` : ""}`);
  const names = [...new Set(material.sessionNames.map((n) => n.trim()).filter(Boolean))].map((n) => `- ${n}`);
  const text = [
    `## 지금 카드\n이름: ${material.current.name}\n소개: ${material.current.description}\n잘하는 것: ${material.current.skills.map((s) => s.name).join(", ") || "(없음)"}`,
    `## 지식베이스 (요구사항·교훈·참조)\n${memories.join("\n") || "(없음)"}`,
    `## 대화 주제\n${names.join("\n") || "(없음)"}`,
  ].join("\n\n");
  return text.length > MATERIAL_CHARS ? `${text.slice(0, MATERIAL_CHARS)}\n…(잘림)` : text;
}

const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);

/** 모델 출력에서 초안을 꺼낸다. 사고 블록·코드 펜스를 걷어 내고, 민감해 보이는 항목은 버린다 */
export function parseCardSuggestion(raw: string): Pick<CardDraft, "description" | "skills"> {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fence) text = fence[1]!.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("모델이 초안을 JSON으로 주지 않았다");
  const parsed = JSON.parse(text.slice(start, end + 1)) as { description?: unknown; skills?: unknown };
  const description = typeof parsed.description === "string" && !looksSecret(parsed.description) ? clip(parsed.description.trim(), 120) : "";
  const skills: CardSkill[] = (Array.isArray(parsed.skills) ? parsed.skills : [])
    .map((s: { name?: unknown; description?: unknown }) => ({ name: typeof s?.name === "string" ? s.name.trim() : "", description: typeof s?.description === "string" ? s.description.trim() : "" }))
    .filter((s) => s.name && !looksSecret(`${s.name} ${s.description}`))
    .slice(0, 6)
    .map((s, i) => ({ id: `skill-${i + 1}`, name: clip(s.name, 40), description: clip(s.description, 120) }));
  if (!description && skills.length === 0) throw new Error("초안이 비어 있다");
  return { description, skills };
}

export interface PiPrintCommand {
  command: string;
  /** cli.js 등 앞쪽 인자 */
  args: string[];
  env?: NodeJS.ProcessEnv;
}

/** Pi를 한 번 불러(도구·확장·스킬·컨텍스트 파일 없음) 초안을 만든다 */
export function generateCardDraft(pi: PiPrintCommand, material: CardMaterial, cwd: string, timeoutMs = 120_000): Promise<Pick<CardDraft, "description" | "skills">> {
  const args = [...pi.args, "--print", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files", CARD_INSTRUCTION];
  return new Promise((resolve, reject) => {
    const child = spawn(pi.command, args, { cwd, env: pi.env ?? process.env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("초안을 만드는 데 너무 오래 걸렸다"));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-2000)));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`Pi가 실패했다 (code ${code})${stderr.trim() ? `: ${stderr.trim().split("\n").slice(-2).join(" ")}` : ""}`));
      try {
        resolve(parseCardSuggestion(stdout));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(cardMaterial(material));
  });
}
