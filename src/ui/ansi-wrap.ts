// Wrap/alto visual de líneas CON escapes ANSI. Sin esto, cortar por índice rompería los escapes.
// Cuenta celdas visibles con src/ui/width.ts: CJK/emoji = 2, combinantes = 0.

import { cellWidth, textWidth } from "./width.js";

export interface WrappedLine { text: string; continuation: boolean }

const SGR = /\x1b\[[0-9;]*m/g;

export function visibleWidth(s: string): number {
  return textWidth(stripAnsi(s));
}

export function stripAnsi(s: string): string {
  return s.replace(SGR, "");
}

// Envuelve `line` a `width` celdas conservando escapes (los escapes se copian
// a la línea de salida donde abren y se re-emiten "reset" al finalizar cada trozo).
export function wrapAnsi(line: string, width: number): WrappedLine[] {
  if (visibleWidth(line) <= width) return [{ text: line, continuation: false }];
  const chunks: WrappedLine[] = [];
  let current = "";
  let cells = 0;
  let hasContent = false; // hay al menos un carácter visible en `current`
  let continuation = false;
  const tokens = tokenize(line);
  for (const tok of tokens) {
    if (tok.kind === "escape") { current += tok.text; continue; }
    for (const ch of tok.text) {
      const cw = cellWidth(ch.codePointAt(0) ?? 0);
      // Un carácter doble no cabe a medias: si no cabe entero, salta a la siguiente línea.
      if (cw === 2 && cells > 0 && cells + cw > width) {
        chunks.push({ text: current + "\x1b[0m", continuation });
        current = "\x1b[0m";
        cells = 0;
        hasContent = false;
        continuation = true;
      }
      current += ch;
      cells += cw;
      if (cw > 0) hasContent = true;
      if (cells >= width) {
        chunks.push({ text: current + "\x1b[0m", continuation });
        current = "\x1b[0m"; // el siguiente trozo arranca limpio (los fg se pierden; aceptable v1)
        cells = 0;
        hasContent = false;
        continuation = true;
      }
    }
  }
  if (hasContent) chunks.push({ text: current, continuation });
  return chunks;
}

function* tokenize(line: string): Generator<{ kind: "escape" | "text"; text: string }> {
  let last = 0;
  SGR.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SGR.exec(line))) {
    if (m.index > last) yield { kind: "text", text: line.slice(last, m.index) };
    yield { kind: "escape", text: m[0] };
    last = SGR.lastIndex;
  }
  if (last < line.length) yield { kind: "text", text: line.slice(last) };
}

// Corta una línea ANSI a `width` celdas (para overlays que ya vienen medidos)
export function sliceAnsi(line: string, width: number): string {
  return wrapAnsi(line, width).map((c) => c.text)[0] ?? "";
}

/** Padding/truncamiento a ancho exacto conservando color. */
export function fitAnsi(line: string, width: number): string {
  const w = visibleWidth(line);
  if (w === width) return line;
  if (w < width) return line + " ".repeat(width - w);
  // cortar: re-envolver y tomar el primer trozo
  return wrapAnsi(line, Math.max(1, width))[0]?.text ?? "";
}
