import { describe, expect, it } from "vitest";
import type { StoredSession } from "@pi-desktop/host-protocol";
import { queryTerms, searchSessions, sessionText, snippetAround } from "../src/history-search";

const jsonl = (...entries: unknown[]) => entries.map((e) => JSON.stringify(e)).join("\n");
const message = (role: string, content: unknown) => ({ type: "message", message: { role, content } });

const stored = (path: string, firstMessage: string, name?: string): StoredSession => ({
  path,
  id: path,
  cwd: "C:/work",
  created: 0,
  modified: 0,
  messageCount: 2,
  firstMessage,
  ...(name ? { name } : {}),
});

describe("지난 대화 검색", () => {
  it("세션 파일에서 사용자·에이전트의 글과 이름만 꺼낸다 (도구 결과·사고 제외)", () => {
    const text = sessionText(
      jsonl(
        { type: "session", cwd: "C:/work" },
        message("user", "배포 스크립트 고쳐 줘"),
        message("assistant", [
          { type: "thinking", thinking: "비밀스러운 생각" },
          { type: "text", text: "deploy.sh를 고쳤어요" },
        ]),
        message("toolResult", [{ type: "text", text: "도구 출력" }]),
        { type: "session_info", name: "배포 정리" },
      ) + "\n깨진 줄",
    );
    expect(text.split("\n")).toEqual(["배포 스크립트 고쳐 줘", "deploy.sh를 고쳤어요", "배포 정리"]);
  });

  it("검색어의 모든 낱말이 들어 있는 대화만, 순서 그대로, 앞뒤 글과 함께", async () => {
    const files: Record<string, string> = {
      a: jsonl(message("user", "프록시 설정 알려 줘"), message("assistant", [{ type: "text", text: "회사 프록시는 proxy.corp:8080 입니다" }])),
      b: jsonl(message("user", "점심 메뉴")),
      c: jsonl(message("user", "PROXY 다시")),
    };
    const sessions = [stored("a", "프록시 설정 알려 줘"), stored("b", "점심 메뉴"), stored("c", "PROXY 다시"), stored("gone", "지워진 파일")];
    const read = async (path: string) => {
      const text = files[path];
      if (text === undefined) throw new Error("없음");
      return text;
    };
    expect((await searchSessions(sessions, "proxy", read)).map((h) => h.path)).toEqual(["a", "c"]);
    const [hit] = await searchSessions(sessions, "proxy 8080", read);
    expect(hit).toMatchObject({ path: "a" });
    expect(hit!.snippet).toContain("proxy.corp:8080");
    expect(await searchSessions(sessions, "   ", read)).toEqual([]);
  });

  it("검색어 나누기와 앞뒤 글 자르기", () => {
    expect(queryTerms("  Foo  bar ")).toEqual(["foo", "bar"]);
    expect(snippetAround(`${"가".repeat(100)}찾는말${"나".repeat(100)}`, "찾는말", 5)).toBe("…가가가가가찾는말나나나나나…");
  });
});
