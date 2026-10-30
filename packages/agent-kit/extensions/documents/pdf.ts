import { inflateSync, constants as zlib } from "node:zlib";

/**
 * PDF에서 글만 뽑는다 (의존성 없이, node:zlib만). agent-kit은 npm 의존성을 싣지 않으므로
 * (apps/agent/electron-builder.yml) pdf.js 같은 라이브러리 대신 필요한 만큼만 직접 읽는다.
 *
 * 다루는 것: FlateDecode 스트림, 객체 스트림(ObjStm), 페이지 트리 순서, 상속된 Resources,
 * ToUnicode CMap(bfchar·bfrange, 1·2바이트 코드 — 한글 PDF는 대부분 Identity-H + ToUnicode다),
 * 글 연산자(Tj·TJ·'·"·Td·TD·T*·Tm).
 * 다루지 않는 것: 암호화, 스캔 이미지(글자 없음), Form XObject 안의 글, ToUnicode 없는 CID 글꼴.
 * 읽지 못하면 이유를 담은 오류를 던진다.
 */

interface PdfObject {
  dict: string;
  stream?: Buffer;
}

type Cmap = { codeBytes: number; map: Map<number, string> };

/** dict 문자열에서 `/Key n g R` 참조의 객체 번호 */
function refOf(dict: string, key: string): number | undefined {
  const match = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dict);
  return match ? Number(match[1]) : undefined;
}

/** dict 문자열에서 `/Key << ... >>`의 안쪽 (중첩 괄호를 센다) */
function inlineDict(dict: string, key: string): string | undefined {
  const at = new RegExp(`/${key}\\s*<<`).exec(dict);
  if (!at) return undefined;
  let depth = 0;
  for (let i = at.index + at[0].length - 2; i < dict.length - 1; i++) {
    if (dict[i] === "<" && dict[i + 1] === "<") {
      depth++;
      i++;
    } else if (dict[i] === ">" && dict[i + 1] === ">") {
      depth--;
      i++;
      if (depth === 0) return dict.slice(at.index + at[0].length, i - 1);
    }
  }
  return undefined;
}

/** dict 문자열에서 `/Key [ ... ]`의 참조 번호들 */
function refArray(dict: string, key: string): number[] | undefined {
  const match = new RegExp(`/${key}\\s*\\[([^\\]]*)\\]`).exec(dict);
  if (!match) return undefined;
  return [...match[1]!.matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1]));
}

function decodeStream(dict: string, data: Buffer): Buffer | undefined {
  if (!/\/Filter\s*(\[\s*)?\/FlateDecode/.test(dict)) return /\/Filter/.test(dict) ? undefined : data;
  try {
    return inflateSync(data);
  } catch {
    try {
      // 끝이 조금 잘린 스트림도 흔하다
      return inflateSync(data, { finishFlush: zlib.Z_SYNC_FLUSH });
    } catch {
      return undefined;
    }
  }
}

/** 파일 전체에서 `n g obj ... endobj`를 모은다. 객체 스트림 안의 객체도 푼다 */
function readObjects(raw: string, buffer: Buffer): Map<number, PdfObject> {
  const objects = new Map<number, PdfObject>();
  const header = /(\d+)\s+\d+\s+obj\b/g;
  let match: RegExpExecArray | null;
  while ((match = header.exec(raw))) {
    const start = match.index + match[0].length;
    const end = raw.indexOf("endobj", start);
    if (end < 0) break;
    const body = raw.slice(start, end);
    const streamAt = body.search(/\bstream\r?\n/);
    if (streamAt < 0) {
      objects.set(Number(match[1]), { dict: body });
    } else {
      const dict = body.slice(0, streamAt);
      const dataStart = start + streamAt + (body.startsWith("stream\r\n", streamAt) ? 8 : 7);
      const length = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
      let dataEnd = length ? dataStart + Number(length[1]) : -1;
      if (dataEnd < 0 || dataEnd > end || !raw.startsWith("endstream", raw.slice(dataEnd, end).search(/\S/) + dataEnd)) {
        dataEnd = raw.lastIndexOf("endstream", end);
      }
      const decoded = decodeStream(dict, buffer.subarray(dataStart, dataEnd));
      objects.set(Number(match[1]), decoded ? { dict, stream: decoded } : { dict });
    }
    header.lastIndex = end;
  }
  // 객체 스트림: "번호 위치" 쌍 N개 뒤 /First부터 객체 본문들
  for (const object of [...objects.values()]) {
    if (!/\/Type\s*\/ObjStm/.test(object.dict) || !object.stream) continue;
    const n = Number(/\/N\s+(\d+)/.exec(object.dict)?.[1] ?? 0);
    const first = Number(/\/First\s+(\d+)/.exec(object.dict)?.[1] ?? 0);
    const text = object.stream.toString("latin1");
    const pairs = text.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i++) {
      const num = pairs[i * 2]!;
      const offset = first + pairs[i * 2 + 1]!;
      const next = i + 1 < n ? first + pairs[(i + 1) * 2 + 1]! : text.length;
      if (!objects.has(num)) objects.set(num, { dict: text.slice(offset, next) });
    }
  }
  return objects;
}

const hexBytes = (hex: string) => Buffer.from(hex.replace(/\s+/g, "").padEnd(Math.ceil(hex.replace(/\s+/g, "").length / 2) * 2, "0"), "hex");
const codeOf = (bytes: Buffer) => bytes.reduce((n, b) => n * 256 + b, 0);
const utf16 = (hex: string) => {
  const bytes = hexBytes(hex);
  let text = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) text += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!);
  return text;
};

/** ToUnicode CMap (bfchar·bfrange) */
export function parseCmap(text: string): Cmap {
  const map = new Map<number, string>();
  const space = /begincodespacerange\s*<([0-9A-Fa-f\s]+)>/.exec(text);
  const codeBytes = space ? Math.max(1, Math.ceil(space[1]!.replace(/\s+/g, "").length / 2)) : 2;
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1]!.matchAll(/<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]*)>/g)) map.set(codeOf(hexBytes(pair[1]!)), utf16(pair[2]!));
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const range of block[1]!.matchAll(/<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>\s*(<[0-9A-Fa-f\s]*>|\[[^\]]*\])/g)) {
      const lo = codeOf(hexBytes(range[1]!));
      const hi = codeOf(hexBytes(range[2]!));
      if (hi < lo || hi - lo > 0xffff) continue;
      const target = range[3]!;
      if (target.startsWith("[")) {
        const items = [...target.matchAll(/<([0-9A-Fa-f\s]*)>/g)].map((m) => utf16(m[1]!));
        items.forEach((s, i) => map.set(lo + i, s));
      } else {
        const base = utf16(target.slice(1, -1));
        const last = base.charCodeAt(base.length - 1);
        for (let code = lo; code <= hi; code++) map.set(code, base.slice(0, -1) + String.fromCharCode(last + (code - lo)));
      }
    }
  }
  return { codeBytes, map };
}

/** 글꼴 하나로 문자열 바이트를 글로 바꾼다. CMap이 없으면 1바이트 라틴 글자로 본다 (2바이트 CID 글꼴은 읽지 못함) */
function decodeText(bytes: Buffer, cmap: Cmap | undefined, cid: boolean): string {
  if (!cmap) return cid ? "" : bytes.toString("latin1");
  let text = "";
  for (let i = 0; i < bytes.length; ) {
    const size = Math.min(cmap.codeBytes, bytes.length - i);
    const code = codeOf(bytes.subarray(i, i + size));
    const mapped = cmap.map.get(code);
    if (mapped !== undefined) {
      text += mapped;
      i += size;
    } else if (size > 1 && cmap.map.has(bytes[i]!)) {
      text += cmap.map.get(bytes[i]!)!;
      i += 1;
    } else {
      i += size;
    }
  }
  return text;
}

type Token = { kind: "op"; value: string } | { kind: "str"; value: Buffer } | { kind: "num"; value: number } | { kind: "name"; value: string } | { kind: "arr"; value: Token[] };

/** 내용 스트림을 토큰으로 (글에 필요한 것만: 문자열·숫자·이름·배열·연산자) */
function tokenize(content: string): Token[] {
  const tokens: Token[] = [];
  const stack: Token[][] = [tokens];
  const push = (t: Token) => stack[stack.length - 1]!.push(t);
  let i = 0;
  while (i < content.length) {
    const c = content[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (c === "%") {
      while (i < content.length && content[i] !== "\n" && content[i] !== "\r") i++;
    } else if (c === "(") {
      const bytes: number[] = [];
      let depth = 1;
      i++;
      while (i < content.length && depth > 0) {
        const ch = content[i]!;
        if (ch === "\\") {
          const next = content[i + 1] ?? "";
          const escapes: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12, "(": 40, ")": 41, "\\": 92 };
          if (next in escapes) {
            bytes.push(escapes[next]!);
            i += 2;
          } else if (/[0-7]/.test(next)) {
            const oct = /^[0-7]{1,3}/.exec(content.slice(i + 1, i + 4))![0];
            bytes.push(parseInt(oct, 8) & 0xff);
            i += 1 + oct.length;
          } else {
            // 줄 이음 등은 버린다
            i += next === "\r" && content[i + 2] === "\n" ? 3 : 2;
          }
          continue;
        }
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
        if (depth > 0) bytes.push(ch.charCodeAt(0) & 0xff);
        i++;
      }
      push({ kind: "str", value: Buffer.from(bytes) });
    } else if (c === "<" && content[i + 1] !== "<") {
      const end = content.indexOf(">", i);
      push({ kind: "str", value: hexBytes(content.slice(i + 1, end < 0 ? content.length : end)) });
      i = end < 0 ? content.length : end + 1;
    } else if (c === "<" || c === ">") {
      // 인라인 dict(<< >>)는 글과 상관없다. 괄호만 건너뛴다
      i += 2;
    } else if (c === "[") {
      const array: Token[] = [];
      push({ kind: "arr", value: array });
      stack.push(array);
      i++;
    } else if (c === "]") {
      if (stack.length > 1) stack.pop();
      i++;
    } else if (c === "/") {
      const match = /^\/[^\s/<>[\]()%{}]*/.exec(content.slice(i, i + 128))![0];
      push({ kind: "name", value: match.slice(1) });
      i += match.length;
    } else if (/[0-9+\-.]/.test(c)) {
      const match = /^[+-]?(\d+\.?\d*|\.\d+)/.exec(content.slice(i, i + 32));
      if (match) {
        push({ kind: "num", value: Number(match[0]) });
        i += match[0].length;
      } else {
        i++;
      }
    } else {
      const match = /^[A-Za-z'"*]+/.exec(content.slice(i, i + 16));
      if (match) {
        // 인라인 이미지(BI ... ID ... EI)는 통째로 건너뛴다
        if (match[0] === "BI") {
          const end = content.indexOf("EI", i);
          i = end < 0 ? content.length : end + 2;
          continue;
        }
        if (stack.length === 1) tokens.push({ kind: "op", value: match[0] });
        i += match[0].length;
      } else {
        i++;
      }
    }
  }
  return tokens;
}

/** 페이지 하나의 글. fonts는 글꼴 자원 이름(/F1) → 그 글꼴의 CMap·CID 여부 */
export function pageText(content: string, fonts: Map<string, { cmap?: Cmap; cid: boolean }>): string {
  let out = "";
  let font: { cmap?: Cmap; cid: boolean } | undefined;
  let lastY: number | undefined;
  let operands: Token[] = [];
  const newline = () => {
    if (out && !out.endsWith("\n")) out += "\n";
  };
  const show = (bytes: Buffer) => {
    out += decodeText(bytes, font?.cmap, font?.cid ?? false);
  };
  for (const token of tokenize(content)) {
    if (token.kind !== "op") {
      operands.push(token);
      continue;
    }
    const nums = operands.filter((t): t is Extract<Token, { kind: "num" }> => t.kind === "num").map((t) => t.value);
    switch (token.value) {
      case "Tf": {
        const name = operands.find((t) => t.kind === "name");
        font = name ? fonts.get(name.value as string) : undefined;
        break;
      }
      case "Tj":
        for (const t of operands) if (t.kind === "str") show(t.value);
        break;
      case "'":
      case '"':
        newline();
        for (const t of operands) if (t.kind === "str") show(t.value);
        break;
      case "TJ":
        for (const t of operands) {
          if (t.kind !== "arr") continue;
          for (const item of t.value) {
            if (item.kind === "str") show(item.value);
            // 큰 음수 간격은 낱말 사이 띄어쓰기다
            else if (item.kind === "num" && item.value < -180 && !out.endsWith(" ")) out += " ";
          }
        }
        break;
      case "Td":
      case "TD":
        // 세로로 움직이면 새 줄. 가로 이동은 글자 간격 맞춤인 경우가 많아(Chromium·Skia) 띄어쓰기로 보지 않는다
        if (nums.length >= 2 && Math.abs(nums[1]!) > 0.5) newline();
        break;
      case "T*":
        newline();
        break;
      case "Tm": {
        const y = nums[5];
        if (y !== undefined && lastY !== undefined && Math.abs(y - lastY) > 0.5) newline();
        if (y !== undefined) lastY = y;
        break;
      }
      case "ET":
        break;
    }
    operands = [];
  }
  return out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function pdfText(buffer: Buffer): string {
  const raw = buffer.toString("latin1");
  if (!raw.startsWith("%PDF")) throw new Error("PDF 파일이 아니다");
  if (/\/Encrypt\s+(\d+\s+\d+\s+R|<<)/.test(raw)) throw new Error("암호가 걸린 PDF라 읽지 못했다");
  const objects = readObjects(raw, buffer);
  const get = (num: number | undefined) => (num === undefined ? undefined : objects.get(num));

  // 페이지 순서: Root → Pages → Kids를 따라간다. 찾지 못하면 /Type /Page 객체를 번호 순으로
  const pages: PdfObject[] = [];
  const rootNum = [...raw.matchAll(/\/Root\s+(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1])).at(-1);
  const visit = (num: number | undefined, depth = 0) => {
    const node = get(num);
    if (!node || depth > 32) return;
    if (/\/Type\s*\/Pages\b/.test(node.dict)) for (const kid of refArray(node.dict, "Kids") ?? []) visit(kid, depth + 1);
    else if (/\/Type\s*\/Page\b/.test(node.dict)) pages.push(node);
  };
  visit(refOf(get(rootNum)?.dict ?? "", "Pages"));
  if (pages.length === 0) {
    for (const [, object] of [...objects.entries()].sort((a, b) => a[0] - b[0])) if (/\/Type\s*\/Page\b/.test(object.dict)) pages.push(object);
  }

  const cmaps = new Map<number, Cmap>();
  const fontInfo = (num: number | undefined) => {
    const font = get(num);
    if (!font) return undefined;
    const cid = /\/Subtype\s*\/Type0/.test(font.dict);
    const toUnicode = refOf(font.dict, "ToUnicode");
    if (toUnicode === undefined) return { cid };
    if (!cmaps.has(toUnicode)) {
      const stream = get(toUnicode)?.stream;
      if (stream) cmaps.set(toUnicode, parseCmap(stream.toString("latin1")));
    }
    const cmap = cmaps.get(toUnicode);
    return cmap ? { cmap, cid } : { cid };
  };
  /** 페이지의 Resources (없으면 부모 Pages에서 물려받는다) */
  const resourcesOf = (page: PdfObject): string => {
    let node: PdfObject | undefined = page;
    for (let depth = 0; node && depth < 32; depth++) {
      const inline = inlineDict(node.dict, "Resources");
      if (inline !== undefined) return inline;
      const ref = get(refOf(node.dict, "Resources"));
      if (ref) return ref.dict;
      node = get(refOf(node.dict, "Parent"));
    }
    return "";
  };

  const texts: string[] = [];
  for (const page of pages) {
    const resources = resourcesOf(page);
    const fontDict = inlineDict(resources, "Font") ?? get(refOf(resources, "Font"))?.dict ?? "";
    const fonts = new Map<string, { cmap?: Cmap; cid: boolean }>();
    for (const entry of fontDict.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
      const info = fontInfo(Number(entry[2]));
      if (info) fonts.set(entry[1]!, info);
    }
    const contentRefs = refArray(page.dict, "Contents") ?? [refOf(page.dict, "Contents")].filter((n): n is number => n !== undefined);
    const content = contentRefs.map((n) => get(n)?.stream?.toString("latin1") ?? "").join("\n");
    const text = pageText(content, fonts);
    if (text) texts.push(text);
  }
  const all = texts.join("\n\n").trim();
  if (!all) throw new Error("글자를 찾지 못한 PDF다 (스캔한 이미지이거나 지원하지 않는 글꼴). 글자 인식(OCR)이 필요하다");
  return all;
}
