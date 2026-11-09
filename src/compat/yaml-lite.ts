// Frontmatter YAML mínimo: lo que necesitan SKILL.md y agents/*.md.
// Claves planas + anidamiento por indentación, y LISTAS DE MAPAS en bloque
// («permissions:» con ítems «- action: edit» + claves de continuación), que es lo
// que pide la spec de agentes en .md. Sin dependencias; tolerante en lo plano:
// listas inline `[a, b]`, booleanos true/false, strings con o sin comillas.
// No soporta: listas anidadas, flow-maps (excepto [a, b] plana), multilínea (|/>).
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

type Ctx = { indent: number; obj: Record<string, unknown> } | { indent: number; arr: unknown[] };
const isArr = (c: Ctx): c is { indent: number; arr: unknown[] } => "arr" in c;

function parseYamlish(text: string): FrontmatterResult | null {
  const root: Record<string, unknown> = {};
  const lines = text.split("\n");
  const stack: Ctx[] = [{ indent: -1, obj: root }];
  const top = () => stack[stack.length - 1];
  const popTo = (indent: number) => { while (stack.length > 1 && top().indent >= indent) stack.pop(); };
  const nextSignificant = (from: number): { content: string; indent: number } | null => {
    for (let j = from; j < lines.length; j++) {
      const l = lines[j].replace(/\s+$/, "");
      if (!l.trim() || l.trimStart().startsWith("#")) continue;
      return { content: l.trimStart(), indent: l.length - l.trimStart().length };
    }
    return null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, "");
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const content = line.trimStart();

    // ————— elemento de lista: "- …" o "-"
    if (content === "-" || content.startsWith("- ")) {
      const itemText = content.slice(1).replace(/^\s+/, "");
      popTo(indent);
      const ctx = top();
      if (!isArr(ctx)) return null; // "- " sin una lista abierta por una clave
      const m = itemText.match(KEY_RE);
      if (!itemText) { ctx.arr.push(null); continue; }
      if (!m) { ctx.arr.push(parseValue(itemText)); continue; }
      // Ítem mapa: "- action: edit" — las claves de continuación se anexan a este objeto
      const [, key, rawValue] = m;
      const value = parseValue(rawValue.trim());
      const item: Record<string, unknown> = {};
      ctx.arr.push(item);
      if (value === UNSET) {
        // subobjeto anidado dentro del ítem (caso raro): se abre mapa simple
        const child: Record<string, unknown> = {};
        item[key] = child;
        stack.push({ indent, obj: child });
      } else {
        item[key] = value;
        stack.push({ indent, obj: item });
      }
      continue;
    }

    const m = content.match(KEY_RE);
    if (!m) return null;
    popTo(indent);
    const ctx = top();
    if (isArr(ctx)) return null; // clave suelta dentro de una lista
    const [, key, rawValue] = m;
    const value = parseValue(rawValue.trim());
    if (value === UNSET) {
      // ¿lista de mapas en bloque, o mapa anidado? depende de la próxima línea significativa
      const next = nextSignificant(i + 1);
      if (next && next.content.startsWith("- ") && next.indent > indent) {
        const arr: unknown[] = [];
        ctx.obj[key] = arr;
        stack.push({ indent, arr });
      } else {
        const child: Record<string, unknown> = {};
        ctx.obj[key] = child;
        stack.push({ indent, obj: child });
      }
    } else {
      ctx.obj[key] = value;
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
