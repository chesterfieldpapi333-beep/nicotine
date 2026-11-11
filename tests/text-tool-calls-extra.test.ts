// Formatos adicionales del rescate de tool-calls en texto (fase 11b).
import { test, expect } from "bun:test";
import { parseTextToolCalls } from "../src/core/text-tool-calls.ts";

const known = new Set(["read", "edit", "bash"]);

test("fence array: múltiples llamadas en un solo bloque", () => {
  const r = parseTextToolCalls('prosa\n```json\n[{"name":"read","arguments":{"path":"a"}},{"name":"bash","arguments":{"command":"ls"}}]\n```\nfin', known);
  expect(r.calls.map((c) => c.function.name)).toEqual(["read", "bash"]);
});

test("XML <name>/<arguments>", () => {
  const r = parseTextToolCalls('<name>read</name><arguments>{"path":"package.json"}</arguments>', known);
  expect(r.calls.length).toBe(1);
  expect(JSON.parse(r.calls[0].function.arguments)).toEqual({ path: "package.json" });
  expect(r.remainingText).not.toContain("<name>");
});

test("Anthropic invoke con parameter tipado", () => {
  const text = '<invoke name="edit"><parameter name="path">src/a.ts</parameter><parameter name="count">3</parameter><parameter name="force">true</parameter></invoke>';
  const r = parseTextToolCalls(text, known);
  expect(r.calls.length).toBe(1);
  expect(JSON.parse(r.calls[0].function.arguments)).toEqual({ path: "src/a.ts", count: 3, force: true });
  expect(r.remainingText).not.toContain("<invoke");
});

test("MLF <function=...> con múltiples llamadas y prólogo", () => {
  const text = 'voy a leer\n<function=read><parameter=path>a.txt</parameter></function> y luego\n<function=bash><parameter=command>ls -la</parameter></function>\nhacerlo';
  const r = parseTextToolCalls(text, known);
  expect(r.calls.map((c) => c.function.name)).toEqual(["read", "bash"]);
  expect(JSON.parse(r.calls[1].function.arguments)).toEqual({ command: "ls -la" });
});

test("JSON desnudo al final (pretty-printed)", () => {
  const text = 'Voy a leer el archivo.\n{\n  "name": "read",\n  "arguments": {\n    "path": "x"\n  }\n}';
  const r = parseTextToolCalls(text, known);
  expect(r.calls.length).toBe(1);
  expect(r.remainingText).not.toContain('"name"');
});

test("alucinación de tool se descarta con knownTools", () => {
  const r = parseTextToolCalls('<tool_call>{"name":"fly_to_moon","arguments":{}}</tool_call>', known);
  expect(r.calls.length).toBe(0);
});
