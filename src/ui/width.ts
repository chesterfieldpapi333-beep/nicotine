// Ancho de celda por punto de código (aproximación honesta, sin dependencias):
//   0 celdas — marcas combinantes, selectores de variación, ZWJ/ZWNJ/ZWSP, BOM
//   2 celdas — CJK ideographs/kana/hangul/fullwidth + emoji principales
//   1 celda  — todo lo demás (ambiguous → 1, como la mayoría de terminales en locale C/UTF-8)

const ZERO_RANGES: [number, number][] = [
  [0x0300, 0x036f], // marcas diacríticas combinantes
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x0610, 0x061a],
  [0x064b, 0x065f],
  [0x0670, 0x0670],
  [0x06d6, 0x06dc],
  [0x0e31, 0x0e31],
  [0x0e34, 0x0e3a],
  [0x0e47, 0x0e4e],
  [0x20d0, 0x20f0], // combinantes para símbolos
  [0x200b, 0x200f], // ZWSP ZWNJ ZWJ LRM RLM
  [0xfe00, 0xfe0f], // selectores de variación
  [0xfe20, 0xfe2f], // combinantes dobles
  [0xfeff, 0xfeff], // BOM / ZWNBSP
  [0xe0100, 0xe01ef], // selectores de variación suplementarios
];

const WIDE_RANGES: [number, number][] = [
  [0x1100, 0x115f], // jamo hangul iniciales
  [0x2e80, 0x303e], // CJK radicals … CJK symbols (incl. 。〈〉)
  [0x3041, 0x33ff], // hiragana … CJK compat
  [0x3400, 0x4dbf], // CJK ext A
  [0x4e00, 0x9fff], // CJK unificado
  [0xa000, 0xa4cf], // Yi
  [0xac00, 0xd7a3], // hangul sílabas
  [0xf900, 0xfaff], // CJK compat ideographs
  [0xfe30, 0xfe6f], // formas verticales + pequeñas
  [0xff00, 0xffef], // fullwidth forms
  [0x20000, 0x2fffd], // CJK ext B…
  [0x30000, 0x3fffd],
  [0x1f000, 0x1faff], // emoji y símbolos suplementarios (mayoría wide)
  [0x2600, 0x27bf], // dingbats/misceláneos (mayoría wide)
];

const inRanges = (cp: number, ranges: [number, number][]): boolean => {
  for (const [lo, hi] of ranges) if (cp >= lo && cp <= hi) return true;
  return false;
};

/** Ancho en celdas de UN punto de código. */
export function cellWidth(cp: number): 0 | 1 | 2 {
  if (cp === 0) return 0;
  if (inRanges(cp, ZERO_RANGES)) return 0;
  if (inRanges(cp, WIDE_RANGES)) return 2;
  return 1;
}

/** Ancho visible de un string SIN escapes ANSI (los llamantes deben stripAnsi antes si toca). */
export function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += cellWidth(ch.codePointAt(0) ?? 0);
  return w;
}
