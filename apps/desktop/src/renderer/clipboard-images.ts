import { useEffect, useRef } from "react";

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

/** 다른 앱에서 "공유"해 받은 이미지가 왔다는 화면 이벤트 (휴대폰 웹앱의 공유 받기, web-shell client/share.ts) */
const SHARED_IMAGES_EVENT = "pi-shared-images";

declare global {
  interface Window {
    /** 공유받아 아직 입력창이 가져가지 않은 이미지 (웹앱에만 있다) */
    piSharedImages?: File[];
  }
}

/**
 * 공유받은 이미지(갤럭시 스크린샷 도구의 공유 등)를 이 입력창에 붙인다. 데스크톱 앱에서는 오지 않는다.
 * enabled가 거짓이면(대화가 없음 등) 남겨 두었다가 켜지면 가져간다. visible이 거짓이면(숨긴 탭) 다른 입력창에 맡긴다.
 */
export function useSharedImages(onFiles: (files: File[]) => void, enabled = true, visible: () => boolean = () => true): void {
  const latest = useRef({ onFiles, visible });
  latest.current = { onFiles, visible };
  useEffect(() => {
    if (!enabled) return;
    const take = () => {
      const files = window.piSharedImages;
      if (!files?.length || !latest.current.visible()) return;
      window.piSharedImages = [];
      latest.current.onFiles(files);
    };
    take();
    window.addEventListener(SHARED_IMAGES_EVENT, take);
    return () => window.removeEventListener(SHARED_IMAGES_EVENT, take);
  }, [enabled]);
}

/** 입력창에 붙여 둔 이미지를 잠깐 보관하는 곳 (IndexedDB). 휴대폰은 공유로 앱이 새로 열리면 붙여 둔 이미지를 잃어서 */
const DRAFT_DB = "pi-draft-images";
const DRAFT_STORE = "drafts";
/** 이보다 오래된 보관은 되살리지 않는다 */
const DRAFT_MAX_MS = 60 * 60_000;

function draftDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DRAFT_DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(DRAFT_STORE);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error("보관함을 열지 못했습니다"));
  });
}

async function draftRequest<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await draftDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(DRAFT_STORE, mode).objectStore(DRAFT_STORE));
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(request.error ?? new Error("보관함을 읽지 못했습니다"));
    });
  } finally {
    db.close();
  }
}

/**
 * 붙여 둔 이미지(data를 가진 항목)를 key별로 보관하고, 화면이 새로 열리면 되살린다.
 * 공유로 앱이 새로 열려도 앞서 붙인 이미지가 남아 여러 장을 차례로 붙일 수 있다. 보내서 비우면 보관도 지운다.
 * key가 없으면(대화가 없음 등) 아무것도 하지 않는다.
 */
export function useDraftImages<T extends { data: string }>(key: string | undefined, images: T[], setImages: (update: (prev: T[]) => T[]) => void): void {
  const loadedKey = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!key || typeof indexedDB === "undefined") return;
    let cancelled = false;
    loadedKey.current = undefined;
    void draftRequest<{ at: number; images: T[] } | undefined>("readonly", (store) => store.get(key))
      .then((saved) => {
        if (cancelled) return;
        if (saved && Date.now() - saved.at < DRAFT_MAX_MS && saved.images.length > 0) {
          // 되살린 것 앞에, 그 사이 붙은 것(공유받은 이미지 등)은 뒤에. 같은 이미지는 한 번만
          setImages((prev) => [...saved.images, ...prev.filter((p) => !saved.images.some((s) => s.data === p.data))]);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) loadedKey.current = key;
      });
    return () => {
      cancelled = true;
    };
  }, [key]);
  useEffect(() => {
    // 되살리기 전에 저장하면 보관한 것을 덮어쓴다
    if (!key || loadedKey.current !== key || typeof indexedDB === "undefined") return;
    void draftRequest("readwrite", (store) => (images.length > 0 ? store.put({ at: Date.now(), images }, key) : store.delete(key))).catch(() => undefined);
  }, [key, images]);
}

/** 휴대폰처럼 터치가 주 입력인 화면인지. 그런 화면은 Shift를 누르기 어려워 Enter를 줄바꿈으로 쓴다 */
export function touchTyping(): boolean {
  return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
}

/**
 * 입력창에서 이 키가 "보내기"인지. PC는 Enter(줄바꿈은 Shift+Enter), 휴대폰은 Enter가 줄바꿈이고 보내기 버튼으로 보낸다.
 * 어디서든 Ctrl·Cmd+Enter는 보낸다. 한글 조합 중인 Enter는 아니다.
 */
export function isSendKey(e: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; isComposing?: boolean }): boolean {
  if (e.key !== "Enter" || e.isComposing) return false;
  if (e.ctrlKey || e.metaKey) return true;
  return !e.shiftKey && !touchTyping();
}

/** 입력창 안내의 Enter 설명을 휴대폰에 맞게 바꾼다 */
export function enterHint(text: string): string {
  if (!touchTyping()) return text;
  return text.replace(/Enter (전송|보내기), Shift\+Enter 줄바꿈/, "Enter 줄바꿈, 보내기 버튼으로 전송");
}
