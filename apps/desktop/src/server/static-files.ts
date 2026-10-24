import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";

/** 화면 파일(vite가 만든 out/web/public)을 내준다. 화면 파일에는 비밀이 없어 토큰 없이 받는다 */

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export function contentType(path: string): string {
  return TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** 주소의 경로를 root 안의 파일로 바꾼다. root 밖을 가리키거나 읽을 수 없는 경로면 undefined */
export function resolveStatic(root: string, urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0]!.split("#")[0]!);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0")) return undefined;
  const relative = decoded === "/" || decoded === "" ? "index.html" : decoded.replace(/^\/+/, "");
  const full = normalize(join(root, relative));
  const base = normalize(root.endsWith(sep) ? root : root + sep);
  return full.startsWith(base) ? full : undefined;
}

export async function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  const path = resolveStatic(root, req.url ?? "/");
  const info = path ? await stat(path).catch(() => undefined) : undefined;
  if (!path || !info?.isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("없는 파일입니다");
    return;
  }
  res.writeHead(200, {
    "Content-Type": contentType(path),
    "Content-Length": info.size,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    // vite가 해시를 붙인 assets/는 바뀌지 않는다. index.html 등은 매번 확인한다(업데이트 뒤 바로 새 화면)
    "Cache-Control": req.url?.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(path).pipe(res);
}
