// 일부는 Pi Desktop apps/desktop/test/main/wsl.test.ts에서 가져왔다
import { describe, expect, it } from "vitest";
import { bundleFileName, nodeMajor, parseDistroList, parseProbe, probeScript, shQuote } from "../src/index";

describe("parseDistroList", () => {
  it("wsl.exe의 UTF-16LE 출력(BOM, CRLF 포함)에서 배포판 이름을 뽑는다", () => {
    const raw = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Ubuntu\r\nDebian\r\n\r\n", "utf16le")]);
    expect(parseDistroList(raw)).toEqual(["Ubuntu", "Debian"]);
  });

  it("BOM 없는 UTF-16LE도 읽는다", () => {
    expect(parseDistroList(Buffer.from("Ubuntu-24.04\r\n", "utf16le"))).toEqual(["Ubuntu-24.04"]);
  });

  it("UTF-8 출력도 읽는다 (WSL_UTF8=1 환경)", () => {
    expect(parseDistroList(Buffer.from("Ubuntu\nAlpine\n", "utf8"))).toEqual(["Ubuntu", "Alpine"]);
  });

  it("빈 출력이면 빈 배열", () => {
    expect(parseDistroList(Buffer.alloc(0))).toEqual([]);
  });
});

describe("shQuote", () => {
  it("작은따옴표를 포함한 문자열도 인자 하나로 감싼다", () => {
    expect(shQuote("/home/a b/it's")).toBe(`'/home/a b/it'\\''s'`);
  });
});

describe("parseProbe", () => {
  it("key=value 줄을 읽고, 섞여 들어온 다른 출력은 무시한다", () => {
    const out = [
      "Welcome to Ubuntu!",
      "pi-desktop-home=/home/soulfactor",
      "pi-desktop-node=/usr/bin/node",
      "pi-desktop-nodeVersion=v24.20.0",
      "pi-desktop-agent=1",
    ].join("\n");
    expect(parseProbe(out)).toEqual({
      home: "/home/soulfactor",
      node: "/usr/bin/node",
      nodeVersion: "v24.20.0",
      agentPresent: true,
    });
  });

  it("node가 없으면 빈 문자열", () => {
    expect(parseProbe("pi-desktop-home=/root\npi-desktop-node=\npi-desktop-agent=0\n")).toMatchObject({
      node: "",
      agentPresent: false,
    });
  });
});

describe("nodeMajor", () => {
  it("버전 문자열에서 주 버전을 읽는다", () => {
    expect(nodeMajor("v24.20.0")).toBe(24);
    expect(nodeMajor("22.19.1\n")).toBe(22);
    expect(nodeMajor("")).toBe(0);
  });
});

describe("bundleFileName", () => {
  it("내용이 같으면 같은 이름, 다르면 다른 이름", () => {
    const a = bundleFileName("host-agent", "0.0.1", Buffer.from("a"));
    expect(a).toMatch(/^host-agent-0\.0\.1-[0-9a-f]{12}\.mjs$/);
    expect(bundleFileName("host-agent", "0.0.1", Buffer.from("a"))).toBe(a);
    expect(bundleFileName("host-agent", "0.0.1", Buffer.from("b"))).not.toBe(a);
    expect(bundleFileName("mate-runner", "0.0.1", Buffer.from("a"))).toMatch(/^mate-runner-/);
  });
});

describe("probeScript", () => {
  it("번들 파일 존재 여부를 그 앱의 폴더에서 확인한다", () => {
    expect(probeScript("host-agent-x.mjs", ".pi-desktop-agent/agent")).toContain(".pi-desktop-agent/agent/host-agent-x.mjs");
    expect(probeScript("mate-runner-x.mjs", ".pi-desktop-mate/runner")).toContain(".pi-desktop-mate/runner/mate-runner-x.mjs");
  });
});
