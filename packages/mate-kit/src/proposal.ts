import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { InboxItem, InstallProposal, Severity } from "./shared";

export interface ProposalInput {
  title: string;
  summary: string;
  detail?: string;
  severity?: Severity;
  /** 관찰자 실행이 붙이는 주제 */
  topic?: string;
  /** "Mate에게 맡기기"로 실행할 지시와 폴더 */
  followUp?: { prompt: string; cwd: string };
  install?: InstallProposal;
}

/** 모델이 넘긴 설치 제안을 검사한다. 잘못되면 이유를 돌려준다 (목록·충돌 검사는 적용할 때 실행기가 한다) */
export function installError(install: InstallProposal): string | undefined {
  const skillName = (name: string) => name.length <= 64 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name);
  switch (install.kind) {
    case "skill":
      if (!skillName(install.name)) return "스킬 이름은 영어 소문자·숫자·하이픈만 쓴다 (예: hn-summary)";
      if (!/^---\r?\n[\s\S]*?\bdescription:\s*\S[\s\S]*?\r?\n---/.test(install.content)) return "content는 frontmatter(name·description)가 있는 SKILL.md 전체여야 한다";
      if (install.content.length > 20_000) return "스킬이 너무 길다 (20,000자까지)";
      return undefined;
    case "mcp":
      return /^[a-z0-9-]{1,40}$/.test(install.preset) ? undefined : "preset은 정해 둔 MCP 서버 목록의 id다";
    case "copy":
      if (install.from !== "pi-desktop" && install.from !== "agent") return "from은 pi-desktop 또는 agent다";
      return skillName(install.name) ? undefined : "복사할 스킬 이름이 올바르지 않다";
    case "prompt":
      if (!skillName(install.name)) return "프롬프트 이름은 영어 소문자·숫자·하이픈만 쓴다 (예: weekly-report)";
      if (!install.content.trim()) return "content가 비어 있다";
      if (install.content.length > 20_000) return "프롬프트가 너무 길다 (20,000자까지)";
      return undefined;
    case "package": {
      const source = install.source.trim();
      const ok =
        !source.includes("..") &&
        /^(npm:(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.^~<>=*-]+)?|git:[a-z0-9][\w.-]*\/[\w./-]+(@[\w./-]+)?|https:\/\/[a-z0-9][\w.-]*\/[\w./-]+(@[\w./-]+)?)$/i.test(source);
      return ok ? undefined : "source는 npm:이름, git:주소, https 주소다";
    }
  }
}

/** 같은 임무에서 제목과 요약이 같으면 같은 제안으로 본다 (공백 차이는 무시) */
export function proposalHash(dutyId: string, title: string, summary: string): string {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ");
  return createHash("sha256").update(`${dutyId}\n${norm(title)}\n${norm(summary)}`).digest("hex").slice(0, 16);
}

export function makeProposal(input: ProposalInput, ids: { dutyId: string; runId: string }, now = Date.now()): InboxItem {
  return {
    id: randomUUID(),
    hash: proposalHash(ids.dutyId, input.title, input.summary),
    dutyId: ids.dutyId,
    runId: ids.runId,
    title: input.title.trim(),
    summary: input.summary.trim(),
    ...(input.detail?.trim() ? { detail: input.detail.trim() } : {}),
    severity: input.severity ?? "info",
    ...(input.topic ? { topic: input.topic } : {}),
    ...(input.followUp?.prompt.trim() ? { followUp: { prompt: input.followUp.prompt.trim(), cwd: input.followUp.cwd } } : {}),
    ...(input.install ? { install: input.install } : {}),
    createdAt: now,
  };
}

/** inbox.jsonl을 읽는다. 깨진 줄(쓰는 도중 끊긴 줄 등)은 건너뛴다 */
export async function readInbox(path: string): Promise<InboxItem[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const items: InboxItem[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line) as InboxItem;
      if (item && typeof item.id === "string" && typeof item.hash === "string") items.push(item);
    } catch {
      // 건너뜀
    }
  }
  return items;
}

/**
 * 제안을 인박스에 더한다. 같은 해시가 이미 있으면(이미 알렸거나 사용자가 버린 제안) 더하지 않고 false.
 * 한 줄을 한 번의 append로 쓰므로 앱이 읽는 도중에도 줄이 섞이지 않는다.
 */
export async function appendProposal(path: string, item: InboxItem): Promise<boolean> {
  const existing = await readInbox(path);
  if (existing.some((e) => e.hash === item.hash)) return false;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(item)}\n`, "utf8");
  return true;
}
