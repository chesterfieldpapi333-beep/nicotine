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
    split(t, 0, segments);
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

const MAX_DEPTH = 4;

function split(s: string, depth: number, out: string[]): void {
  if (depth > MAX_DEPTH) { out.push(s); return; }
  // heredoc sin parser: no te metas
  if (/<</.test(s)) { out.push(s); return; }

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
