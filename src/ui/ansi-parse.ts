// Puente ANSI ↔ spans de estilo. Los componentes pintan con escapes SGR
// (\x1b[...m) — lingua franca de terminales. El motor ANSI pasa los escapes
// tal cual; el motor OpenTUI los parsea aquí a chunks con fg/atributos.

export interface Span { text: string; fg?: string; bold?: boolean; dim?: boolean; inverse?: boolean }

// Códigos clásicos → hex (paleta VGA aproximada) y brights
const BASIC: Record<number, string> = {
  30: "#000000", 31: "#cc0000", 32: "#4e9a06", 33: "#c4a000", 34: "#3465a4", 35: "#75507b", 36: "#06989a", 37: "#d3d7cf",
  90: "#555753", 91: "#ef2929", 92: "#8ae234", 93: "#fce94f", 94: "#729fcf", 95: "#ad7fa8", 96: "#34e2e2", 97: "#eeeeec",
};

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

export function parseAnsiLine(line: string): Span[] {
  const spans: Span[] = [];
  let current: Span = { text: "" };
  let fg: string | undefined, bold = false, dim = false, inverse = false;
  const flush = () => { if (current.text) { spans.push({ ...current, fg, bold, dim, inverse }); current = { text: "" }; } };
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (m.index > last) current.text += line.slice(last, m.index);
    flush();
    const codes = (m[1] || "0").split(";").map((x) => Number(x || "0"));
    for (let i = 0; i < codes.length; i++) {
      const n = codes[i];
      if (n === 0) { fg = undefined; bold = dim = inverse = false; }
      else if (n === 1) bold = true;
      else if (n === 2) dim = true;
      else if (n === 7) inverse = true;
      else if (n === 22) bold = dim = false;
      else if (n === 27) inverse = false;
      else if (n === 39) fg = undefined;
      else if (BASIC[n]) fg = BASIC[n];
      else if (n === 38 && codes[i + 1] === 5 && codes[i + 2] !== undefined) { fg = xterm256(codes[i + 2]); i += 2; }
      else if (n === 38 && codes[i + 1] === 2 && codes[i + 3] !== undefined) { fg = rgbHex(codes[i + 2], codes[i + 3], codes[i + 4]); i += 4; }
    }
    last = re.lastIndex;
  }
  current.text += line.slice(last);
  flush();
  return spans.filter((s) => s.text.length > 0);
}

function xterm256(n: number): string {
  if (n < 16) return BASIC[n < 8 ? 30 + n : 82 + n] ?? "#ffffff";
  if (n < 232) { const i = n - 16, r = Math.floor(i / 36), g = Math.floor((i % 36) / 6), b = i % 6; return rgbHex(r ? r * 40 + 55 : 0, g ? g * 40 + 55 : 0, b ? b * 40 + 55 : 0); }
  const v = (n - 232) * 10 + 8; return rgbHex(v, v, v);
}

const rgbHex = (r: number, g: number, b: number) =>
  "#" + [r, g, b].map((x) => Math.max(0, Math.min(255, x)).toString(16).padStart(2, "0")).join("");
