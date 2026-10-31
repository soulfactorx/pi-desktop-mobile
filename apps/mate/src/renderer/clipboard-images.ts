/**
 * 클립보드·기기에서 이미지를 받는 도우미 (Desktop·Agent·Mate 입력창이 같은 내용을 쓴다).
 * - 붙여넣기(Ctrl+V·길게 눌러 붙여넣기): clipboardData.files, 없으면 items의 파일
 * - "클립보드 이미지" 버튼: navigator.clipboard.read() (휴대폰 브라우저처럼 붙여넣기 메뉴가 글만 받을 때)
 */

/** 붙여넣기·끌어 놓기로 받은 파일 (files가 비고 items에만 있는 브라우저도 있다) */
export function transferFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files = [...data.files];
  if (files.length > 0) return files;
  return [...data.items].filter((item) => item.kind === "file").flatMap((item) => item.getAsFile() ?? []);
}

/** 클립보드를 직접 읽을 수 있는지 (https·localhost·앱에서만) */
export function canReadClipboard(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.clipboard?.read === "function";
}

/** 클립보드의 이미지를 읽는다. 이미지가 없으면 빈 목록, 읽을 수 없으면 이유를 담은 오류 */
export async function readClipboardImages(): Promise<File[]> {
  let items: ClipboardItems;
  try {
    items = await navigator.clipboard.read();
  } catch (error) {
    const name = (error as DOMException | undefined)?.name;
    throw new Error(name === "NotAllowedError" ? "클립보드를 읽도록 허용해 주세요 (브라우저가 물으면 허용)" : `클립보드를 읽지 못했습니다: ${(error as Error).message}`);
  }
  const files: File[] = [];
  for (const item of items) {
    const type = item.types.find((t) => t.startsWith("image/"));
    if (!type) continue;
    const blob = await item.getType(type);
    files.push(new File([blob], `클립보드 이미지.${type.slice(6).replace("jpeg", "jpg")}`, { type }));
  }
  return files;
}

/** 파일을 base64로 읽는다 (data: 머리 없이) */
export function readBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("파일을 읽지 못했습니다"));
    reader.readAsDataURL(file);
  });
}
