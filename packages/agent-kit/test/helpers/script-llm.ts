import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * 정해 둔 순서대로 답하는 OpenAI 호환 스트리밍 서버. Ollama의 진단 API(/api/ps, /api/show)도 흉내 낸다.
 *
 * host-agent의 mock-llm은 "도구 결과 다음엔 항상 글"이라 한 실행 안에서 도구를 여러 번 부르는 상황
 * (제자리 돌기)을 만들 수 없다. 여기서는 요청이 올 때마다 다음 단계를 하나씩 꺼내 답한다.
 * 단계가 다 떨어지면 "끝"이라는 글로 답한다.
 */
export type ScriptStep = { tool: string; args: Record<string, unknown> } | { text: string };

export interface OllamaInfo {
  /** /api/ps의 context_length (서버가 실제로 연 창). 없으면 /api/ps가 빈 목록을 돌려준다 */
  contextLength?: number;
  /** /api/show의 capabilities (예: ["completion", "tools", "thinking"]) */
  capabilities?: string[];
}

export interface ScriptLlm {
  baseUrl: string;
  /** 받은 chat completions 요청 본문 */
  requests: Array<Record<string, unknown>>;
  /** 다음 실행에 쓸 단계를 바꾼다 */
  setScript(steps: ScriptStep[]): void;
  /**
   * 사용자 메시지가 match에 맞는 대화(예: 워커)는 따로 이 단계들로 답한다. 메인 세션과 워커가
   * 같은 서버에 동시에 요청해도 순서가 섞이지 않게 한다.
   */
  route(match: (userText: string) => boolean, steps: ScriptStep[]): void;
  close(): Promise<void>;
}

export async function startScriptLlm(model: string, ollama: OllamaInfo = {}): Promise<ScriptLlm> {
  const requests: Array<Record<string, unknown>> = [];
  let steps: ScriptStep[] = [];
  let routes: Array<{ match: (userText: string) => boolean; steps: ScriptStep[] }> = [];
  let callSeq = 0;

  const server: Server = createServer(async (req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/api/ps") {
      const models = ollama.contextLength ? [{ name: model, model, context_length: ollama.contextLength }] : [];
      json(200, { models });
      return;
    }
    if (req.method === "POST" && req.url === "/api/show") {
      json(200, { capabilities: ollama.capabilities ?? ["completion", "tools"] });
      return;
    }
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    requests.push(body);
    const userText = ((body.messages as Array<{ role?: string; content?: unknown }> | undefined) ?? [])
      .filter((m) => m.role === "user")
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
    const queue = routes.find((r) => r.match(userText))?.steps ?? steps;

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (delta: Record<string, unknown>, finish: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
      );
    const step = queue.shift() ?? { text: "끝" };
    if ("tool" in step) {
      const id = `call_${++callSeq}`;
      send({ role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name: step.tool, arguments: "" } }] });
      send({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(step.args) } }] });
      send({}, "tool_calls");
    } else {
      send({ role: "assistant", content: step.text });
      send({}, "stop");
    }
    res.write(
      `data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 0, model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    setScript: (next) => {
      steps = [...next];
    },
    route: (match, next) => {
      routes = [...routes, { match, steps: [...next] }];
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
