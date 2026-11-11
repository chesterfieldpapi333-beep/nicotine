// Escáner conservador de subcomandos para el chequeo de permisos de `bash`.
// NO es un parser POSIX completo — es una heurística DELIBERADAMENTE simple:
//   - divide en los operadores de nivel superior: &&  ||  ;  |  salto de línea
//   - respeta comillas simples, dobles y de backtick, y escapes con backslash
//   - reconoce $( … ) y `…` y los analiza recursivamente como segmentos propios
//   - ante cualquier duda (heredoc `<<`, balanceo imposible, demasiados segmentos)
//     devuelve el comando completo como único segmento (como hoy)
// Cada segmento se evalúa contra las reglas por separado y se combina
// deny > ask > allow (igual que checkAll) — nunca amplía permisos.

const MAX_SEGMENTS = 60;

export function shellSegments(command: string): string[] {
  const segments: string[] = [];
  const t = command.trim();
  if (!t) return [];
  try {
    const stripped = stripHeredocs(t);
    split(stripped, 0, segments);
  } catch {
    return [t]; // cualquier anomalía → comportamiento de hoy
  }
  const out = segments.map((s) => s.trim()).filter(Boolean).slice(0, MAX_SEGMENTS);
  // si el split no produjo nada útil, el comando entero
  return out.length ? out : [t];
}

/** Lee el cuerpo balanceado de una sustitución $(…) que empieza en `open` (índice del '('). Devuelve [cuerpo, índiceTrasCierre] o null. */
function readBalanced(s: string, open: number): [string, number] | null {
  let depth = 0;
  let quote: "" | "'" | '"' = "";
  for (let j = open; j < s.length; j++) {
    const ch = s[j];
    if (quote === "'") { if (ch === "'") quote = ""; continue; }
    if (quote === '"') { if (ch === "\\") { j++; continue; } if (ch === '"') quote = ""; continue; }
    if (ch === "\\") { j++; continue; }
    if (ch === "'") { quote = "'"; continue; }
    if (ch === '"') { quote = '"'; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return [s.slice(open + 1, j), j + 1];
    }
  }
  return null;
}

/** Inicio de heredoc real (operador <<, con <<-> opcional, fuera de comillas). */
const HEREDOC_START = /<<(-)?[ \t]*(['"]?)([A-Za-z0-9_][A-Za-z0-9_-]*)\2/;

/** Detecta inicios de heredoc en UNA línea, ignorando los << dentro de comillas. */
function heredocStartsOutsideQuotes(line: string): { delim: string; dash: boolean }[] {
  const out: { delim: string; dash: boolean }[] = [];
  let i = 0;
  let quote: "" | "'" | '"' = "";
  while (i < line.length) {
    const ch = line[i];
    if (quote === "'") { if (ch === "'") quote = ""; i++; continue; }
    if (quote === '"') { if (ch === "\\") { i += 2; continue; } if (ch === '"') quote = ""; i++; continue; }
    if (ch === "\\") { i += 2; continue; }
    if (ch === "'") { quote = "'"; i++; continue; }
    if (ch === '"') { quote = '"'; i++; continue; }
    if (ch === "<" && line[i + 1] === "<" && line[i + 2] !== "<") {
      const m = HEREDOC_START.exec(line.slice(i));
      if (m) {
        out.push({ delim: m[3], dash: m[1] === "-" });
        i += m[0].length;
        continue;
      }
    }
    i++;
  }
  return out;
}

/**
 * Elimina cuerpos de heredoc y líneas delimitadoras del texto a segmentar.
 * Los cuerpos NO son comandos ejecutados: no deben ocultar ni inventar segmentos.
 * Ante cualquier anomalía (delimitador no encontrado) → devuelve el input tal cual
 * (comportamiento conservador previo).
 */
function stripHeredocs(input: string): string {
  const lines = input.split("\n");
  const skip = new Array<boolean>(lines.length).fill(false);
  let touched = false;
  for (let i = 0; i < lines.length; i++) {
    if (skip[i]) continue;
    const hs = heredocStartsOutsideQuotes(lines[i]);
    if (!hs.length) continue;
    let cursor = i + 1;
    for (const h of hs) {
      let j = cursor;
      let closedAt = -1;
      while (j < lines.length) {
        const bare = h.dash ? lines[j].replace(/^\t+/, "") : lines[j];
        if (bare === h.delim) { closedAt = j; break; }
        j++;
      }
      if (closedAt === -1) return input; // sin cierre → conservador
      for (let k = cursor; k <= closedAt; k++) skip[k] = true;
      touched = true;
      cursor = closedAt + 1;
    }
  }
  if (!touched) return input;
  return lines.filter((_, idx) => !skip[idx]).join("\n");
}

const MAX_DEPTH = 4;

function split(s: string, depth: number, out: string[]): void {
  if (depth > MAX_DEPTH) { out.push(s); return; }
  // los heredocs ya fueron eliminados por stripHeredocs() antes de segmentar

  let cur = "";
  const push = () => { const t = cur.trim(); if (t) out.push(t); cur = ""; };
  let quote: "" | "'" | '"' | "`" = "";
  let backtickStart = -1;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];

    if (quote === "'") { cur += ch; if (ch === "'") quote = ""; continue; }

    if (quote === "`") {
      if (ch === "\\") { cur += ch + (s[++i] ?? ""); continue; }
      if (ch === "`") {
        // cierra el cuerpo; analízalo como segmento propio
        const body = s.slice(backtickStart + 1, i);
        if (body.trim()) split(body, depth + 1, out);
        cur += "'…'";
        quote = "";
        backtickStart = -1;
        continue;
      }
      cur += ch;
      continue;
    }

    if (quote === '"') {
      if (ch === "\\") { cur += ch + (s[++i] ?? ""); continue; }
      if (ch === '"') { quote = ""; cur += ch; continue; }
      if (ch === "`") { backtickStart = i; quote = "`"; cur += ch; continue; }
      if (ch === "$" && s[i + 1] === "(") {
        const r = readBalanced(s, i + 1);
        if (!r) { out.push(s); return; } // balanceo imposible → conservador
        const [body, next] = r;
        if (body.trim()) split(body, depth + 1, out);
        cur += "$…";
        i = next - 1;
        continue;
      }
      cur += ch;
      continue;
    }

    // sin comillas
    if (ch === "\\") { cur += ch + (s[++i] ?? ""); continue; }
    if (ch === "'") { quote = "'"; cur += ch; continue; }
    if (ch === '"') { quote = '"'; cur += ch; continue; }
    if (ch === "`") { backtickStart = i; quote = "`"; cur += ch; continue; }
    if (ch === "$" && s[i + 1] === "(") {
      const r = readBalanced(s, i + 1);
      if (!r) { out.push(s); return; }
      const [body, next] = r;
      if (body.trim()) split(body, depth + 1, out);
      cur += "$…";
      i = next - 1;
      continue;
    }
    if (ch === "&" && s[i + 1] === "&") { push(); i++; continue; }
    if (ch === "|" && s[i + 1] === "|") { push(); i++; continue; }
    if (ch === "|" || ch === ";" || ch === "\n") { push(); continue; }
    cur += ch;
  }
  // heredoc ya manejado arriba; si quedó una comilla sin cerrar → conservador
  if (quote !== "") { out.push(s); return; }
  push();
}
