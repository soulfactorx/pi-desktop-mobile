import { inflateRawSync } from "node:zlib";

/**
 * .docx에서 본문 글만 뽑는다. 의존성 없이 zip 중앙 디렉터리를 읽고 word/document.xml만 푼다.
 *
 * agent-kit은 Pi가 jiti로 불러오는 패키지라 npm 의존성이 생기면 설치본에 node_modules를 함께 실어야 한다.
 * 문단·탭·줄바꿈만 살리면 되는 일이라 직접 읽는다 (표는 칸을 탭으로, 행을 줄로).
 */
export function docxText(buffer: Buffer): string {
  const xml = readZipEntry(buffer, "word/document.xml");
  if (xml === undefined) throw new Error("docx 안에 word/document.xml이 없다");
  return wordXmlToText(xml.toString("utf8"));
}

export function wordXmlToText(xml: string): string {
  let text = "";
  /** 지금 글 요소(w:t) 안인가. 그 밖의 글자(속성값 등)는 본문이 아니다 */
  let inText = false;
  for (const m of xml.matchAll(/<(\/?)([\w:]+)[^>]*?(\/?)>|([^<]+)/g)) {
    const [, closing, tag, selfClosing, chars] = m;
    if (chars !== undefined) {
      if (inText) text += chars;
      continue;
    }
    if (tag === "w:t") inText = !closing && !selfClosing;
    else if (tag === "w:tab" && selfClosing) text += "\t";
    else if ((tag === "w:br" || tag === "w:cr") && selfClosing) text += "\n";
    else if (closing && tag === "w:tc") text += "\t";
    else if (closing && (tag === "w:p" || tag === "w:tr")) text += "\n";
  }
  return decodeXml(text)
    .split("\n")
    .map((line) => line.replace(/\t+$/, "").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

/** zip에서 이름이 같은 항목 하나를 꺼낸다. 없으면 undefined */
export function readZipEntry(zip: Buffer, name: string): Buffer | undefined {
  // End of Central Directory: 끝에서 거꾸로 서명(0x06054b50)을 찾는다 (주석이 있으면 끝에서 떨어져 있다)
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip 파일이 아니다");
  const entries = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries; n++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error("zip 중앙 디렉터리가 깨졌다");
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const entryName = zip.toString("utf8", offset + 46, offset + 46 + nameLength);
    if (entryName === name) {
      const localNameLength = zip.readUInt16LE(localOffset + 26);
      const localExtraLength = zip.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const data = zip.subarray(start, start + compressedSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      throw new Error(`지원하지 않는 zip 압축 방식이다 (${method})`);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return undefined;
}
