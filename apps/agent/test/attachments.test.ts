import { describe, expect, it } from "vitest";
import { acceptsImages, imageMimeType, splitAttachments, withAttachments } from "../src/renderer/attachments";

describe("첨부", () => {
  it("이미지(png·jpeg·gif·webp)와 그 밖의 파일로 나눈다", () => {
    expect(splitAttachments(["C:/a/shot.PNG", "C:/a/report.pdf", "/b/photo.jpeg", "/b/notes.md", "/b/anim.gif", "/b/x.webp", "/b/raw.bmp"])).toEqual({
      images: ["C:/a/shot.PNG", "/b/photo.jpeg", "/b/anim.gif", "/b/x.webp"],
      files: ["C:/a/report.pdf", "/b/notes.md", "/b/raw.bmp"],
    });
    expect(imageMimeType("a.JPG")).toBe("image/jpeg");
    expect(imageMimeType("noext")).toBeUndefined();
  });

  it("모델이 이미지를 받는지: 입력 종류가 없으면 받는다고 본다", () => {
    expect(acceptsImages(["text", "image"])).toBe(true);
    expect(acceptsImages(["text"])).toBe(false);
    expect(acceptsImages(undefined)).toBe(true);
  });

  it("문서는 경로 줄로 붙인다", () => {
    expect(withAttachments("요약해 줘  ", ["C:/a/report.pdf"])).toBe("요약해 줘\n[첨부] C:/a/report.pdf");
    expect(withAttachments("", ["a.md", "b.md"])).toBe("[첨부] a.md\n[첨부] b.md\n");
    expect(withAttachments("그대로", [])).toBe("그대로");
  });
});
