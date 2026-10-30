import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classify } from "../extensions/permissions/rules";
import { buildKnowledgeSection, overlap, relevance } from "../extensions/memory/recall";
import {
  bulkUpdate,
  createEntry,
  deleteEntry,
  exportMarkdown,
  formatEntry,
  getEntry,
  knowledgeStats,
  loadEntries,
  markReviewed,
  mergeEntries,
  needsReview,
  parseEntry,
  recordRecall,
  updateEntry,
  upsertByTitle,
  type KnowledgeEntry,
} from "../extensions/memory/store";
import { startPi, type RpcPi, type RpcRecord } from "./helpers/rpc-pi";
import { startScriptLlm, type ScriptLlm } from "./helpers/script-llm";

const entry = (id: string, patch: Partial<KnowledgeEntry> = {}): KnowledgeEntry => ({
  id,
  type: "reference",
  title: id,
  content: "본문",
  tags: [],
  status: "active",
  pinned: false,
  origin: "agent",
  created: "2026-10-01T00:00:00.000Z",
  updated: "2026-10-01T00:00:00.000Z",
  ...patch,
});

describe("지식베이스 파일", () => {
  it("만들기·읽기·고치기·보관·지우기 (지운 것은 forgotten/으로)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-"));
    const a = await createEntry(dir, { type: "requirement", title: " 배포는 금요일 금지 ", content: "금요일엔 배포하지 않는다", tags: ["배포", "배포", "규칙,"] });
    expect(a).toMatchObject({ title: "배포는 금요일 금지", tags: ["배포", "규칙"], status: "active", pinned: false, origin: "agent" });
    writeFileSync(join(dir, "broken.md"), "frontmatter 없음");
    expect((await loadEntries(dir)).map((e) => e.id)).toEqual([a.id]);

    const updated = await updateEntry(dir, a.id, { content: "금요일·공휴일 전날 배포 금지", pinned: true });
    expect(updated).toMatchObject({ pinned: true, content: "금요일·공휴일 전날 배포 금지", created: a.created });
    await updateEntry(dir, a.id, { status: "archived" });
    expect(await loadEntries(dir)).toEqual([]);
    expect((await loadEntries(dir, { includeArchived: true })).map((e) => e.status)).toEqual(["archived"]);
    expect(await deleteEntry(dir, a.id)).toBe(true);
    expect(await deleteEntry(dir, "../escape")).toBe(false);
    expect(existsSync(join(dir, "forgotten", `${a.id}.md`))).toBe(true);
  });

  it("파일 형식을 왕복하고, 예전 형식(kind·한 줄)도 읽는다", () => {
    const e = entry("x", { type: "lesson", title: "캐시", content: "**재발 방지:** 지운다", tags: ["gradle"], pinned: true, unverified: true, source: "s.jsonl" });
    expect(parseEntry("x", formatEntry(e))).toEqual(e);
    expect(parseEntry("p", "---\nkind: preference\ncreated: 2026-01-01\n---\n답은 짧게")).toMatchObject({ type: "user", title: "답은 짧게", pinned: true });
    expect(parseEntry("f", "---\nkind: fact\nsource: auto\n---\n회사 PC는 Windows")).toMatchObject({ type: "user", pinned: false, origin: "agent" });
    expect(parseEntry("l", "---\nkind: lesson\n---\n테스트는 -w로")).toMatchObject({ type: "lesson" });
    expect(parseEntry("e", "---\ntype: lesson\n---\n")).toBeUndefined();
  });

  it("같은 제목이면 새로 만들지 않고 고친다 (태그는 합친다)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-"));
    const first = await upsertByTitle(dir, { type: "reference", title: "배포 서버", content: "a", tags: ["배포"] });
    const second = await upsertByTitle(dir, { type: "reference", title: "배포 서버", content: "b", tags: ["서버"] });
    expect([first.op, second.op]).toEqual(["create", "update"]);
    expect(await loadEntries(dir)).toHaveLength(1);
    expect(second.entry).toMatchObject({ content: "b", tags: ["배포", "서버"] });
  });

  it("일괄 작업·합치기·확인함·회상 기록", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-"));
    const a = await createEntry(dir, { type: "reference", title: "A", content: "가" });
    const b = await createEntry(dir, { type: "reference", title: "B", content: "나", tags: ["t"] });
    const c = await createEntry(dir, { type: "reference", title: "C", content: "다", unverified: true } as never);
    expect(await bulkUpdate(dir, [a.id, b.id], "addTag", "공유제외")).toBe(2);
    expect(await bulkUpdate(dir, [a.id], "pin")).toBe(1);
    expect((await getEntry(dir, a.id))).toMatchObject({ pinned: true, tags: ["공유제외"] });

    const merged = await mergeEntries(dir, a.id, [b.id]);
    expect(merged?.content).toContain("나");
    expect(merged?.tags).toEqual(["공유제외", "t"]);
    expect(await getEntry(dir, b.id)).toBeUndefined();

    expect((await markReviewed(dir, c.id))).toMatchObject({ reviewed: expect.any(String) });
    expect((await getEntry(dir, c.id))?.unverified).toBeUndefined();

    await recordRecall(dir, [a.id, a.id]);
    expect((await loadEntries(dir)).find((e) => e.id === a.id)?.recallCount).toBe(2);
    expect(await bulkUpdate(dir, [c.id], "delete")).toBe(1);
  });
});

describe("점검·통계·내보내기", () => {
  const now = new Date("2026-12-01T00:00:00Z");

  it("중복·노후·형식 불일치·확인 안 됨을 이유와 함께 올리고, 확인함·고정은 올리지 않는다", () => {
    const items = needsReview(
      [
        entry("d1", { title: "Gradle 빌드 캐시 문제", tags: ["gradle"], recallCount: 3 }),
        entry("d2", { title: "Gradle 빌드 캐시 문제 해결", tags: ["gradle"], recallCount: 3 }),
        entry("old", { title: "오래된 메모", created: "2026-09-01T00:00:00.000Z" }),
        entry("lesson", { type: "lesson", title: "교훈", content: "그냥 조심", recallCount: 1 }),
        entry("uv", { title: "확인 안 된 사실", unverified: true, recallCount: 1 }),
        entry("ok", { title: "확인한 것", unverified: true, reviewed: "2026-11-01", created: "2026-01-01T00:00:00.000Z" }),
        entry("pin", { title: "고정", pinned: true, created: "2026-01-01T00:00:00.000Z" }),
      ],
      now,
    );
    expect(items.map((i) => `${i.kind}:${i.id}`)).toEqual(["duplicate:d1", "stale:old", "stale:lesson", "malformed:lesson", "unverified:uv"].filter((k) => k !== "stale:lesson"));
    expect(items[0]).toMatchObject({ pairId: "d2" });
  });

  it("통계와 Markdown 내보내기", () => {
    const all = [entry("a", { type: "lesson", tags: ["x", "y"], pinned: true }), entry("b", { tags: ["x"] }), entry("c", { status: "archived" })];
    expect(knowledgeStats(all)).toMatchObject({ active: 2, archived: 1, pinned: 1, byType: { lesson: 1, reference: 1, user: 0 }, tags: [{ tag: "x", count: 2 }, { tag: "y", count: 1 }] });
    const md = exportMarkdown(all, now);
    expect(md).toContain("## 교훈 (1)");
    expect(md).toContain("### a (고정)");
    expect(md).toContain("(보관)");
  });
});

describe("회상", () => {
  it("조사가 붙어도 겹침을 잡고, 제목·태그를 본문보다 무겁게 본다", () => {
    expect(overlap("커밋 메시지는 한글로", "커밋메시지 써 줘")).toBeGreaterThan(0.3);
    expect(overlap("회사 PC는 Windows", "날씨 알려 줘")).toBe(0);
    expect(relevance(entry("x", { title: "프록시 설정" }), "프록시 바꿔 줘")).toBeGreaterThan(relevance(entry("y", { content: "프록시 설정" }), "프록시 바꿔 줘"));
  });

  it("목록은 모두 한 줄씩, 고정은 늘 본문, 관련 있는 것만 본문, 보관은 빼고, 예산을 넘지 않는다", () => {
    const entries = [
      entry("pin", { type: "user", title: "답은 짧게", content: "세 줄 이내", pinned: true }),
      entry("proxy", { title: "회사 프록시", content: "proxy.corp:8080", tags: ["프록시"] }),
      entry("mac", { title: "집에서는 macOS", content: "맥북" }),
      entry("arch", { title: "보관한 것", status: "archived" }),
      entry("uv", { title: "확인 안 된 사실", unverified: true }),
    ];
    const { text, injected } = buildKnowledgeSection(entries, "프록시 설정 확인해 줘", 8000);
    expect(text).toContain("- [사용자] 답은 짧게 (id: pin)");
    expect(text).toContain("- [참조] 집에서는 macOS (id: mac)");
    expect(text).toContain("- [참조][확인 안 됨] 확인 안 된 사실 (id: uv)");
    expect(text).not.toContain("보관한 것");
    expect(text).toContain("proxy.corp:8080");
    expect(text).not.toContain("맥북");
    expect(injected).toEqual(["pin", "proxy"]);
    expect(buildKnowledgeSection([], "x", 8000)).toEqual({ injected: [] });

    const small = buildKnowledgeSection(Array.from({ length: 50 }, (_, i) => entry(`e${i}`, { title: `항목 ${i} 제목이 조금 깁니다` })), "", 600);
    expect(small.text).toContain("…그 밖에");
    expect(small.text!.length).toBeLessThan(1200);
  });

  it("지식 도구는 승인 없이 쓴다", () => {
    for (const tool of ["memory_save", "memory_forget", "memory_read", "memory_search"]) expect(classify(tool, {})).toEqual({ risk: "read" });
  });
});

describe("지식베이스 (실제 Pi)", () => {
  let llm: ScriptLlm;
  let pi: RpcPi;
  let dataDir: string;

  beforeAll(async () => {
    llm = await startScriptLlm("mock-model");
    ({ pi, dataDir } = await startPi(llm.baseUrl));
  });

  afterAll(async () => {
    pi?.close();
    await llm?.close();
  });

  // Pi는 섹션이 바뀌면 시스템 메시지 하나를 고쳐 보낸다 (지식이 대화에 쌓이지 않는다)
  const systemText = (request: Record<string, unknown> | undefined) =>
    JSON.stringify(((request?.messages as Array<{ role: string }> | undefined) ?? []).filter((m) => m.role === "system"));
  const notices = (from: number) =>
    pi.records.slice(from).filter((r: RpcRecord) => r.type === "extension_ui_request" && r.method === "notify").map((r) => String(r.message));
  const files = () => readdirSync(join(dataDir, "memory")).filter((n) => n.endsWith(".md"));

  it("memory_save는 묻지 않고 남기고 알린다. 같은 제목은 고친다", async () => {
    llm.setScript([
      { tool: "memory_save", args: { type: "reference", title: "배포 서버", content: "deploy.example.com", tags: ["배포"] } },
      { tool: "memory_save", args: { type: "reference", title: "배포 서버", content: "deploy2.example.com" } },
      { text: "남겼어" },
    ]);
    const from = pi.mark;
    await pi.request({ type: "prompt", message: "배포 서버는 deploy2.example.com이야, 기억해" });
    await pi.waitFor((r) => r.type === "agent_settled", from);
    expect(pi.records.slice(from).some((r) => r.type === "extension_ui_request" && r.method === "select")).toBe(false);
    expect(notices(from)).toEqual(["지식베이스에 남겼습니다: [참조] 배포 서버", "지식베이스에 고쳤습니다: [참조] 배포 서버"]);
    expect(files()).toHaveLength(1);
    expect(readFileSync(join(dataDir, "memory", files()[0]!), "utf8")).toContain("deploy2.example.com");
  });

  it("관련 있는 요청에는 본문까지, 없으면 목록에만 싣고, memory_read로 본문을 읽는다", async () => {
    llm.setScript([{ text: "응" }]);
    let from = pi.mark;
    await pi.request({ type: "prompt", message: "배포 서버 주소가 뭐였지?" });
    await pi.waitFor((r) => r.type === "agent_settled", from);
    expect(systemText(llm.requests.at(-1))).toContain("deploy2.example.com");

    const id = files()[0]!.slice(0, -3);
    llm.setScript([{ tool: "memory_read", args: { id } }, { text: "응" }]);
    from = pi.mark;
    await pi.request({ type: "prompt", message: "오늘 점심 메뉴 추천" });
    const end = await pi.waitFor((r) => r.type === "tool_execution_end", from);
    await pi.waitFor((r) => r.type === "agent_settled", from);
    const first = llm.requests.find((r) => JSON.stringify(r.messages).includes("오늘 점심 메뉴 추천"));
    expect(systemText(first)).toContain(`[참조] 배포 서버 (id: ${id})`);
    expect(systemText(first)).not.toContain("deploy2.example.com");
    expect(JSON.stringify(end.result)).toContain("deploy2.example.com");
  });

  it("/agent:remember는 고정으로 남겨 다음 요청부터 늘 본문까지 싣는다", async () => {
    let from = pi.mark;
    await pi.request({ type: "prompt", message: "/agent:remember 답은 세 줄 이내로" });
    await pi.waitFor((r) => r.type === "extension_ui_request" && r.method === "notify", from);

    llm.setScript([{ text: "응" }]);
    from = pi.mark;
    await pi.request({ type: "prompt", message: "아무 질문" });
    await pi.waitFor((r) => r.type === "agent_settled", from);
    expect(systemText(llm.requests.at(-1))).toContain("### 고정 [사용자] 답은 세 줄 이내로");
  });
});
