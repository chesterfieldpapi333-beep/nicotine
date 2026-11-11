// Sanitización de salida no confiable para la TUI (texto del modelo y salida de
// tools). El terminal es la superficie de ataque: una secuencia ANSI puede mover
// el cursor, borrar líneas/pantalla, reescribir la línea anterior o escribir en el
// portapapeles (OSC 52). Aquí se conserva SOLO SGR básico y se descarta el resto.
//
// Reglas:
// - CSI: se conserva únicamente `ESC [ <params> m` con params de la lista blanca.
// - OSC, DCS, SOS, PM, APC: se descartan completos (hasta BEL/ST o fin del texto).
// - Escapes simples (ESC c, ESC 7, ESC ( B, …) y controles C0/C1: se descartan
//   (las formas de 8 bits de CSI/OSC/DCS/SOS/PM/APC se consumen como sus pares ESC).
// - Se conservan `\n` y `\t`; `\r` y `\r\n` se normalizan a `\n` (nunca sobrescriben).
// - Lo que no es secuencia de control sale byte a byte igual (texto plano idéntico).
// El escaneo es lineal y la salida nunca crece respecto de la entrada.

const ESC = 0x1b;
const BEL = 0x07;
const LF = 0x0a;
const TAB = 0x09;
const CR = 0x0d;

/** SGR permitido: reset, negrita, dim, subrayado, sus «off» y color de texto. */
const SGR_ALLOWED = new Set([0, 1, 2, 4, 22, 24, 30, 31, 32, 33, 34, 35, 36, 37, 39, 90, 91, 92, 93, 94, 95, 96, 97]);

/** Controles que obligan a escanear: todo C0 (salvo \n y \t) y todo C1. */
const NEEDS_SCAN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

/**
 * Devuelve `text` apto para imprimir en la TUI: sin secuencias peligrosas,
 * conservando solo el SGR básico. Es idempotente y acotada (`len ≤ len(text)`).
 */
export function sanitizeForTUI(text: string): string {
  if (!text || !NEEDS_SCAN.test(text)) return text;
  const out: string[] = [];
  let plain = 0;
  let i = 0;
  const flush = (end: number) => { if (end > plain) out.push(text.slice(plain, end)); };
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === ESC) {
      flush(i);
      i = skipEscape(text, i, out);
      plain = i;
      continue;
    }
    if (code === CR) {
      flush(i);
      out.push("\n");
      i += 1;
      if (text.charCodeAt(i) === LF) i += 1;
      plain = i;
      continue;
    }
    if (code === 0x9b) { // CSI de 8 bits (C1)
      flush(i);
      i = consumeCsi(text, i + 1, out);
      plain = i;
      continue;
    }
    if (code === 0x9d) { // OSC de 8 bits
      flush(i);
      i = consumeString(text, i + 1, true);
      plain = i;
      continue;
    }
    if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) { // DCS/SOS/PM/APC de 8 bits
      flush(i);
      i = consumeString(text, i + 1, false);
      plain = i;
      continue;
    }
    if (code === LF || code === TAB) { i += 1; continue; }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) { flush(i); i += 1; plain = i; continue; }
    i += 1;
  }
  flush(text.length);
  return out.join("");
}

/** Parámetros SGR aceptables (vacío = reset). Subparámetros (`38;5;…`) se rechazan. */
export function isAllowedSgr(params: string): boolean {
  if (params === "") return true;
  for (const part of params.split(";")) {
    if (part === "") continue;
    if (!/^\d+$/.test(part)) return false;
    if (!SGR_ALLOWED.has(Number(part))) return false;
  }
  return true;
}

/** Consume una secuencia desde `at` (que apunta al ESC). Devuelve el índice siguiente. */
function skipEscape(text: string, at: number, out: string[]): number {
  const next = at + 1 < text.length ? text.charCodeAt(at + 1) : -1;
  if (next === 0x5b) return consumeCsi(text, at + 2, out);
  if (next === 0x5d) return consumeString(text, at + 2, true); // OSC (BEL o ST)
  if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) return consumeString(text, at + 2, false); // DCS/SOS/PM/APC
  let j = at + 1;
  while (j < text.length) {
    const c = text.charCodeAt(j);
    if (c >= 0x20 && c <= 0x2f) { j += 1; continue; }
    break;
  }
  if (j < text.length) {
    const c = text.charCodeAt(j);
    if (c >= 0x30 && c <= 0x7e) j += 1;
  }
  return j;
}

function consumeCsi(text: string, from: number, out: string[]): number {
  let j = from;
  let params = "";
  while (j < text.length) {
    const c = text.charCodeAt(j);
    if (c >= 0x30 && c <= 0x3f) { params += text[j]; j += 1; continue; }
    break;
  }
  let hasIntermediate = false;
  while (j < text.length) {
    const c = text.charCodeAt(j);
    if (c >= 0x20 && c <= 0x2f) { hasIntermediate = true; j += 1; continue; }
    break;
  }
  if (j >= text.length) return text.length; // secuencia incompleta: se descarta
  const final = text.charCodeAt(j);
  j += 1;
  if (final === 0x6d && !hasIntermediate && isAllowedSgr(params)) out.push(`\u001b[${params}m`);
  return j;
}

function consumeString(text: string, from: number, belEnds: boolean): number {
  let j = from;
  while (j < text.length) {
    const c = text.charCodeAt(j);
    if (belEnds && c === BEL) return j + 1;
    if (c === ESC && text.charCodeAt(j + 1) === 0x5c) return j + 2; // ST
    j += 1;
  }
  return text.length; // sin terminador: se descarta el resto (fail-closed)
}
