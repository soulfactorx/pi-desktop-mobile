import { rm } from "node:fs/promises";
import { appendChatQuestion, isMcpToolName, PERMISSION_OPTIONS, readBlocked } from "@pi-desktop/mate-kit";
import type { MatePaths } from "./paths";
import { CHAT_DUTY_ID, type Duty } from "./types";

/**
 * 실행 중에 허용 목록에 없어 막힌 명령이 있으면, 그 명령을 이 임무에 허용할지 대화로 묻는다 (설계 §4 "권한 요청").
 * 질문은 앱 대화 탭과 휴대폰에 선택지 버튼으로 뜬다. "허용하고 다시 실행"을 누르면 대화 담당이
 * 임무에 허용 명령을 더하고 다시 실행한다. 답하지 않은 같은 질문은 하루 안에 다시 묻지 않는다.
 */
export async function askPermission(paths: MatePaths, duty: Duty, runId: string, blockedPath: string, now: number, retry?: string): Promise<boolean> {
  const blocked = await readBlocked(blockedPath);
  await rm(blockedPath, { force: true });
  const granted = new Set(duty.grants ?? []);
  const examples = new Map<string, string>();
  for (const b of blocked) if (!granted.has(b.name) && !examples.has(b.name)) examples.set(b.name, b.command);
  const bash = [...examples.keys()].filter((name) => !isMcpToolName(name)).sort();
  // 질문이 길어지지 않게 MCP 도구는 한 번에 다섯 개까지 묻는다. 나머지는 다음 실행에서 다시 막히면 묻는다
  const mcp = [...examples.keys()].filter(isMcpToolName).sort().slice(0, MAX_MCP_PER_QUESTION);
  const commands = [...bash, ...mcp];
  if (commands.length === 0) return false;
  const lines = [`"${duty.name}"${duty.id === CHAT_DUTY_ID ? "가" : " 임무가"} 아직 허용하지 않은 것을 쓰려다 막혔어요.`];
  for (const name of bash) lines.push(`• ${name}: ${examples.get(name)!.split("\n")[0]!.slice(0, 160)}`);
  for (const name of mcp) {
    const { server, tool } = splitMcpToolName(name);
    const description = examples.get(name)!.trim();
    lines.push(`• MCP ${server} · ${tool}${description ? `: ${description.slice(0, 160)}` : ""}`);
  }
  const where = duty.id === CHAT_DUTY_ID ? "대화에서" : "이 임무에서";
  lines.push(`${where} ${commands.map((c) => (isMcpToolName(c) ? splitMcpToolName(c).tool : c)).join(", ")}을(를) 허용할까요?`);
  if (bash.length) lines.push("명령은 허용해도 파일 쓰기·데이터 보내기를 여전히 막아요.");
  if (mcp.length) lines.push("MCP 도구는 Mate가 읽기인지 쓰기인지 알 수 없으니 설명을 보고 정해 주세요. 허용한 도구만 다음부터 써요.");
  return appendChatQuestion(
    paths.chat,
    {
      text: lines.join("\n"),
      options: [...PERMISSION_OPTIONS],
      dutyId: duty.id,
      runId,
      cwd: duty.cwd,
      permission: { dutyId: duty.id, commands, ...(retry ? { retry } : {}) },
    },
    now,
  );
}

const MAX_MCP_PER_QUESTION = 5;

/** mcp__<서버>__<도구>를 나눈다 (서버 이름의 -는 Pi가 _로 바꾼 것이라 _로 보인다) */
export function splitMcpToolName(name: string): { server: string; tool: string } {
  const rest = name.slice("mcp__".length);
  const at = rest.indexOf("__");
  return at < 0 ? { server: rest, tool: "" } : { server: rest.slice(0, at), tool: rest.slice(at + 2) };
}
