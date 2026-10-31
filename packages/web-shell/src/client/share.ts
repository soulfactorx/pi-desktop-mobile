/**
 * 다른 앱에서 "공유"한 이미지 받기 (Web Share Target). 휴대폰에 설치한 웹앱(홈 화면에 추가)은 공유 목록에 나타나고,
 * 갤럭시 스크린샷 도구의 공유 등으로 보낸 이미지를 서비스 워커가 캐시(ws-share)에 두고 /?ws-share= 로 화면을 연다.
 * 화면은 그 이미지를 꺼내 window.piSharedImages에 두고 SHARED_IMAGES_EVENT를 보낸다. 입력창(Desktop·Agent·Mate)이 가져가 붙인다.
 * (휴대폰 브라우저는 키보드가 넣는 이미지를 웹 페이지에 주지 않아, 스크린샷을 바로 붙이는 길로 쓴다)
 */

import { showPageNote } from "./notify";

export const SHARED_IMAGES_EVENT = "pi-shared-images";
const SHARE_PARAM = "ws-share";
const SHARE_CACHE = "ws-share";

declare global {
  interface Window {
    /** 공유받아 아직 입력창이 가져가지 않은 이미지 */
    piSharedImages?: File[];
  }
}

/**
 * 공유받은 이미지를 꺼내 화면에 넘긴다. 서비스 워커가 맡긴 캐시를 보므로 주소(?ws-share=)가 없어도 된다
 * (휴대폰이 화면을 새로 읽는 사이 주소가 바뀌어도). 뜰 때와 다시 보일 때 부른다.
 * @returns 받은 이미지 수
 */
export async function receiveSharedImages(): Promise<number> {
  let shared = false;
  try {
    const url = new URL(location.href);
    if (url.searchParams.has(SHARE_PARAM)) {
      shared = true;
      url.searchParams.delete(SHARE_PARAM);
      history.replaceState(history.state, "", url.pathname + url.search + url.hash);
    }
  } catch {
    // 주소를 읽을 수 없으면 캐시만 본다
  }
  const files = "caches" in window ? await takeSharedFiles() : [];
  if (files.length === 0) {
    if (shared) showPageNote("공유한 이미지를 받지 못했습니다. 잠시 뒤 다시 공유해 보세요");
    return 0;
  }
  showPageNote(`공유한 이미지 ${files.length}장을 받았습니다. 입력창에 붙입니다`);
  window.piSharedImages = [...(window.piSharedImages ?? []), ...files];
  window.dispatchEvent(new Event(SHARED_IMAGES_EVENT));
  return files.length;
}

/** 공유받은 이미지를 뜰 때와 화면이 다시 보일 때 꺼낸다 */
export function watchSharedImages(): void {
  const run = () => void receiveSharedImages().catch((error: unknown) => console.warn("공유한 이미지를 읽지 못했습니다", error));
  run();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") run();
  });
}

async function takeSharedFiles(): Promise<File[]> {
  const cache = await caches.open(SHARE_CACHE);
  const files: File[] = [];
  for (const request of await cache.keys()) {
    const response = await cache.match(request);
    await cache.delete(request);
    if (!response) continue;
    const blob = await response.blob();
    const name = decodeURIComponent(response.headers.get("X-File-Name") ?? "") || `공유한 이미지.${(blob.type.split("/")[1] ?? "png").replace("jpeg", "jpg")}`;
    files.push(new File([blob], name, { type: blob.type }));
  }
  return files;
}
