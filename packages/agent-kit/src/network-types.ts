/**
 * 네트워크(피어) 화면이 주고받는 모양. 토큰은 화면으로 보내지 않는다.
 * 렌더러도 쓰므로 node 모듈을 import하지 않는다.
 */
import type { AgentCard, CardDraft, InboundLog, PeerPolicy, PeerSettings } from "../extensions/peers/types";

export type { AgentCard, CardDraft, InboundLog, PeerPolicy, PeerSettings };

export interface PeerView {
  id: string;
  name: string;
  address: string;
  description?: string;
  skills: string[];
  policy: PeerPolicy;
  pairedAt: string;
}

export interface NetworkState {
  settings: PeerSettings;
  /** 수신 서버가 실제로 카드를 내주는가 (이 PC에서 확인) */
  listening: boolean;
  card: CardDraft;
  peers: PeerView[];
  inbound: Array<{ requestId: string; name: string; description: string; address: string; createdAt: string }>;
  outbound: Array<{ requestId: string; name: string; address: string; createdAt: string; status: "pending" | "rejected" }>;
  log: InboundLog[];
  /** 피어가 맡겨 승인을 기다리는 작업 */
  taskRequests: Array<{ id: string; peerName: string; title: string; instruction: string; startedAt: string }>;
  /** 이 PC의 같은 네트워크 주소 후보 (내 주소 고르기) */
  lanAddresses: string[];
}
