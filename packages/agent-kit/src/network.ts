import { networkInterfaces } from "node:os";
import { fetchCard, checkOutbound, requestPairing } from "../extensions/peers/client";
import {
  approveInbound,
  loadCardDraft,
  loadInbound,
  loadInboundLog,
  loadOutbound,
  loadPeers,
  loadPeerSettings,
  rejectInbound,
  removePeer,
  saveCardDraft,
  savePeerSettings,
  updatePeerPolicy,
  type CardDraft,
  type PeerPolicy,
  type PeerSettings,
} from "../extensions/peers/store";
import { loadTasks, tasksDir } from "../extensions/tasks/store";
import type { AgentCard, NetworkState } from "./network-types";

/**
 * 네트워크(피어) 화면의 데이터 쪽 (설계 DESIGN-AGENT.md §4 "에이전트 네트워크"). 그 호스트의 데몬이 app-api로 부른다 (D4). 상태는 agent-kit 상태 폴더의 peers/에 있고,
 * 수신 서버는 스케줄러 세션이 설정을 읽어 띄운다. 여기서는 설정·카드·페어링·피어를 고치고 화면에 보일 모양을 만든다.
 */

/** 같은 네트워크에서 이 PC를 부를 수 있는 IPv4 주소들 (사설 대역 먼저) */
export function lanAddresses(port: number): string[] {
  const found: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) if (net.family === "IPv4" && !net.internal) found.push(net.address);
  }
  const privateFirst = (ip: string) => (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) ? 0 : 1);
  return found.sort((a, b) => privateFirst(a) - privateFirst(b)).map((ip) => `http://${ip}:${port}`);
}

async function listening(port: number): Promise<boolean> {
  try {
    await fetchCard(`http://127.0.0.1:${port}`);
    return true;
  } catch {
    return false;
  }
}

export async function networkState(dataDir: string): Promise<NetworkState> {
  const settings = await loadPeerSettings(dataDir);
  const [card, peers, inbound, outbound, log, up, tasks] = await Promise.all([
    loadCardDraft(dataDir),
    loadPeers(dataDir),
    loadInbound(dataDir),
    loadOutbound(dataDir),
    loadInboundLog(dataDir, 30),
    settings.enabled ? listening(settings.port) : Promise.resolve(false),
    loadTasks(tasksDir(dataDir)),
  ]);
  return {
    settings,
    listening: up,
    card,
    // 토큰은 화면으로 보내지 않는다
    peers: peers.map((p) => ({
      id: p.id,
      name: p.name,
      address: p.address,
      ...(p.card?.description ? { description: p.card.description } : {}),
      skills: p.card?.skills.map((s) => s.name) ?? [],
      policy: p.policy,
      pairedAt: p.pairedAt,
    })),
    inbound: inbound
      .filter((r) => r.status === "pending")
      .map((r) => ({ requestId: r.requestId, name: r.card.name, description: r.card.description, address: r.address, createdAt: r.createdAt })),
    outbound: outbound.map((r) => ({ requestId: r.requestId, name: r.card?.name ?? r.address, address: r.address, createdAt: r.createdAt, status: r.status })),
    log: log.reverse(),
    taskRequests: tasks
      .filter((t) => t.origin === "peer-in" && t.approval === "pending" && t.status === "waiting")
      .map((t) => ({ id: t.id, peerName: t.peer?.name ?? "?", title: t.title, instruction: t.instruction, startedAt: t.startedAt })),
    lanAddresses: lanAddresses(settings.port),
  };
}

/** 수신 설정. 켜는데 내 주소가 없으면 같은 네트워크 주소로 채운다 */
export async function setNetworkSettings(dataDir: string, next: PeerSettings): Promise<void> {
  const port = Number.isInteger(next.port) && next.port > 0 && next.port < 65536 ? next.port : 7811;
  const advertise = next.advertise?.trim() || (next.enabled ? lanAddresses(port)[0] : undefined);
  await savePeerSettings(dataDir, { enabled: next.enabled, port, ...(advertise ? { advertise } : {}) });
}

export function saveCard(dataDir: string, draft: CardDraft): Promise<void> {
  const name = draft.name.trim();
  if (!name) throw new Error("카드 이름이 필요합니다");
  return saveCardDraft(dataDir, {
    name,
    description: draft.description.trim(),
    skills: draft.skills.filter((s) => s.name.trim()).map((s, i) => ({ ...s, id: s.id || `skill-${i + 1}`, name: s.name.trim(), description: s.description.trim() })),
  });
}

export const previewPeer = (address: string): Promise<AgentCard> => fetchCard(address);
export const pairWith = (dataDir: string, address: string) => requestPairing(dataDir, address);
export const checkPairings = (dataDir: string) => checkOutbound(dataDir);
export const approvePairing = (dataDir: string, requestId: string) => approveInbound(dataDir, requestId).then(() => undefined);
export const rejectPairing = (dataDir: string, requestId: string) => rejectInbound(dataDir, requestId);
export const forgetPeer = (dataDir: string, id: string) => removePeer(dataDir, id);
export const setPeerPolicy = (dataDir: string, id: string, policy: PeerPolicy) =>
  updatePeerPolicy(dataDir, id, {
    question: policy.question === "deny" ? "deny" : "auto",
    task: policy.task === "deny" ? "deny" : "ask",
    dailyLimit: Math.max(0, Math.floor(policy.dailyLimit)) || 0,
  });
