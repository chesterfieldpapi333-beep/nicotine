// C3 «semantic action stream»: etiqueta de fase derivada de tool_start.
// No oculta ni filtra información: los mensajes de tool en pantalla no cambian;
// solo el footer dice qué está pasando ahora mismo.

export const ACTION_STREAM_LABELS: Record<string, string> = {
  read: "analizando",
  list: "analizando",
  glob: "analizando",
  grep: "buscando en el código",
  write: "editando",
  edit: "editando",
  apply_patch: "editando",
  bash: "ejecutando comando",
  webfetch: "buscando en la web",
  websearch: "buscando en la web",
  todowrite: "organizando tareas",
  plan: "planificando",
  skill: "cargando skill",
  task: "delegando",
};

/** Etiqueta de fase para tool_start; null → el caller cae al estado genérico («pensando…»). */
export function actionLabelFor(name: string, args?: Record<string, unknown>): string | null {
  const base = ACTION_STREAM_LABELS[name];
  const label = base ?? `ejecutando ${name}`;
  if (name === "edit" || name === "write" || name === "apply_patch") {
    const p = args && typeof args["path"] === "string" ? args["path"] : undefined;
    if (p) return `${label} ${truncatePath(p)}`;
  }
  if (name === "read" || name === "list") {
    const p = args && typeof args["path"] === "string" ? args["path"] : undefined;
    if (p) return `${label} ${truncatePath(p)}`;
  }
  if (name === "glob" || name === "grep") {
    const pat = args && typeof args["pattern"] === "string" ? args["pattern"] : undefined;
    if (pat) return `${label} «${pat.slice(0, 40)}»`;
  }
  if (name === "bash") {
    const cmd = args && typeof args["command"] === "string" ? args["command"].replace(/\s+/g, " ").trim() : undefined;
    if (cmd) return `${label} «${cmd.slice(0, 48)}»`;
  }
  return label;
}

function truncatePath(p: string): string {
  const base = p.split("/").filter(Boolean).pop() ?? p;
  return base.length <= 40 ? base : "…" + base.slice(-39);
}
