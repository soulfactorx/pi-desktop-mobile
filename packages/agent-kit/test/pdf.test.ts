import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { pageText, parseCmap, pdfText } from "../extensions/documents/pdf";

/** 객체 본문들로 PDF를 만든다 (번호는 1부터, null은 그 번호를 건너뛴다). 스트림 객체는 { dict, stream }으로, deflate하면 FlateDecode를 붙인다 */
type Obj = string | null | { dict: string; stream: Buffer | string; deflate?: boolean };

function buildPdf(objects: Obj[], trailer = "/Root 1 0 R"): Buffer {
  const parts: Buffer[] = [Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  objects.forEach((obj, i) => {
    if (obj === null) return;
    parts.push(Buffer.from(`${i + 1} 0 obj\n`, "latin1"));
    if (typeof obj === "string") {
      parts.push(Buffer.from(`${obj}\nendobj\n`, "latin1"));
    } else {
      const raw = typeof obj.stream === "string" ? Buffer.from(obj.stream, "latin1") : obj.stream;
      const data = obj.deflate ? deflateSync(raw) : raw;
      const filter = obj.deflate ? " /Filter /FlateDecode" : "";
      parts.push(Buffer.from(`<< ${obj.dict}${filter} /Length ${data.length} >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream\nendobj\n", "latin1"));
    }
  });
  parts.push(Buffer.from(`trailer\n<< ${trailer} >>\n%%EOF\n`, "latin1"));
  return Buffer.concat(parts);
}

const CMAP = `/CIDInit /ProcSet findresource begin
begincmap
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
2 beginbfchar
<0001> <D55C>
<0002> <AE00>
endbfchar
1 beginbfrange
<0003> <0004> <AC00>
endbfrange
endcmap`;

describe("PDF 글 뽑기", () => {
  it("Flate 내용, 라틴 글꼴, ToUnicode가 있는 Type0(2바이트) 글꼴, 줄바꿈·띄어쓰기", () => {
    const pdf = buildPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      "<< /Type /Font /Subtype /Type0 /BaseFont /Malgun /Encoding /Identity-H /ToUnicode 7 0 R >>",
      { dict: "", stream: "BT /F1 12 Tf 72 720 Td (Hello \\(World\\)) Tj 0 -20 Td /F2 12 Tf <00010002> Tj [<0003> -300 <0001>] TJ ET", deflate: true },
      { dict: "", stream: CMAP, deflate: true },
    ]);
    expect(pdfText(pdf)).toBe("Hello (World)\n한글가 한");
  });

  it("객체 스트림 안의 글꼴, 부모에게 물려받은 Resources, 페이지 트리 순서", () => {
    // 4·5번 객체(글꼴)를 객체 스트림(8번)에 넣는다. 페이지는 Kids 순서대로 (번호와 반대)
    const inner = ["<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", "<< /Type /Font /Subtype /Type0 /ToUnicode 7 0 R >>"];
    const header = `4 0 5 ${inner[0]!.length + 1} `;
    const objstm = header + inner.join(" ");
    const pdf = buildPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [9 0 R 3 0 R] /Count 2 /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> >>",
      "<< /Type /Page /Parent 2 0 R /Contents [6 0 R] >>",
      null,
      null,
      { dict: "", stream: "BT /F2 10 Tf <0003> Tj ET", deflate: true },
      { dict: "", stream: CMAP, deflate: true },
      { dict: `/Type /ObjStm /N 2 /First ${header.length}`, stream: objstm, deflate: true },
      "<< /Type /Page /Parent 2 0 R /Contents 10 0 R >>",
      { dict: "", stream: "BT /F1 10 Tf (first page) Tj ET" },
    ]);
    expect(pdfText(pdf)).toBe("first page\n\n가");
  });

  it("암호화·글자 없음·PDF 아님은 이유를 담아 거절한다", () => {
    expect(() => pdfText(buildPdf(["<< /Type /Catalog >>"], "/Root 1 0 R /Encrypt 2 0 R"))).toThrow(/암호/);
    expect(() =>
      pdfText(buildPdf(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] >>", "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>", { dict: "", stream: "q 1 0 0 1 0 0 cm Q" }])),
    ).toThrow(/글자를 찾지 못한/);
    expect(() => pdfText(Buffer.from("hello"))).toThrow(/PDF 파일이 아니다/);
  });

  it("CMap 범위·배열, 8진 이스케이프, ' 연산자", () => {
    const cmap = parseCmap("1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfrange <41> <42> [<0058> <0059>] endbfrange");
    expect(cmap.codeBytes).toBe(1);
    expect([cmap.map.get(0x41), cmap.map.get(0x42)]).toEqual(["X", "Y"]);
    const fonts = new Map([["F1", { cid: false }]]);
    expect(pageText("BT /F1 9 Tf (caf\\351) Tj (next) ' ET", fonts)).toBe("café\nnext");
  });
});
