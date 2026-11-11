// C3 — semantic action stream: etiqueta de fase derivada del tool_start.
import { test, expect } from "bun:test";
import { actionLabelFor } from "../src/ui/action-stream.js";

test("mapeo de herramientas conocidas", () => {
  expect(actionLabelFor("read")).toBe("analizando");
  expect(actionLabelFor("write")).toBe("editando");
  expect(actionLabelFor("bash")).toBe("ejecutando comando");
  expect(actionLabelFor("grep")).toBe("buscando en el código");
  expect(actionLabelFor("webfetch")).toBe("buscando en la web");
});

test("detalles del argumento cuando existen", () => {
  expect(actionLabelFor("bash", { command: "ls -la   /tmp" })).toBe("ejecutando comando «ls -la /tmp»");
  expect(actionLabelFor("edit", { path: "/home/user/nicotine/src/core/loop.ts" })).toBe("editando loop.ts");
  expect(actionLabelFor("grep", { pattern: "permission" })).toBe("buscando en el código «permission»");
  expect(actionLabelFor("read", { path: "docs/parity.md" })).toBe("analizando parity.md");
});

test("herramienta desconocida cae al genérico", () => {
  expect(actionLabelFor("mcp__foo__bar")).toBe("ejecutando mcp__foo__bar");
});

test("saltos de línea en el comando se colapsan", () => {
  expect(actionLabelFor("bash", { command: "npm test\n--coverage" })).toBe("ejecutando comando «npm test --coverage»");
});
