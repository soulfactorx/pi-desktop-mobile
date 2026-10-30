// 테스트용 최소 MCP 서버 (stdio, 줄마다 JSON-RPC). 도구 두 개: echo(받은 글을 돌려줌), add(두 수를 더함)
import { createInterface } from "node:readline";

const tools = [
  { name: "echo", description: "받은 글을 그대로 돌려준다", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "add", description: "두 수를 더한다", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } },
];

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.id === undefined) return;
  switch (request.method) {
    case "initialize":
      send({ id: request.id, result: { protocolVersion: request.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1.0.0" } } });
      break;
    case "tools/list":
      send({ id: request.id, result: { tools } });
      break;
    case "tools/call": {
      const { name, arguments: args = {} } = request.params ?? {};
      const text = name === "echo" ? `echo: ${args.text}` : name === "add" ? String(Number(args.a) + Number(args.b)) : "?";
      send({ id: request.id, result: { content: [{ type: "text", text }] } });
      break;
    }
    case "ping":
      send({ id: request.id, result: {} });
      break;
    default:
      send({ id: request.id, error: { code: -32601, message: `없는 메서드: ${request.method}` } });
  }
});
