// TOML mínimo para leer `[mcp_servers.*]` de Codex (config.toml).
// Soporta SOLO: comentarios (# fuera de strings), tablas [a.b.c] con claves
// desnudas o "quoted", claves bare/quoted, strings básicos ("..." con escapes
// \" \\ \n \t) y literales ('...' crudos), arrays de valores escalares,
// enteros, booleanos e inline tables { k = v, k2 = v2 } (un nivel).
// NO soporta: arrays de tablas [[..]], multilínea, fechas, \uXXXX, floats
// con exponente completo (se leen como string → error de tipo al usar).
// Cualquier cosa no reconocida → error con línea (nunca lanza fuera de parse()).

export interface TomlParseResult { value: Record<string, unknown> | null; error?: string }

const isBareKeyChar = (c: string) => /[A-Za-z0-9_-]/.test(c);

interface Line { text: string; n: number }

export function parseToml(input: string): TomlParseResult {
  const root: Record<string, unknown> = {};
  let current: Record<string, unknown> = root;
  const lines: Line[] = [];
  // separa en líneas respetando strings (un # dentro de string corta comentario, no línea)
  input.split("\n").forEach((raw, i) => lines.push({ text: stripComment(raw).trim(), n: i + 1 }));
  for (const { text, n } of lines) {
    if (!text) continue;
    const table = /^\[([^\]]+)\]$/.exec(text);
    if (table) {
      const path = table[1].split(".").map((s) => s.trim()).map(unquoteKey);
      if (path.some((p) => p === "")) return { value: null, error: `línea ${n}: tabla con nombre vacío` };
      current = ensureTable(root, path);
      if ("__error" in current) return { value: null, error: (current as Record<string, unknown>).__error as string };
      continue;
    }
    const eq = findEq(text);
    if (eq === -1) return { value: null, error: `línea ${n}: se esperaba clave = valor o [tabla]` };
    const rawKey = text.slice(0, eq).trim();
    const key = unquoteKey(rawKey);
    if (!key) return { value: null, error: `línea ${n}: clave vacía` };
    const parsed = parseValue(text.slice(eq + 1).trim(), n);
    if ("error" in parsed) return { value: null, error: parsed.error };
    if (key in current) return { value: null, error: `línea ${n}: clave duplicada «${key}»` };
    current[key] = parsed.value;
  }
  return { value: root };
}

function stripComment(line: string): string {
  let inBasic = false, inLiteral = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inBasic) { if (c === "\\") i++; else if (c === '"') inBasic = false; continue; }
    if (inLiteral) { if (c === "'") inLiteral = false; continue; }
    if (c === '"') { inBasic = true; continue; }
    if (c === "'") { inLiteral = true; continue; }
    if (c === "#") return line.slice(0, i);
  }
  return line;
}

function findEq(text: string): number {
  let inBasic = false, inLiteral = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inBasic) { if (c === "\\") i++; else if (c === '"') inBasic = false; continue; }
    if (inLiteral) { if (c === "'") inLiteral = false; continue; }
    if (c === '"') { inBasic = true; continue; }
    if (c === "'") { inLiteral = true; continue; }
    if (c === "=") return i;
  }
  return -1;
}

function unquoteKey(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return unescapeBasic(s.slice(1, -1));
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  return [...s].every(isBareKeyChar) ? s : "";
}

function ensureTable(root: Record<string, unknown>, path: string[]): Record<string, unknown> {
  let cur = root;
  for (const part of path) {
    const next = cur[part];
    if (next === undefined) { const made = {}; cur[part] = made; cur = made; continue; }
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      return { __error: `tabla «${path.join(".")}» pisa un valor existente` };
    }
    cur = next as Record<string, unknown>;
  }
  return cur;
}

type ValueResult = { value: unknown } | { error: string };

function parseValue(text: string, n: number): ValueResult {
  if (text === "") return { error: `línea ${n}: valor vacío` };
  if (text === "true") return { value: true };
  if (text === "false") return { value: false };
  if (/^-?\d+$/.test(text)) return { value: parseInt(text, 10) };
  if (text.startsWith('"')) return parseBasicString(text, n);
  if (text.startsWith("'")) {
    if (text.length < 2 || !text.endsWith("'")) return { error: `línea ${n}: string literal sin cerrar` };
    return { value: text.slice(1, -1) };
  }
  if (text.startsWith("[")) return parseArray(text, n);
  if (text.startsWith("{")) return parseInlineTable(text, n);
  return { error: `línea ${n}: valor no reconocido «${text.slice(0, 40)}»` };
}

function unescapeBasic(s: string): string {
  return s.replace(/\\(["\\nrt])/g, (_m, c: string) => ({ "\"": '"', "\\": "\\", n: "\n", r: "\r", t: "\t" })[c] ?? c);
}

function parseBasicString(text: string, n: number): ValueResult {
  // encuentra el cierre respetando escapes
  let out = "", i = 1;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") { out += unescapeBasic(c + (text[i + 1] ?? "")); i++; continue; }
    if (c === '"') {
      const rest = text.slice(i + 1).trim();
      if (rest) return { error: `línea ${n}: basura tras el string` };
      return { value: out };
    }
    out += c;
  }
  return { error: `línea ${n}: string básico sin cerrar` };
}

function splitTopLevel(text: string, n: number): string[] | { error: string } {
  const parts: string[] = [];
  let depth = 0, inBasic = false, inLiteral = false, cur = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inBasic) { cur += c; if (c === "\\") { cur += text[i + 1] ?? ""; i++; } else if (c === '"') inBasic = false; continue; }
    if (inLiteral) { cur += c; if (c === "'") inLiteral = false; continue; }
    if (c === '"') { inBasic = true; cur += c; continue; }
    if (c === "'") { inLiteral = true; cur += c; continue; }
    if (c === "[" || c === "{") depth++;
    if (c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) { parts.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (depth !== 0) return { error: `línea ${n}: delimitadores desbalanceados` };
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function parseArray(text: string, n: number): ValueResult {
  if (!text.endsWith("]")) return { error: `línea ${n}: array sin cerrar` };
  const inner = text.slice(1, -1).trim();
  if (!inner) return { value: [] };
  const parts = splitTopLevel(inner, n);
  if ("error" in parts) return parts;
  const out: unknown[] = [];
  for (const p of parts) { const v = parseValue(p, n); if ("error" in v) return v; out.push(v.value); }
  return { value: out };
}

function parseInlineTable(text: string, n: number): ValueResult {
  if (!text.endsWith("}")) return { error: `línea ${n}: inline table sin cerrar` };
  const inner = text.slice(1, -1).trim();
  const obj: Record<string, unknown> = {};
  if (!inner) return { value: obj };
  const parts = splitTopLevel(inner, n);
  if ("error" in parts) return parts;
  for (const p of parts) {
    const eq = findEq(p);
    if (eq === -1) return { error: `línea ${n}: inline table: falta «=» en «${p.slice(0, 30)}»` };
    const key = unquoteKey(p.slice(0, eq).trim());
    if (!key) return { error: `línea ${n}: inline table: clave inválida` };
    const v = parseValue(p.slice(eq + 1).trim(), n);
    if ("error" in v) return v;
    obj[key] = v.value;
  }
  return { value: obj };
}
