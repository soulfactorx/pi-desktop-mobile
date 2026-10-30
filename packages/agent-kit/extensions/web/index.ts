import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { htmlTitle, htmlToText } from "./html";

/** 받아 올 응답 크기 상한. 넘으면 앞부분만 읽는다 */
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const DEFAULT_MAX_CHARS = 20_000;

/**
 * 웹 페이지 읽기 도구 (설계 DESIGN-AGENT.md §4 "HTTP 요청, 웹 검색").
 *
 * 검색은 Pi 방식대로 MCP 서버(mcp.json)에 맡기고, 여기서는 주소 하나를 받아 본문을 글로 돌려준다.
 * 주소에 데이터를 실어 내보낼 수 있으므로 permissions 확장이 "네트워크"로 분류해 묻는다.
 * 큰 결과는 local-model 확장이 창에 맞게 한 번 더 줄인다.
 */
export default function web(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "web_fetch",
    label: "웹 페이지 읽기",
    description:
      "http(s) 주소의 내용을 받아 읽을 수 있는 글로 돌려준다 (HTML은 태그를 걷어 낸 본문). " +
      "문서·공지·API 응답처럼 최신 정보를 직접 확인해야 할 때 쓴다. 로그인이 필요한 페이지는 읽지 못한다.",
    promptSnippet: "web_fetch: 주소의 페이지 내용을 읽는다",
    parameters: Type.Object({
      url: Type.String({ description: "읽을 http(s) 주소" }),
      maxChars: Type.Optional(Type.Number({ description: `돌려받을 최대 글자 수 (기본 ${DEFAULT_MAX_CHARS})` })),
    }),
    async execute(_toolCallId, params, signal) {
      const page = await fetchPage(params.url, signal);
      const maxChars = Math.max(500, Math.floor(params.maxChars ?? DEFAULT_MAX_CHARS));
      const body = page.text.length > maxChars ? `${page.text.slice(0, maxChars)}\n\n[앞 ${maxChars}자만 보냈다. 전체 ${page.text.length}자]` : page.text;
      const head = [`주소: ${page.url}`, page.title ? `제목: ${page.title}` : undefined, `형식: ${page.contentType || "알 수 없음"}`]
        .filter(Boolean)
        .join("\n");
      return {
        content: [{ type: "text", text: `${head}\n\n${body || "(본문 없음)"}` }],
        details: { url: page.url, status: page.status, contentType: page.contentType, truncated: page.truncated },
      };
    },
  });
}

export interface FetchedPage {
  url: string;
  status: number;
  contentType: string;
  title?: string;
  text: string;
  /** 크기 상한에 걸려 앞부분만 받았는지 */
  truncated: boolean;
}

export async function fetchPage(rawUrl: string, signal?: AbortSignal): Promise<FetchedPage> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`올바른 주소가 아니다: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`http(s) 주소만 읽을 수 있다: ${rawUrl}`);

  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const res = await fetch(url, {
    redirect: "follow",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { "user-agent": "pi-desktop-agent", accept: "text/html,application/json,text/plain;q=0.9,*/*;q=0.5" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} (${res.url || url.href})`);

  const contentType = res.headers.get("content-type") ?? "";
  if (/^(image|audio|video|font)\/|application\/(octet-stream|zip|pdf)/i.test(contentType)) {
    throw new Error(`글이 아닌 응답이라 읽지 않았다 (${contentType})`);
  }
  const { text: raw, truncated } = await readLimited(res, MAX_BYTES);
  const isHtml = /html/i.test(contentType) || /^\s*<(!doctype html|html)/i.test(raw);
  return {
    url: res.url || url.href,
    status: res.status,
    contentType,
    title: isHtml ? htmlTitle(raw) : undefined,
    text: isHtml ? htmlToText(raw) : raw.trim(),
    truncated,
  };
}

async function readLimited(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size >= maxBytes) {
      truncated = true;
      await reader.cancel();
      break;
    }
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks).subarray(0, maxBytes)), truncated };
}
