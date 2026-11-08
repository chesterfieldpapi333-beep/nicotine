// Frontmatter YAML mínimo: solo lo que necesita SKILL.md (y agents/*.md más adelante).
// Claves planas + anidamiento por indentación (máx 3 niveles).
// Sin dependencias; tolerante pero no exotérico: listas inline `[a, b]`,
// booleanos true/false, números como strings, strings con o sin comillas.
// Devuelve también las claves desconocidas de primer nivel para que el llamante avise.

export interface FrontmatterResult {
  data: Record<string, unknown>;
  /** Claves de primer nivel (para reportar las no soportadas). */
  keys: string[];
  error?: string;
}

const KEY_RE = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/;

/** Parsea el contenido de un SKILL.md. Espera que empiece por `---`. */
export function parseFrontmatter(raw: string): { fm: Record<string, unknown> | null; keys: string[]; body: string; error?: string } {
  const text = raw.replace(/^\uFEFF/, "");
  if (!text.startsWith("---")) return { fm: null, keys: [], body: text, error: "falta la línea de apertura ---" };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { fm: null, keys: [], body: text, error: "falta el cierre --- del frontmatter" };
  const closeLine = text.indexOf("\n", end + 1);
  const fmText = text.slice(3, end).replace(/^\n/, "");
  const body = (closeLine === -1 ? "" : text.slice(closeLine + 1)).replace(/^\n/, "");
  const fm = parseYamlish(fmText);
  if (!fm) return { fm: null, keys: [], body, error: "frontmatter inválido (línea sin clave:valor reconocida)" };
  return { fm: fm.data, keys: fm.keys, body };
}

function parseYamlish(text: string): FrontmatterResult | null {
  // Pila de { indent, obj }. Cada línea con clave: valor cuelga del nivel de indentación.
  const root: Record<string, unknown> = {};
  const stack: { indent: number; obj: Record<string, unknown>; lastKey?: string }[] = [{ indent: -1, obj: root }];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const m = line.trimStart().match(KEY_RE);
    if (!m) return null;
    const [, key, rawValue] = m;
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];
    const value = parseValue(rawValue.trim());
    if (value === UNSET) {
      // clave anidada: el valor real vendrá en las líneas siguientes
      const child: Record<string, unknown> = {};
      parent.obj[key] = child;
      stack.push({ indent, obj: child, lastKey: key });
    } else {
      parent.obj[key] = value;
    }
  }
  return { data: root, keys: Object.keys(root) };
}

const UNSET = Symbol("unset");
type Unset = typeof UNSET;

function parseValue(v: string): unknown | Unset {
  if (v === "") return UNSET;
  if (v === "true") return true;
  if (v === "false") return false;
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    return inner ? inner.split(",").map((s) => unquote(s.trim())) : [];
  }
  return unquote(v);
}

function unquote(v: string): string {
  if (v.length >= 2) {
    const q = v[0];
    if ((q === '"' || q === "'" || q === "`") && v[v.length - 1] === q) return v.slice(1, -1);
  }
  return v;
}
