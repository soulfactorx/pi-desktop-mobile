import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile, stat } from "node:fs/promises";
import type { PiLocation, SessionHistoryParams, StoredReadResult, StoredSession } from "@pi-desktop/host-protocol";

/**
 * 설치된 Pi의 SDK를 동적으로 불러와 쓴다 (설계 §2 "SDK는 메타데이터 조회에만").
 *
 * Host Agent 번들에 Pi를 넣지 않으므로, 실행 시점에 그 호스트에 설치된 Pi 패키지에서 import한다.
 * 그래서 Pi가 업데이트되어 세션 저장 방식이 바뀌어도 그 버전의 코드가 그대로 처리한다.
 * 여기서 쓰는 SDK 표면은 최소한으로 둔다: SessionManager.list / listAll, 세션 파일 해석용 순수 함수.
 */

/** 이 파일이 쓰는 Pi SDK의 일부 (타입은 Pi의 SessionInfo에서 필요한 필드만) */
interface PiSessionInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  parentSessionPath?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
}

interface PiSdk {
  /** 세션 JSONL 내용을 항목 배열로 (첫 항목은 헤더) */
  parseSessionEntries(content: string): Array<Record<string, unknown>>;
  /** 예전 형식 항목을 현재 형식으로 (메모리 안에서만 바꾼다) */
  migrateSessionEntries(entries: Array<Record<string, unknown>>): void;
  /** 항목들에서 현재 갈래의 모델 컨텍스트(메시지)를 만든다 */
  buildSessionContext(
    entries: Array<Record<string, unknown>>,
    leafId?: string | null,
  ): { messages: unknown[]; model: { provider: string; modelId: string } | null };
  SessionManager: {
    list(cwd: string, sessionDir?: string): Promise<PiSessionInfo[]>;
    listAll(sessionDir?: string): Promise<PiSessionInfo[]>;
  };
}

const loaded = new Map<string, Promise<PiSdk>>();

/** Pi 패키지 디렉터리의 SDK 진입점(dist/index.js)을 불러온다. 같은 설치본은 한 번만 불러온다. */
export function loadPiSdk(pi: PiLocation): Promise<PiSdk> {
  let sdk = loaded.get(pi.packageDir);
  if (!sdk) {
    const entry = pathToFileURL(join(pi.packageDir, "dist", "index.js")).href;
    sdk = (import(entry) as Promise<PiSdk>).catch((error: unknown) => {
      loaded.delete(pi.packageDir);
      throw new Error(`Pi SDK를 불러오지 못했습니다 (${pi.version}): ${error instanceof Error ? error.message : String(error)}`);
    });
    loaded.set(pi.packageDir, sdk);
  }
  return sdk;
}

const DEFAULT_LIMIT = 200;
const FIRST_MESSAGE_MAX = 200;

/** Pi가 저장한 세션 목록. 최근 수정 순. */
export async function listStoredSessions(sdk: PiSdk, params: SessionHistoryParams): Promise<StoredSession[]> {
  const infos = params.cwd
    ? await sdk.SessionManager.list(params.cwd, params.sessionDir)
    : await sdk.SessionManager.listAll(params.sessionDir);
  const sessions = infos
    .map((info) => toStoredSession(info))
    .sort((a, b) => b.modified - a.modified)
    .slice(0, params.limit ?? DEFAULT_LIMIT);
  await markMissingCwds(sessions);
  return sessions;
}

/**
 * 작업 폴더가 지워진 세션에 cwdMissing을 붙인다. Pi는 이런 세션을 그대로 열지 못하므로
 * 화면이 미리 알고 다른 열기 방법을 고르게 한다 (예: WSL을 다시 시작해 비워진 /tmp의 세션).
 * 같은 폴더의 세션이 많으므로 폴더마다 한 번만 확인한다.
 */
async function markMissingCwds(sessions: StoredSession[]): Promise<void> {
  const cwds = [...new Set(sessions.map((s) => s.cwd).filter(Boolean))];
  const missing = new Set<string>();
  await Promise.all(
    cwds.map(async (cwd) => {
      const info = await stat(cwd).catch(() => undefined);
      if (!info?.isDirectory()) missing.add(cwd);
    }),
  );
  for (const session of sessions) if (missing.has(session.cwd)) session.cwdMissing = true;
}

function toStoredSession(info: PiSessionInfo): StoredSession {
  const session: StoredSession = {
    path: info.path,
    id: info.id,
    cwd: info.cwd,
    created: toMs(info.created),
    modified: toMs(info.modified),
    messageCount: info.messageCount,
    firstMessage: (info.firstMessage ?? "").slice(0, FIRST_MESSAGE_MAX),
  };
  if (info.name) session.name = info.name;
  if (info.parentSessionPath) session.parentSessionPath = info.parentSessionPath;
  return session;
}

function toMs(value: Date | string | number): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/**
 * 저장된 세션 파일을 읽어 현재 갈래의 대화를 만든다. **파일에는 절대 쓰지 않는다.**
 *
 * 다른 프로그램(TUI 등)이 쓰고 있는 파일일 수 있어 SessionManager.open(마이그레이션 등으로 파일을 다시 쓸 수
 * 있음)은 쓰지 않고, 내용을 직접 읽어 SDK의 순수 함수로만 해석한다.
 * 상대가 마지막 줄을 쓰는 중이면 그 줄은 잘려 있을 수 있으므로 마지막 줄바꿈까지만 해석한다.
 * 세션은 항목을 뒤에 덧붙이는 트리라서, 마지막으로 덧붙은 항목이 현재 위치(leaf)다.
 */
export async function readStoredSession(sdk: PiSdk, path: string): Promise<StoredReadResult> {
  const [raw, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
  const complete = raw.slice(0, raw.lastIndexOf("\n") + 1);
  const entries = sdk.parseSessionEntries(complete);
  sdk.migrateSessionEntries(entries);
  const body = entries.filter((entry) => entry.type !== "session");
  const leaf = body.at(-1);
  const leafId = typeof leaf?.id === "string" ? leaf.id : null;
  const context = sdk.buildSessionContext(body, leafId);
  return {
    path,
    messages: context.messages,
    leafId,
    model: context.model,
    size: info.size,
    modified: info.mtimeMs,
  };
}
