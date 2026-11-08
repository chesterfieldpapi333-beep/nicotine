// Servidor MCP falso por stdio para tests. JSON-RPC 2.0 delimitado por \n.
// FAKE_MCP_MODE:
//   legacy     → server/discover responde -32601 (el cliente auto debe caer a initialize)
//   stateless  → server/discover responde ok (modo 2026-07-28)
//   slow       → nunca responde dentro del timeout (test de startup timeout)
//   resources  → además anuncia resources/list y resources/read
//   ladder     → rechaza initialize con 2025-11-25, acepta 2025-06-18 (test de escalera)
const mode = process.env.FAKE_MCP_MODE ?? "legacy";

type Json = any;
interface RpcMsg { id?: number; method?: string; params?: Json }

const tools: Json[] = [
  { name: "echo", description: "devuelve el texto dado", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "fail", description: "siempre falla", inputSchema: { type: "object", properties: {} } },
];

function reply(msg: Json) { process.stdout.write(JSON.stringify(msg) + "\n"); }
function errorReply(id: number | undefined, code: number, message: string) { reply({ jsonrpc: "2.0", id, error: { code, message } }); }
function resultReply(id: number | undefined, result: Json) { reply({ jsonrpc: "2.0", id, result }); }

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx: number;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg: RpcMsg;
    try { msg = JSON.parse(line) as RpcMsg; } catch { continue; }
    handle(msg);
  }
});
process.stdin.on("end", () => process.exit(0));

function handle(msg: RpcMsg) {
  const { id, method, params } = msg;
  if (method === "notifications/initialized") return; // notificación: sin respuesta
  if (mode === "slow") return; // silencio total
  switch (method) {
    case "server/discover": {
      if (mode === "legacy") return errorReply(id, -32601, "Method not found");
      if (mode === "ladder") return errorReply(id, -32601, "Method not found");
      return resultReply(id, { supportedVersions: ["2026-07-28"], capabilities: { tools: {}, resources: {} }, serverInfo: { name: "fake-mcp", version: "0.0.0" } });
    }
    case "initialize": {
      if (mode === "ladder" && params?.protocolVersion !== "2025-06-18") {
        return errorReply(id, -32602, `Unsupported protocol version: ${params?.protocolVersion}`);
      }
      return resultReply(id, { protocolVersion: params?.protocolVersion ?? "2025-11-25", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "fake-mcp", version: "0.0.0" } });
    }
    case "tools/list":
      return resultReply(id, { tools });
    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (name === "echo") return resultReply(id, { content: [{ type: "text", text: `echo:${args.text ?? ""}` }] });
      if (name === "fail") return resultReply(id, { content: [{ type: "text", text: "boom" }], isError: true });
      return errorReply(id, -32602, `unknown tool ${name}`);
    }
    case "resources/list":
      if (mode === "resources" || mode === "stateless") {
        return resultReply(id, { resources: [{ uri: "fake://doc", name: "doc-falso", description: "recurso de prueba" }] });
      }
      return errorReply(id, -32601, "Method not found");
    case "resources/read":
      if (params?.uri === "fake://doc") return resultReply(id, { contents: [{ uri: "fake://doc", text: "contenido-del-recurso-fake" }] });
      return errorReply(id, -32602, "unknown uri");
    default:
      return errorReply(id, -32601, `Method not found: ${method}`);
  }
}
