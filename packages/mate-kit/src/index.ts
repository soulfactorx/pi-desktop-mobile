import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export * from "./shared";
export { checkCommand, isGrant, isGrantableName, splitCommand, type CommandVerdict } from "./guard";
export { appendBlocked, readBlocked } from "./blocked";
export { writeScopeError } from "./write-scope";
export { appendProposal, installError, makeProposal, proposalHash, readInbox, type ProposalInput } from "./proposal";

/**
 * mate-kit 폴더의 package.json에서 확장 진입 파일(`pi.extensions`)을 절대 경로로 읽는다.
 * 실행기는 이 경로마다 `-e`를 붙여 Pi를 띄운다. 사용자 settings.json에는 기록하지 않는다.
 */
export async function extensionEntries(kitDir: string): Promise<string[]> {
  const manifest = JSON.parse(await readFile(join(kitDir, "package.json"), "utf8")) as { pi?: { extensions?: unknown } };
  const entries = manifest.pi?.extensions;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`mate-kit의 package.json에 pi.extensions가 없습니다: ${kitDir}`);
  }
  return entries.map((entry) => {
    if (typeof entry !== "string" || isAbsolute(entry)) throw new Error(`잘못된 확장 경로입니다: ${String(entry)}`);
    return resolve(kitDir, entry);
  });
}
export { appendChat, appendChatAction, appendChatQuestion, readChat, readChatActions } from "./chat";
