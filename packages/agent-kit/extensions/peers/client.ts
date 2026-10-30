import { A2A_PATH, CARD_PATH, isCard, messageSendRequest, PAIR_PATH, PAIR_STATUS_PATH, replyText } from "./protocol";
import {
  DEFAULT_POLICY,
  loadCardDraft,
  loadOutbound,
  loadPeers,
  loadPeerSettings,
  newId,
  newToken,
  publicCard,
  saveOutbound,
  savePeers,
  type AgentCard,
  type Peer,
} from "./store";

/**
 * 다른 에이전트를 부르는 쪽 (카드 보기, 페어링 요청·결과 가져오기, 질문하기).
 * 앱(페어링 화면)과 peers 확장(ask_peer, 스케줄러의 페어링 결과 확인)이 함께 쓴다.
 */

/** 상대에게 닿지 않을 때(꺼짐·주소·방화벽) 읽을 수 있는 오류로 바꾼다 */
async function reach(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "응답이 없다" : "연결하지 못했다";
    throw new Error(`상대(${new URL(url).host})에 ${reason}. 주소·포트, 상대가 받기를 켰는지, 방화벽을 확인하라`);
  }
}

async function postJson(url: string, body: unknown, options: { token?: string; timeoutMs?: number } = {}): Promise<{ status: number; body: unknown }> {
  const response = await reach(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

export async function fetchCard(address: string): Promise<AgentCard> {
  const response = await reach(`${address}${CARD_PATH}`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`카드를 받지 못했다 (${response.status})`);
  const card = (await response.json()) as unknown;
  if (!isCard(card)) throw new Error("에이전트 카드가 아니다");
  return card;
}

/** 내 주소 (상대가 나를 부를 곳). 설정에 없으면 페어링할 수 없다 */
async function myAddress(dataDir: string): Promise<string> {
  const settings = await loadPeerSettings(dataDir);
  if (!settings.advertise) throw new Error("내 주소가 정해지지 않았다. 네트워크 설정에서 수신을 켜고 주소를 확인하라");
  return settings.advertise;
}

/** 페어링을 요청한다. 상대가 승인하면 checkOutbound가 피어로 넣는다 */
export async function requestPairing(dataDir: string, address: string, now = new Date()): Promise<string> {
  const card = await fetchCard(address);
  const me = await myAddress(dataDir);
  const myToken = newToken();
  const { status, body } = await postJson(`${address}${PAIR_PATH}`, { card: publicCard(await loadCardDraft(dataDir), me), address: me, token: myToken });
  const requestId = (body as { requestId?: unknown })?.requestId;
  if (status !== 202 || typeof requestId !== "string") throw new Error(`페어링 요청을 받지 않았다: ${JSON.stringify(body).slice(0, 200)}`);
  const outbound = await loadOutbound(dataDir);
  outbound.push({ requestId, address, card, myToken, createdAt: now.toISOString(), status: "pending" });
  await saveOutbound(dataDir, outbound);
  return requestId;
}

/**
 * 보낸 페어링 요청의 결과를 가져온다. 승인된 것은 피어로 넣고 목록에서 뺀다. 새로 맺어진 피어 이름들을 돌려준다.
 * 상대가 꺼져 있으면 다음에 다시 본다.
 */
export async function checkOutbound(dataDir: string, now = new Date()): Promise<string[]> {
  const outbound = await loadOutbound(dataDir);
  const paired: string[] = [];
  const keep = [];
  let changed = false;
  for (const request of outbound) {
    if (request.status !== "pending") {
      keep.push(request);
      continue;
    }
    try {
      const { status, body } = await postJson(`${request.address}${PAIR_STATUS_PATH}`, { requestId: request.requestId, token: request.myToken });
      const result = body as { status?: string; token?: unknown; card?: unknown };
      if (status === 200 && result.status === "approved" && typeof result.token === "string") {
        const card = isCard(result.card) ? result.card : request.card;
        const peers = (await loadPeers(dataDir)).filter((p) => p.address !== request.address);
        const peer: Peer = {
          id: newId("peer"),
          name: card?.name ?? request.address,
          address: request.address,
          ...(card ? { card } : {}),
          theirToken: result.token,
          myToken: request.myToken,
          policy: { ...DEFAULT_POLICY },
          pairedAt: now.toISOString(),
        };
        await savePeers(dataDir, [...peers, peer]);
        paired.push(peer.name);
        changed = true;
        continue;
      }
      if (status === 200 && result.status === "rejected") {
        keep.push({ ...request, status: "rejected" as const });
        changed = true;
        continue;
      }
      if (status === 404) {
        // 상대가 요청을 지웠다
        changed = true;
        continue;
      }
    } catch {
      // 상대가 꺼져 있다. 다음에 다시 본다
    }
    keep.push(request);
  }
  if (changed) await saveOutbound(dataDir, keep);
  return paired;
}

/** 피어에게 질문하고 답을 받는다. callChain은 지금까지 거친 에이전트 이름 (홉 제한) */
export async function askPeer(peer: Peer, question: string, callChain: string[], timeoutMs = 5 * 60_000): Promise<string> {
  const id = newId("q");
  const { status, body } = await postJson(`${peer.address}${A2A_PATH}`, messageSendRequest(id, question, { callChain, taskType: "question" }), {
    token: peer.theirToken,
    timeoutMs,
  });
  if (status === 401) throw new Error(`${peer.name}이(가) 페어링을 끊었다. 다시 페어링해야 한다`);
  return replyText(body);
}

/** 피어의 A2A 주소로 JSON-RPC를 보내고 응답 본문을 돌려준다 (작업 맡기기·상태·취소) */
export async function peerRpc(peer: Peer, body: unknown, timeoutMs = 30_000): Promise<unknown> {
  const { status, body: reply } = await postJson(`${peer.address}${A2A_PATH}`, body, { token: peer.theirToken, timeoutMs });
  if (status === 401) throw new Error(`${peer.name}이(가) 페어링을 끊었다. 다시 페어링해야 한다`);
  return reply;
}
