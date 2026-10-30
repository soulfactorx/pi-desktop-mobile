import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 웹 서버의 접근 확인 (설계 DESIGN.md §5.10 "보안", apps/desktop/src/server/auth.ts와 같다).
 *
 * 이 서버는 데스크톱 앱의 main 프로세스와 같은 힘을 가진다(명령 실행, 파일 쓰기). 그래서
 * - 토큰: 처음 실행할 때 만들어 데이터 폴더에 0600으로 둔다. WebSocket과 /api/auth는 이 토큰이 있어야 한다.
 *   휴대폰의 다른 앱도 localhost 포트에 붙을 수 있으므로 localhost에만 열어도 토큰은 꼭 필요하다.
 * - Host·Origin: 다른 웹사이트가 브라우저를 시켜 붙는 것(DNS rebinding, 교차 출처 WebSocket)을 막는다.
 */

/** 토큰 파일을 읽고, 없으면 만든다 */
export function loadOrCreateToken(path: string): string {
  if (existsSync(path)) {
    const token = readFileSync(path, "utf8").trim();
    if (token.length >= 16) return token;
  }
  mkdirSync(dirname(path), { recursive: true });
  const token = randomBytes(24).toString("base64url");
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
}

/** 시간 차로 토큰을 알아내지 못하게 해시끼리 견준다 */
export function tokenMatches(expected: string, given: string | null | undefined): boolean {
  if (!given) return false;
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(given).digest();
  return timingSafeEqual(a, b);
}

/** Authorization: Bearer <토큰> */
export function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  return match?.[1];
}

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * 요청의 Host·Origin이 이 서버를 가리키는지 본다.
 * - loopbackOnly(localhost에만 열었을 때): Host는 localhost·127.0.0.1·[::1]만. 다른 이름으로 온 것은 DNS rebinding이다
 * - Origin이 있으면(브라우저) 그 host가 Host와 같아야 한다
 */
export function requestAllowed(headers: { host?: string | undefined; origin?: string | undefined }, loopbackOnly: boolean): boolean {
  const host = headers.host?.toLowerCase();
  if (!host) return false;
  if (loopbackOnly) {
    let name: string;
    try {
      name = new URL(`http://${host}`).hostname;
    } catch {
      return false;
    }
    if (!LOOPBACK_NAMES.has(name)) return false;
  }
  if (headers.origin === undefined) return true;
  try {
    return new URL(headers.origin).host.toLowerCase() === host;
  } catch {
    return false;
  }
}

/** 열 주소가 이 기기 안에서만 닿는 곳인지 */
export function isLoopbackAddress(address: string): boolean {
  return address === "localhost" || address === "::1" || /^127\./.test(address);
}
