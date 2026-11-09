// diff_style del tui.json: «auto» (unificado, defecto) y «stacked».
// stacked apila el «antes» y el «después» de cada hunk en dos bloques
// verticales en vez del intercalado unificado — útil en terminales estrechas.
// Función pura; se aplica sobre el texto unificado antes del coloreado.

export type DiffStyle = "auto" | "stacked";

/** Transforma un diff unificado: dentro de cada hunk emite primero las líneas
 *  de contexto+eliminadas, luego las líneas de contexto+añadidas. */
export function stackUnifiedDiff(diff: string): string {
  const lines = diff.split("\n");
  const out: string[] = [];
  let hunk: string[] = [];
  const flushHunk = () => {
    if (!hunk.length) return;
    const ctx: string[] = [], del: string[] = [], add: string[] = [];
    for (const l of hunk) {
      if (l.startsWith("-") && !l.startsWith("---")) del.push(l);
      else if (l.startsWith("+") && !l.startsWith("+++")) add.push(l);
      else ctx.push(l);
    }
    out.push(...ctx, ...del);
    if (ctx.length || add.length) out.push("+ ···"); // separador visual antes/después
    out.push(...ctx, ...add);
    hunk = [];
  };
  for (const l of lines) {
    if (l.startsWith("@@")) { flushHunk(); out.push(l); continue; }
    if (l.startsWith("---") || l.startsWith("+++") || /^diff |^index /.test(l)) { flushHunk(); out.push(l); continue; }
    hunk.push(l);
  }
  flushHunk();
  return out.join("\n");
}

/** Aplica el diff_style: auto devuelve el texto intacto. */
export function applyDiffStyle(diff: string, style: DiffStyle | undefined): string {
  return style === "stacked" ? stackUnifiedDiff(diff) : diff;
}
