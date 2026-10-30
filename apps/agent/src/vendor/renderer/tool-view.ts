/**
 * 툴 카드 표시 규칙 (설계 §4.1 툴 호출 카드). 화면과 분리한 순수 함수.
 *
 * Pi 내장 툴의 인자·결과 형식(1.3.0 기준):
 * - edit: args `{ path, edits: [{ oldText, newText }] }`, details `{ diff, patch, firstChangedLine }`
 * - write: args `{ path, content }`, 결과는 성공 문구뿐
 * - bash·powershell: args `{ command, timeout? }`, 결과 텍스트 끝에 "Command exited with code N",
 *   실시간 이벤트에는 `structuredContent.exit_code`도 있다
 * - read: args `{ path, offset?, limit? }`
 * - grep·find·ls: 결과는 한 줄에 하나씩
 * 형식이 달라도(Pi 업데이트, 확장 툴) 깨지지 않게, 모르는 모양이면 일반 카드로 돌아간다.
 */

export type ToolKind = "edit" | "write" | "shell" | "read" | "search" | "generic";

export function toolKind(toolName: string): ToolKind {
  switch (toolName) {
    case "edit":
      return "edit";
    case "write":
      return "write";
    case "bash":
    case "powershell":
      return "shell";
    case "read":
      return "read";
    case "grep":
    case "find":
    case "ls":
      return "search";
    default:
      return "generic";
  }
}

export interface DiffLine {
  kind: "hunk" | "add" | "del" | "ctx";
  text: string;
  /** 바뀌기 전 파일의 줄 번호 (del·ctx) */
  oldNo?: number;
  /** 바뀐 뒤 파일의 줄 번호 (add·ctx) */
  newNo?: number;
}

/** 표준 unified patch를 줄 단위로 푼다. 파일 머리글(---, +++)은 뺀다. */
export function parsePatch(patch: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.replace(/\r\n/g, "\n").split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      lines.push({ kind: "hunk", text: raw });
    } else if (raw.startsWith("---") || raw.startsWith("+++")) {
      continue;
    } else if (raw.startsWith("+")) {
      lines.push({ kind: "add", text: raw.slice(1), newNo: newNo++ });
    } else if (raw.startsWith("-")) {
      lines.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++ });
    } else if (raw.startsWith(" ")) {
      lines.push({ kind: "ctx", text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
    } else if (raw.startsWith("\\")) {
      // "\ No newline at end of file"
      continue;
    }
  }
  return lines;
}

/**
 * patch가 아직 없을 때(실행 중, 실패) edit 인자로 바꾸려는 내용을 보여준다.
 * 줄 번호는 모르므로 붙이지 않는다.
 */
export function editPreview(args: unknown): DiffLine[] {
  const edits = (args as { edits?: unknown } | undefined)?.edits;
  if (!Array.isArray(edits)) return [];
  const lines: DiffLine[] = [];
  edits.forEach((edit, i) => {
    const { oldText, newText } = (edit ?? {}) as { oldText?: unknown; newText?: unknown };
    if (typeof oldText !== "string" || typeof newText !== "string") return;
    if (edits.length > 1) lines.push({ kind: "hunk", text: `변경 ${i + 1}/${edits.length}` });
    for (const text of splitLines(oldText)) lines.push({ kind: "del", text });
    for (const text of splitLines(newText)) lines.push({ kind: "add", text });
  });
  return lines;
}

/** write 내용을 모두 추가된 줄로 보여준다. */
export function writePreview(args: unknown): DiffLine[] {
  const content = (args as { content?: unknown } | undefined)?.content;
  if (typeof content !== "string") return [];
  return splitLines(content).map((text, i) => ({ kind: "add", text, newNo: i + 1 }));
}

/** edit 카드에 보여줄 줄: 결과 patch가 있으면 그것을, 없으면 인자로 만든 미리보기를 쓴다. */
export function editLines(args: unknown, details: unknown): DiffLine[] {
  const patch = (details as { patch?: unknown } | undefined)?.patch;
  return typeof patch === "string" && patch ? parsePatch(patch) : editPreview(args);
}

export function diffStats(lines: readonly DiffLine[]): { added: number; removed: number } {
  return {
    added: lines.filter((l) => l.kind === "add").length,
    removed: lines.filter((l) => l.kind === "del").length,
  };
}

function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  // 끝 줄바꿈 뒤의 빈 줄은 줄로 치지 않는다.
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

const EXIT_TRAILER = /\n*Command exited with code (\d+)\s*$/;

/** 셸 툴의 종료 코드. 실시간 이벤트의 값이 없으면(스냅샷 복구) 결과 텍스트 끝에서 읽는다. */
export function shellExitCode(exitCode: number | undefined, output: string): number | undefined {
  if (exitCode !== undefined) return exitCode;
  const match = EXIT_TRAILER.exec(output);
  return match ? Number(match[1]) : undefined;
}

/** 셸 툴 결과 끝의 "Command exited with code N" 안내는 카드 머리에 따로 보여주므로 뺀다. */
export function shellOutput(output: string): string {
  return output.replace(EXIT_TRAILER, "\n").replace(/\n+$/, "\n");
}

/** 카드 머리에 툴 이름 옆에 보여줄 대상 (경로, 패턴 등) */
export function toolTarget(toolName: string, args: unknown): string {
  const a = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  switch (toolKind(toolName)) {
    case "read": {
      const path = str(a.path) ?? "";
      const offset = typeof a.offset === "number" ? a.offset : undefined;
      const limit = typeof a.limit === "number" ? a.limit : undefined;
      if (offset === undefined && limit === undefined) return path;
      const from = offset ?? 1;
      return limit === undefined ? `${path} (${from}줄부터)` : `${path} (${from}–${from + limit - 1}줄)`;
    }
    case "search": {
      const pattern = str(a.pattern);
      const where = str(a.path);
      if (toolName === "ls") return where ?? ".";
      return [pattern, where && `in ${where}`, str(a.glob) && `(${String(a.glob)})`].filter(Boolean).join(" ");
    }
    case "shell":
      return str(a.command) ?? "";
    case "edit":
    case "write":
      return str(a.path) ?? "";
    default: {
      const main = a.command ?? a.path ?? a.pattern ?? Object.values(a)[0];
      return typeof main === "string" ? main : main === undefined ? "" : JSON.stringify(main);
    }
  }
}

/**
 * read·grep·find·ls 결과 줄 수 (빈 결과면 0).
 * Pi가 끝에 붙이는 안내(예: "[1 more lines in file. Use offset=4 to continue.]")는 세지 않는다.
 */
export function resultLineCount(output: string): number {
  const trimmed = output.replace(/(\n\s*\[[^\n]*\]\s*)+$/, "").trim();
  return trimmed ? trimmed.split("\n").length : 0;
}
