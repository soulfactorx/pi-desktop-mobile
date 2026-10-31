/**
 * 다른 앱에서 "공유"한 이미지 받기 (Web Share Target). 휴대폰에 설치한 웹앱(홈 화면에 추가)은 공유 목록에 나타나고,
 * 갤럭시 스크린샷 도구의 공유 등으로 보낸 이미지를 서버가 잠깐 맡아 두고(server/share-inbox.ts) /?ws-share-id= 로 화면을 연다.
 * 화면은 그 이미지를 가져와 window.piSharedImages에 두고 SHARED_IMAGES_EVENT를 보낸다. 입력창(Desktop·Agent·Mate)이 가져가 붙인다.
 * (휴대폰 브라우저는 키보드가 넣는 이미지를 웹 페이지에 주지 않아, 스크린샷을 바로 붙이는 길로 쓴다)
 */

import { showPageNote } from "./notify";

export const SHARED_IMAGES_EVENT = "pi-shared-images";
const SHARE_PARAM = "ws-share-id";

declare global {
  interface Window {
    /** 공유받아 아직 입력창이 가져가지 않은 이미지 */
    piSharedImages?: File[];
  }
}

interface SharedBody {
  files: Array<{ name: string; type: string; data: string }>;
  fields: string[];
  error?: string;
}

/**
 * 주소에 ?ws-share-id= 가 있으면 서버가 맡아 둔 공유 이미지를 가져와 화면에 넘긴다.
 * @returns 받은 이미지 수
 */
export async function receiveSharedImages(): Promise<number> {
  let id: string | null = null;
  try {
    const url = new URL(location.href);
    id = url.searchParams.get(SHARE_PARAM);
    if (id) {
      url.searchParams.delete(SHARE_PARAM);
      history.replaceState(history.state, "", url.pathname + url.search + url.hash);
    }
  } catch {
    return 0;
  }
  if (!id) return 0;
  let body: SharedBody;
  try {
    const response = await fetch(`/ws-share/${encodeURIComponent(id)}`, { cache: "no-store" });
    body = (await response.json()) as SharedBody;
  } catch (error) {
    body = { files: [], fields: [], error: (error as Error).message };
  }
  const files = body.files.map(({ name, type, data }) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    return new File([bytes], name || `공유한 이미지.${(type.split("/")[1] ?? "png").replace("jpeg", "jpg")}`, { type });
  });
  if (files.length === 0) {
    // 받은 항목(이름:형식:크기)이나 오류를 함께 보여 원인을 찾게 한다
    const detail = body.error ? `오류: ${body.error}` : `받은 항목: ${body.fields.join(", ") || "없음"}`;
    showPageNote(`공유한 이미지를 받지 못했습니다 (${detail})`, 15_000);
    return 0;
  }
  showPageNote(`공유한 이미지 ${files.length}장을 받았습니다. 입력창에 붙입니다`);
  window.piSharedImages = [...(window.piSharedImages ?? []), ...files];
  window.dispatchEvent(new Event(SHARED_IMAGES_EVENT));
  return files.length;
}

/** 공유로 열렸으면 이미지를 가져온다 (화면을 띄울 때 한 번) */
export function watchSharedImages(): void {
  void receiveSharedImages().catch((error: unknown) => console.warn("공유한 이미지를 읽지 못했습니다", error));
}
