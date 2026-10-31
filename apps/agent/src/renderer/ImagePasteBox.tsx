import { useEffect, useRef, type ClipboardEvent } from "react";
import { transferFiles } from "./clipboard-images";

/**
 * 휴대폰 키보드의 클립보드(삼성 키보드·Gboard)에 있는 스크린샷을 받는 붙여넣기 칸.
 * 키보드는 이미지를 받는 편집 칸(contenteditable)에만 이미지를 넣어 주고 글 입력창(textarea)에는 넣지 못해서,
 * 📋 버튼을 누르면 이 칸을 열어 키보드의 클립보드에서 이미지를 고르게 한다.
 * 브라우저는 키보드가 넣는 이미지를 붙여넣기(paste)로 주거나 칸 안에 <img>로 넣는다. 둘 다 받아 파일로 돌려주고 칸을 비운다.
 */
export function ImagePasteBox({ onFiles, onClose }: { onFiles: (files: File[]) => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    box.current?.focus();
  }, []);

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    const files = transferFiles(e.clipboardData).filter((f) => f.type.startsWith("image/"));
    if (files.length > 0) onFiles(files);
  };

  /** 붙여넣기 없이 칸에 들어온 이미지(<img>)를 파일로 바꾼다. 글은 지운다 */
  const onInput = async () => {
    const el = box.current;
    if (!el) return;
    const sources = [...el.querySelectorAll("img")].map((img) => img.src).filter(Boolean);
    el.replaceChildren();
    const files: File[] = [];
    for (const [i, src] of sources.entries()) {
      try {
        const blob = await imageBlob(src);
        if (blob.type.startsWith("image/")) files.push(new File([blob], `붙여 넣은 이미지 ${i + 1}.${blob.type.slice(6).replace("jpeg", "jpg")}`, { type: blob.type }));
      } catch {
        // 읽을 수 없는 이미지(다른 사이트 이미지 등)는 건너뛴다
      }
    }
    if (files.length > 0) onFiles(files);
  };

  return (
    <div className="image-paste">
      <div
        ref={box}
        className="image-paste-box"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-label="이미지 붙여넣기 칸"
        data-placeholder="여기를 길게 눌러 붙여넣거나, 키보드의 클립보드에서 스크린샷을 누르세요"
        onPaste={onPaste}
        onInput={() => void onInput()}
        onDrop={(e) => {
          e.preventDefault();
          const files = transferFiles(e.dataTransfer).filter((f) => f.type.startsWith("image/"));
          if (files.length > 0) onFiles(files);
        }}
      />
      <button type="button" className="image-paste-close" onClick={onClose} title="닫기" aria-label="붙여넣기 칸 닫기">
        ×
      </button>
    </div>
  );
}

/** <img> 주소의 이미지를 읽는다. data:는 바로 풀고, 그 밖(blob: 등)은 그림판(canvas)에 그려 PNG로 (페이지 보안 정책이 fetch를 막아도 되게) */
async function imageBlob(src: string): Promise<Blob> {
  const data = /^data:([^;,]+);base64,(.*)$/s.exec(src);
  if (data) return new Blob([Uint8Array.from(atob(data[2]!), (c) => c.charCodeAt(0))], { type: data[1] });
  const img = new Image();
  img.src = src;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext("2d")!.drawImage(img, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("이미지를 읽지 못했습니다"))), "image/png"));
}
