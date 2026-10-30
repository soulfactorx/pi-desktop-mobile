/**
 * 첨부 파일을 메시지에 싣는 방식 (설계 DESIGN-AGENT.md §4 "첨부").
 *
 * 문서는 내용을 메시지에 붙이지 않고 경로만 적는다. Pi 방식대로 모델이 read(텍스트)나
 * process_document(큰 문서·docx·pdf)로 필요한 만큼 읽는다. 큰 첨부가 창을 통째로 차지하지 않는다.
 * 이미지는 모델이 볼 수 있을 때 메시지와 함께 보낸다 (Pi RPC prompt의 images). 볼 수 없는 모델이면 경로로 둔다.
 */
export function attachmentLines(paths: string[]): string {
  return paths.map((path) => `[첨부] ${path}`).join("\n");
}

/** 입력 중인 글 뒤에 첨부 줄을 붙인다 */
export function withAttachments(draft: string, paths: string[]): string {
  if (paths.length === 0) return draft;
  const lines = attachmentLines(paths);
  return draft.trim() ? `${draft.replace(/\s+$/, "")}\n${lines}` : `${lines}\n`;
}

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** 메시지와 함께 보낼 수 있는 이미지면 그 형식 (png·jpeg·gif·webp) */
export function imageMimeType(path: string): string | undefined {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
  return ext ? IMAGE_TYPES[ext] : undefined;
}

/** 이미지와 그 밖의 파일로 나눈다 */
export function splitAttachments(paths: string[]): { images: string[]; files: string[] } {
  const images = paths.filter((p) => imageMimeType(p));
  return { images, files: paths.filter((p) => !imageMimeType(p)) };
}

/** 프로바이더가 받는 이미지 하나의 크기 상한 (Anthropic 5MB 기준) */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** 모델이 이미지를 받는가. 모델 정보에 입력 종류가 없으면 받는다고 보고 Pi·프로바이더의 오류에 맡긴다 */
export function acceptsImages(input: string[] | undefined): boolean {
  return !input || input.includes("image");
}
