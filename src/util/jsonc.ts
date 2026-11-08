// JSONC mínimo pero correcto: quita comentarios // y /* */ y comas colgantes,
// respetando el interior de los strings (un "https://..." dentro de un string
// NO es un comentario). No es un parser completo: alcanza para configs.

export function stripJsonc(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  let inString = false;
  let quote = "";
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") { // escape: copiar también el siguiente carácter tal cual
        if (i + 1 < n) out += src[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) inString = false;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = true; quote = ch; out += ch; i++; continue; }
    if (ch === "/" && next === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (ch === "/" && next === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    out += ch;
    i++;
  }
  // Comas colgantes: `,}` o `,]` (con whitespace entre medio) → quitar la coma.
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export function parseJsonc<T = unknown>(src: string, file = "<jsonc>"): T {
  try {
    return JSON.parse(stripJsonc(src)) as T;
  } catch (err) {
    throw new Error(`No se pudo parsear ${file}: ${(err as Error).message}`);
  }
}
