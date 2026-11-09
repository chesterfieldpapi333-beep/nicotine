// Servidor LSP simulado para tests: framing Content-Length, responde a
// initialize, publica 2 diagnósticos al didOpen y responde shutdown/exit.
let buf = Buffer.alloc(0);
const send = (msg) => {
  const body = JSON.stringify({ jsonrpc: "2.0", ...msg });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
};
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const he = buf.indexOf("\r\n\r\n");
    if (he === -1) return;
    const header = buf.subarray(0, he).toString("latin1");
    const m = /content-length:\s*(\d+)/i.exec(header);
    const len = m ? Number(m[1]) : 0;
    if (buf.length < he + 4 + len) return;
    const body = buf.subarray(he + 4, he + 4 + len).toString("utf8");
    buf = buf.subarray(he + 4 + len);
    let msg;
    try { msg = JSON.parse(body); } catch { continue; }
    if (msg.method === "initialize") send({ id: msg.id, result: { capabilities: { textDocumentSync: 1 } } });
    else if (msg.method === "initialized" || msg.method === "exit") { if (msg.method === "exit") process.exit(0); }
    else if (msg.method === "textDocument/didOpen") {
      const uri = msg.params?.textDocument?.uri;
      send({ method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [
        { range: { start: { line: 0, character: 2 }, end: { line: 0, character: 8 } }, severity: 1, message: "error simulado: tipo no asignable", source: "mock-lsp", code: "T0001" },
        { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } }, severity: 2, message: "aviso simulado: variable sin usar", source: "mock-lsp" },
      ] } });
    } else if (msg.method === "shutdown") send({ id: msg.id, result: null });
  }
});
