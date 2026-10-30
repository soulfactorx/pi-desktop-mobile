/**
 * 피어 상태의 모양. 앱 화면(렌더러)도 쓰므로 node 모듈을 import하지 않는다 (파일 읽기·쓰기는 store.ts).
 */

export interface PeerSettings {
  /** 수신 서버를 켤지. 기본 꺼짐 (켜야 다른 에이전트가 카드를 보고 페어링을 요청할 수 있다) */
  enabled: boolean;
  port: number;
  /** 상대에게 알려 줄 내 주소 (예: http://192.168.0.10:7811). 앱이 같은 네트워크 주소로 채운다 */
  advertise?: string;
}

export interface CardSkill {
  id: string;
  name: string;
  description: string;
  tags?: string[];
}

/** A2A AgentCard에서 쓰는 부분 */
export interface AgentCard {
  protocolVersion: string;
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: { streaming: boolean };
  skills: CardSkill[];
}

export interface PeerPolicy {
  /** 작업 맡기기를 받을지 (ask: 받아서 사람이 승인하면 시작, deny: 받지 않음). 없으면 ask */
  task?: "ask" | "deny";
  /** 질문에 답할지 */
  question: "auto" | "deny";
  /** 하루에 받을 질문 수 */
  dailyLimit: number;
}

export interface Peer {
  id: string;
  name: string;
  /** 상대 주소 (http://host:port) */
  address: string;
  card?: AgentCard;
  /** 내가 상대를 부를 때 쓰는 토큰 (상대가 발급) */
  theirToken: string;
  /** 상대가 나를 부를 때 쓰는 토큰 (내가 발급) */
  myToken: string;
  policy: PeerPolicy;
  pairedAt: string;
}

/** 나에게 온 페어링 요청 */
export interface InboundPairing {
  requestId: string;
  card: AgentCard;
  address: string;
  theirToken: string;
  createdAt: string;
  status: "pending" | "approved" | "rejected";
  /** 승인할 때 발급한 토큰 */
  myToken?: string;
}

/** 내가 보낸 페어링 요청 (상대가 승인하면 피어가 된다) */
export interface OutboundPairing {
  requestId: string;
  address: string;
  card?: AgentCard;
  myToken: string;
  createdAt: string;
  status: "pending" | "rejected";
}

export interface InboundLog {
  at: string;
  peerId: string;
  peerName: string;
  question: string;
  /** task: 작업 맡기기를 받아 승인 대기로 남김 (detail은 작업 id) */
  status: "answered" | "task" | "denied" | "limit" | "loop" | "error";
  detail?: string;
}

/** 내 카드의 사람이 고치는 부분 (이름·설명·스킬). url·버전은 내보낼 때 채운다 */
export interface CardDraft {
  name: string;
  description: string;
  skills: CardSkill[];
}
