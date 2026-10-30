import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { A2A_PATH, agentReply, CARD_PATH, isCard, MAX_HOPS, PAIR_PATH, PAIR_STATUS_PATH, parseMessageSend, rpcError, taskResult } from "./protocol";
import { cancelPeerTask, findPeerTask, receivePeerTask, taskView } from "./tasks";
import {
  appendInboundLog,
  loadCardDraft,
  loadInbound,
  loadInboundLog,
  loadPeers,
  loadPeerSettings,
  newId,
  publicCard,
  saveInbound,
  type InboundLog,
  type Peer,
} from "./store";

/**
 * 피어 수신 서버 (설계 DESIGN-AGENT.md §4 "에이전트 네트워크"). 스케줄러 세션이 띄운다.
 *
 * - 카드는 인증 없이 보인다 (카드만 공개, 지식은 공개하지 않는다)
 * - 페어링 요청은 쌓아 두기만 하고, 사람이 앱에서 승인해야 피어가 된다. 요청자는 /pair/status로 결과를 가져간다
 * - 질문은 피어 토큰으로만 받고, 피어 정책·하루 상한·홉 상한을 지난 뒤 answer로 넘긴다
 * - 작업(taskType task)은 "승인 기다림" 작업 기록으로만 남긴다. 사람이 앱에서 승인해야 스케줄러가 시작한다.
 *   맡긴 쪽은 tasks/get으로 상태·결과를, tasks/cancel로 취소를 한다 (자기가 맡긴 작업만 보인다)
 */

export interface PeerServerOptions {
  dataDir: string;
  /** 질문에 답한다 (도구 없는 워커). 던지면 오류로 답한다 */
  answer: (question: string, peer: Peer) => Promise<string>;
  /** 받은 작업의 워커를 멈춘다 (스케줄러가 돌리는 중일 때). 멈출 것이 없으면 false */
  abortTask?: (id: string) => boolean;
  /** 이 에이전트의 이름 (홉 확인). 기본은 카드 이름 */
  selfName?: () => Promise<string>;
  now?: () => Date;
}

const MAX_BODY = 64 * 1024;
const MAX_PENDING = 20;

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("요청이 너무 크다"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"));
      } catch {
        reject(new Error("JSON이 아니다"));
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

const sameToken = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function peerRequestHandler(options: PeerServerOptions) {
  const now = options.now ?? (() => new Date());
  const { dataDir } = options;

  /** 이 에이전트를 부르는 주소 (요청의 Host로). advertise가 있으면 그것 */
  const selfAddress = async (req: IncomingMessage) => (await loadPeerSettings(dataDir)).advertise ?? `http://${req.headers.host ?? "localhost"}`;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? "/").split("?")[0];
    try {
      if (req.method === "GET" && path === CARD_PATH) {
        send(res, 200, publicCard(await loadCardDraft(dataDir), await selfAddress(req)));
        return;
      }
      if (req.method !== "POST") {
        send(res, 404, { error: "없는 주소" });
        return;
      }
      const body = await readBody(req);

      if (path === PAIR_PATH) {
        const request = body as { card?: unknown; address?: unknown; token?: unknown };
        if (!isCard(request?.card) || typeof request.address !== "string" || typeof request.token !== "string" || request.token.length < 16) {
          send(res, 400, { error: "카드·주소·토큰이 필요하다" });
          return;
        }
        const inbound = await loadInbound(dataDir);
        if (inbound.filter((r) => r.status === "pending").length >= MAX_PENDING) {
          send(res, 429, { error: "기다리는 페어링 요청이 너무 많다" });
          return;
        }
        const requestId = newId("pair");
        inbound.push({ requestId, card: request.card, address: request.address, theirToken: request.token, createdAt: now().toISOString(), status: "pending" });
        await saveInbound(dataDir, inbound);
        send(res, 202, { requestId, status: "pending" });
        return;
      }

      if (path === PAIR_STATUS_PATH) {
        const request = body as { requestId?: unknown; token?: unknown };
        const found = (await loadInbound(dataDir)).find(
          (r) => r.requestId === request?.requestId && typeof request.token === "string" && sameToken(r.theirToken, request.token),
        );
        if (!found) {
          send(res, 404, { error: "그런 요청이 없다" });
          return;
        }
        if (found.status === "approved") {
          send(res, 200, { status: "approved", token: found.myToken, card: publicCard(await loadCardDraft(dataDir), await selfAddress(req)) });
        } else {
          send(res, 200, { status: found.status });
        }
        return;
      }

      if (path === A2A_PATH) {
        const id = (body as { id?: unknown })?.id ?? null;
        const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1]?.trim() ?? "";
        const peer = bearer ? (await loadPeers(dataDir)).find((p) => sameToken(p.myToken, bearer)) : undefined;
        if (!peer) {
          send(res, 401, rpcError(id, -32001, "페어링된 에이전트만 부를 수 있다"));
          return;
        }
        const method = (body as { method?: unknown })?.method;
        if (method === "tasks/get" || method === "tasks/cancel") {
          const taskId = (body as { params?: { id?: unknown } })?.params?.id;
          const record = typeof taskId === "string" ? await findPeerTask(dataDir, peer.id, taskId) : undefined;
          if (!record) {
            send(res, 200, rpcError(id, -32006, "그런 작업이 없다"));
            return;
          }
          const current = method === "tasks/cancel" ? await cancelPeerTask(dataDir, record, options.abortTask ?? (() => false), now()) : record;
          send(res, 200, taskResult(id, taskView(current)));
          return;
        }
        const message = parseMessageSend(body);
        if (!message) {
          send(res, 400, rpcError(id, -32602, "message/send(글)·tasks/get·tasks/cancel만 받는다"));
          return;
        }
        const log = (status: InboundLog["status"], detail?: string) =>
          appendInboundLog(dataDir, {
            at: now().toISOString(),
            peerId: peer.id,
            peerName: peer.name,
            question: message.text.slice(0, 500),
            status,
            ...(detail ? { detail } : {}),
          });
        const isTask = message.taskType === "task";
        if (isTask ? peer.policy.task === "deny" : peer.policy.question === "deny") {
          await log("denied");
          send(res, 200, rpcError(id, -32003, isTask ? "이 에이전트는 지금 작업을 받지 않는다" : "이 에이전트는 지금 질문을 받지 않는다"));
          return;
        }
        const today = now().toISOString().slice(0, 10);
        const usedToday = (await loadInboundLog(dataDir, 1000)).filter((e) => e.peerId === peer.id && (e.status === "answered" || e.status === "task") && e.at.startsWith(today)).length;
        if (usedToday >= peer.policy.dailyLimit) {
          await log("limit");
          send(res, 200, rpcError(id, -32004, `오늘 받을 수 있는 질문(${peer.policy.dailyLimit}개)을 다 썼다`));
          return;
        }
        const self = options.selfName ? await options.selfName() : (await loadCardDraft(dataDir)).name;
        if (message.callChain.length >= MAX_HOPS || message.callChain.includes(self)) {
          await log("loop");
          send(res, 200, rpcError(id, -32005, "에이전트를 너무 여러 번 거친 질문이라 답하지 않는다"));
          return;
        }
        if (isTask) {
          const record = await receivePeerTask(dataDir, peer, message.title ?? "맡긴 작업", message.text, now());
          await log("task", record.id);
          send(res, 200, taskResult(id, taskView(record)));
          return;
        }
        try {
          const text = await options.answer(message.text, peer);
          await log("answered");
          send(res, 200, agentReply(id, text));
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          await log("error", detail.slice(0, 200));
          send(res, 200, rpcError(id, -32000, `답하지 못했다: ${detail}`));
        }
        return;
      }
      send(res, 404, { error: "없는 주소" });
    } catch (error) {
      send(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  };
}

/** 서버를 띄운다. 포트가 쓰이고 있으면 오류 */
export function startPeerServer(options: PeerServerOptions, port: number, host = "0.0.0.0"): Promise<Server> {
  const handler = peerRequestHandler(options);
  const server = createServer((req, res) => void handler(req, res));
  // 질문 하나에 워커가 몇 분 걸릴 수 있다
  server.requestTimeout = 6 * 60 * 1000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}
