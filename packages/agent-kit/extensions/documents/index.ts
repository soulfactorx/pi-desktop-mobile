import { readFile, writeFile } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { chunkChars, defaultOutputPath, inferMode, splitIntoChunks, type DocumentMode } from "./chunks";
import { docxText } from "./docx";
import { pdfText } from "./pdf";
import { recordUsage } from "../../src/usage";
import { dataDir } from "../permissions/store";

/**
 * 큰 문서 처리 (설계 DESIGN-AGENT.md §4 "큰 입력 처리", "docx 첨부 변환").
 *
 * 창보다 큰 문서를 조각으로 나눠 조각마다 모델을 부른다. desktop-agent의 process_document와 같은 일을
 * Pi 방식으로 한다: 원문은 파일 그대로 두고, 결과도 파일로 남긴다.
 * - transform(번역·교정 등): 조각 결과를 이어 붙여 결과 파일로 쓴다 → permissions가 "쓰기"로 묻는다
 * - reduce(요약·질문 등): 조각마다 필요한 것만 뽑은 뒤 한 번 더 모아 답한다
 * .docx·.pdf는 본문 글을 뽑아 다룬다(pdf.ts). read 도구로 읽을 수 없으므로, 읽기만 할 때도 이 도구를 쓴다.
 */
export default function documents(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "process_document",
    label: "문서 처리",
    description:
      "창에 다 들어가지 않는 큰 문서(.txt·.md·.docx·.pdf 등)를 조각으로 나눠 지시대로 처리한다. " +
      "번역·교정처럼 문서 전체를 바꿔 내놓는 일은 mode=transform(결과를 파일로 쓴다), 요약·질문은 mode=reduce(답을 돌려준다). " +
      "docx·pdf는 read로 읽을 수 없으니 읽기만 할 때도 이 도구를 쓴다(스캔한 PDF는 글자가 없어 읽지 못한다). 큰 결과를 미리보기만 보고 답하지 말고 이 도구로 전체를 처리하라.",
    promptSnippet: "process_document: 큰 문서·docx·pdf를 조각으로 나눠 번역·요약 등을 처리한다",
    parameters: Type.Object({
      path: Type.String({ description: "처리할 문서 경로 (작업 폴더 기준 또는 절대 경로)" }),
      instruction: Type.String({ description: "문서에 할 일 (예: 영어로 번역, 핵심만 다섯 줄로 요약)" }),
      mode: Type.Optional(StringEnum(["transform", "reduce"], { description: "transform·reduce. 없으면 지시로 짐작" })),
      output: Type.Optional(Type.String({ description: "transform 결과를 쓸 경로. 없으면 원본 옆 <이름>.result.md" })),
    }),
    // 조각마다 모델을 부르므로 다른 도구와 동시에 돌리지 않는다
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const source = absolute(ctx.cwd, params.path);
      const text = await loadDocumentText(source);
      if (!text.trim()) throw new Error(`문서에 글이 없다: ${params.path}`);
      const mode: DocumentMode = (params.mode as DocumentMode | undefined) ?? inferMode(params.instruction);
      const chunks = splitIntoChunks(text, chunkChars(ctx.model?.contextWindow ?? 32_000));
      const progress = (done: number) =>
        onUpdate?.({ content: [{ type: "text", text: `문서 처리 중 ${done}/${chunks.length}` }], details: { done, total: chunks.length } });

      const results: string[] = [];
      for (const [i, chunk] of chunks.entries()) {
        if (signal?.aborted) throw new Error("중단했다");
        progress(i);
        results.push(await ask(ctx, signal, mode === "transform" ? TRANSFORM_SYSTEM : REDUCE_SYSTEM, `지시: ${params.instruction}\n\n[부분 ${i + 1}/${chunks.length}]\n${chunk}`));
      }
      progress(chunks.length);

      if (mode === "transform") {
        const output = absolute(ctx.cwd, params.output ?? defaultOutputPath(params.path));
        await writeFile(output, `${results.join("\n\n")}\n`, "utf8");
        return {
          content: [{ type: "text", text: `${chunks.length}개 조각을 처리해 ${output} 에 썼다. 내용을 확인하려면 read로 필요한 부분만 읽어라.` }],
          details: { mode, chunks: chunks.length, output },
        };
      }
      const answer =
        results.length === 1
          ? results[0]!
          : await ask(ctx, signal, COMBINE_SYSTEM, `지시: ${params.instruction}\n\n${results.map((r, i) => `[부분 ${i + 1}에서 뽑은 것]\n${r}`).join("\n\n")}`);
      return { content: [{ type: "text", text: answer }], details: { mode, chunks: chunks.length } };
    },
  });
}

const TRANSFORM_SYSTEM = "너는 긴 문서의 한 부분을 지시대로 바꾼다. 바꾼 본문만 출력하라. 설명·머리말·맺음말을 붙이지 말고, 빠뜨리는 문장 없이 처리하라.";
const REDUCE_SYSTEM = "너는 긴 문서의 한 부분을 읽고, 지시에 답하는 데 필요한 내용만 간결하게 뽑아 적는다. 관련 내용이 없으면 '관련 없음'이라고만 적어라.";
const COMBINE_SYSTEM = "문서를 부분별로 읽고 뽑아 둔 내용이다. 이것을 모아 지시에 답하라. '관련 없음'인 부분은 무시하라.";

function absolute(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

export async function loadDocumentText(path: string): Promise<string> {
  const buffer = await readFile(path);
  const ext = extname(path).toLowerCase();
  if (ext === ".docx") return docxText(buffer);
  if (ext === ".pdf" || buffer.subarray(0, 5).toString("latin1") === "%PDF-") return pdfText(buffer);
  if (buffer.subarray(0, 8192).includes(0)) throw new Error(`글이 아닌 파일이라 처리하지 않았다: ${path} (.docx·.pdf·텍스트만 지원)`);
  return buffer.toString("utf8");
}

/** 지금 세션의 모델로 한 번 묻는다. Pi의 모델 등록부가 인증을 붙인다 */
async function ask(ctx: ExtensionToolContext, signal: AbortSignal | undefined, systemPrompt: string, prompt: string): Promise<string> {
  const model = ctx.model;
  if (!model) throw new Error("모델이 정해지지 않아 문서를 처리할 수 없다");
  const reply = await ctx.modelRegistry.complete(
    model,
    { systemPrompt, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
    signal ? { signal } : undefined,
  );
  // 조각 처리 호출은 세션에 남지 않으므로 사용량을 따로 적는다
  await recordUsage(dataDir(), "document", model, reply.usage);
  if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage ?? "모델 호출이 실패했다");
  return reply.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();
}
