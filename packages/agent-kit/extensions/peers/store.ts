import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentCard, CardDraft, InboundLog, InboundPairing, OutboundPairing, Peer, PeerPolicy, PeerSettings } from "./types";

export type { AgentCard, CardDraft, CardSkill, InboundLog, InboundPairing, OutboundPairing, Peer, PeerPolicy, PeerSettings } from "./types";

/**
 * 에이전트 네트워크(피어)의 상태 파일 (설계 DESIGN-AGENT.md §4 "에이전트 네트워크", desktop-agent DESIGN-AGENT-NETWORK.md).
 * agent-kit 상태 폴더의 peers/ 아래에 사람이 읽을 수 있는 JSON으로 둔다. 앱(화면)과 스케줄러 세션(서버)이 함께 읽고 쓴다.
 *
 * 확장은 대상 호스트의 Pi가 jiti로 불러오므로 node 내장 모듈만 import한다.
 */

/** 기본 수신 포트. desktop-agent(7810)와 함께 띄울 수 있게 나눈다 */
export const DEFAULT_PEER_PORT = 7811;

export const DEFAULT_POLICY: PeerPolicy = { question: "auto", dailyLimit: 50 };

export function peersDir(dataDir: string): string {
  return join(dataDir, "peers");
}

const file = (dataDir: string, name: string) => join(peersDir(dataDir), name);

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** 임시 파일에 쓴 뒤 바꿔 끼운다 (앱과 서버가 같은 파일을 읽으므로 반쯤 쓴 파일을 보이지 않게) */
async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

export function newToken(): string {
  return randomBytes(24).toString("base64url");
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

export const loadPeerSettings = async (dataDir: string): Promise<PeerSettings> => ({
  enabled: false,
  port: DEFAULT_PEER_PORT,
  ...(await readJson<Partial<PeerSettings>>(file(dataDir, "settings.json"), {})),
});
export const savePeerSettings = (dataDir: string, settings: PeerSettings) => writeJson(file(dataDir, "settings.json"), settings);

export const loadCardDraft = (dataDir: string): Promise<CardDraft> =>
  readJson<CardDraft>(file(dataDir, "card.json"), { name: "내 에이전트", description: "Pi Desktop Agent", skills: [] });
export const saveCardDraft = (dataDir: string, draft: CardDraft) => writeJson(file(dataDir, "card.json"), draft);

/** 상대에게 보이는 카드 */
export function publicCard(draft: CardDraft, address: string, version = "1"): AgentCard {
  return {
    protocolVersion: "0.3.0",
    name: draft.name,
    description: draft.description,
    url: `${address.replace(/\/+$/, "")}/a2a`,
    version,
    capabilities: { streaming: false },
    skills: draft.skills,
  };
}

export const loadPeers = (dataDir: string) => readJson<Peer[]>(file(dataDir, "peers.json"), []);
export const savePeers = (dataDir: string, peers: Peer[]) => writeJson(file(dataDir, "peers.json"), peers);

export const loadInbound = (dataDir: string) => readJson<InboundPairing[]>(file(dataDir, "pairing-in.json"), []);
export const saveInbound = (dataDir: string, list: InboundPairing[]) => writeJson(file(dataDir, "pairing-in.json"), list);
export const loadOutbound = (dataDir: string) => readJson<OutboundPairing[]>(file(dataDir, "pairing-out.json"), []);
export const saveOutbound = (dataDir: string, list: OutboundPairing[]) => writeJson(file(dataDir, "pairing-out.json"), list);

export async function appendInboundLog(dataDir: string, entry: InboundLog): Promise<void> {
  await mkdir(peersDir(dataDir), { recursive: true });
  await appendFile(file(dataDir, "inbound.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
}

export async function loadInboundLog(dataDir: string, limit = 100): Promise<InboundLog[]> {
  let text: string;
  try {
    text = await readFile(file(dataDir, "inbound.jsonl"), "utf8");
  } catch {
    return [];
  }
  const entries: InboundLog[] = [];
  for (const line of text.split("\n").slice(-limit - 1)) {
    try {
      if (line.trim()) entries.push(JSON.parse(line) as InboundLog);
    } catch {
      // 반쯤 쓴 줄은 건너뛴다
    }
  }
  return entries.slice(-limit);
}

/** 들어온 페어링 요청을 승인한다: 토큰을 발급하고 피어로 넣는다 */
export async function approveInbound(dataDir: string, requestId: string, now = new Date()): Promise<Peer> {
  const inbound = await loadInbound(dataDir);
  const request = inbound.find((r) => r.requestId === requestId && r.status === "pending");
  if (!request) throw new Error("그런 페어링 요청이 없거나 이미 처리됐다");
  const myToken = newToken();
  request.status = "approved";
  request.myToken = myToken;
  const peers = await loadPeers(dataDir);
  const peer: Peer = {
    id: newId("peer"),
    name: request.card.name,
    address: request.address,
    card: request.card,
    theirToken: request.theirToken,
    myToken,
    policy: { ...DEFAULT_POLICY },
    pairedAt: now.toISOString(),
  };
  await savePeers(dataDir, [...peers.filter((p) => p.address !== request.address), peer]);
  await saveInbound(dataDir, inbound);
  return peer;
}

export async function rejectInbound(dataDir: string, requestId: string): Promise<void> {
  const inbound = await loadInbound(dataDir);
  const request = inbound.find((r) => r.requestId === requestId);
  if (request) request.status = "rejected";
  await saveInbound(dataDir, inbound);
}

export async function removePeer(dataDir: string, id: string): Promise<void> {
  await savePeers(
    dataDir,
    (await loadPeers(dataDir)).filter((p) => p.id !== id),
  );
}

export async function updatePeerPolicy(dataDir: string, id: string, policy: PeerPolicy): Promise<void> {
  const peers = await loadPeers(dataDir);
  const peer = peers.find((p) => p.id === id);
  if (!peer) throw new Error("그런 피어가 없다");
  peer.policy = policy;
  await savePeers(dataDir, peers);
}

/** 이름이나 id로 피어를 찾는다 (모델이 이름으로 부르는 경우가 많다) */
export function findPeer(peers: Peer[], key: string): Peer | undefined {
  const k = key.trim().toLowerCase();
  return peers.find((p) => p.id === key) ?? peers.find((p) => p.name.toLowerCase() === k) ?? peers.find((p) => p.name.toLowerCase().includes(k));
}
