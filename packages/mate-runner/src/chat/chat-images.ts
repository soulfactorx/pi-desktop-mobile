import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, isAbsolute } from "node:path";
import type { MatePaths } from "../paths";

/**
 * 대화에 붙인 이미지 (붙여넣기·고르기). 앱이 보낸 이미지를 Mate 홈의 chat/images에 두었다가
 * Pi에 `@파일`로 넘기고, 답한 뒤 지운다 (Pi 세션 기록에 이미지가 남으므로 앞의 말로 기억한다).
 */
export interface ChatImageInput {
  mimeType: string;
  /** base64 (data: 머리 없이) */
  data: string;
  name?: string;
}

export const MAX_CHAT_IMAGES = 4;
export const MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024;
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/** 받은 이미지를 검사해 파일로 둔다. 받을 수 없는 이미지면 오류 */
export async function saveChatImages(paths: MatePaths, images: unknown, now = Date.now()): Promise<string[]> {
  if (images === undefined || images === null) return [];
  if (!Array.isArray(images)) throw new Error("이미지 목록이 잘못되었습니다");
  if (images.length > MAX_CHAT_IMAGES) throw new Error(`이미지는 한 번에 ${MAX_CHAT_IMAGES}장까지 보낼 수 있습니다`);
  const files: Array<{ file: string; data: Buffer }> = [];
  for (const image of images as Array<Partial<ChatImageInput>>) {
    const ext = EXT[String(image?.mimeType ?? "")];
    if (!ext) throw new Error("PNG·JPEG·GIF·WebP 이미지만 보낼 수 있습니다");
    const data = Buffer.from(String(image?.data ?? ""), "base64");
    if (data.length === 0) throw new Error("이미지를 읽지 못했습니다");
    if (data.length > MAX_CHAT_IMAGE_BYTES) throw new Error(`이미지가 ${(data.length / 1024 / 1024).toFixed(1)}MB라 너무 큽니다 (5MB까지)`);
    files.push({ file: join(paths.chatImages, `${now}-${randomUUID().slice(0, 8)}.${ext}`), data });
  }
  if (files.length === 0) return [];
  await mkdir(paths.chatImages, { recursive: true });
  for (const { file, data } of files) await writeFile(file, data);
  return files.map((f) => f.file);
}

/** 요청 파일에 적힌 이미지 경로 중 Mate 홈의 chat/images 안의 것만 남긴다 */
export function chatImagesOf(paths: MatePaths, list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((p): p is string => typeof p === "string")
    .map((p) => resolve(p))
    .filter((p) => {
      const rel = relative(paths.chatImages, p);
      return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
    })
    .slice(0, MAX_CHAT_IMAGES);
}

export async function removeChatImages(files: string[] | undefined): Promise<void> {
  for (const file of files ?? []) await rm(file, { force: true }).catch(() => {});
}
