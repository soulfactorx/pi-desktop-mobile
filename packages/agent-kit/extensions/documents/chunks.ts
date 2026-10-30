/**
 * 문서 처리의 순수 로직: 조각 크기, 나누기, 처리 방식 짐작, 결과 파일 경로.
 */

export type DocumentMode = "transform" | "reduce";

/**
 * 조각 하나의 글자 수. 창의 30%를 조각에 쓰고(토큰당 2글자로 보수적으로 어림 — 한국어는 글자당 토큰이 많다),
 * 나머지는 지시·출력 자리로 남긴다.
 */
export function chunkChars(contextWindow: number): number {
  return Math.min(40_000, Math.max(1500, Math.floor(contextWindow * 0.3) * 2));
}

/** 문단 경계에서 나누고, 한 문단이 너무 길면 그 안에서 자른다 */
export function splitIntoChunks(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };
  for (const paragraph of text.split(/\n\s*\n/)) {
    if (paragraph.length > maxChars) {
      flush();
      for (let i = 0; i < paragraph.length; i += maxChars) chunks.push(paragraph.slice(i, i + maxChars));
      continue;
    }
    if (current.length + paragraph.length + 2 > maxChars) flush();
    current += (current ? "\n\n" : "") + paragraph;
  }
  flush();
  return chunks;
}

/** 지시만 보고 처리 방식을 짐작한다. 문서 전체를 바꿔 내놓는 일(번역·교정)이면 transform, 그 밖(요약·질문)은 reduce */
export function inferMode(instruction: string): DocumentMode {
  return /번역|translate|교정|다듬|고쳐|바꿔|변환|rewrite|proofread|convert|포맷|형식/i.test(instruction) ? "transform" : "reduce";
}

/** transform 결과를 쓸 기본 경로: 원본 옆에 `<이름>.result.md` */
export function defaultOutputPath(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dot = path.lastIndexOf(".");
  const base = dot > slash ? path.slice(0, dot) : path;
  return `${base}.result.md`;
}
