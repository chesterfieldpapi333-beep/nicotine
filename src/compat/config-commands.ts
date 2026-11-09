// Comandos custom en JSON de config — clave de primer nivel `commands`:
//   "commands": { "review": { "template": "Review $ARGUMENTS.",
//                             "description": "…",        // opcional
//                             "agent": "plan",           // opcional (honrado: cambia el agente de la sesión)
//                             "model": "openai/gpt-4o",  // opcional (honrado: modelo de la sesión)
//                             "subagent": true } }       // aceptado pero NO honrado (lite: sin sesiones en background)
// Formato oficial verificado en opencode.ai/docs/commands#json (2026-11):
//   - `template` REQUERIDO en JSON (en Markdown lo da el cuerpo);
//   - misma sustitución que los comandos de archivo ($ARGUMENTS / $1..$9, ver renderCommandBody);
//   - `subtask` se acepta como alias deprecado de `subagent` (`subagent` gana si ambos).
// Lite, documentado: `agent` y `model` cambian la sesión actual del TUI (como /agent y /models);
// `subagent`/`subtask` se IGNORAN con aviso (no hay background child sessions);
// bloques `!`…`` (shell) quedan LITERALES con aviso — el modelo puede pedir el comando con permisos.
// Nunca se parsea nada más: es una plantilla de texto, como los comandos de archivo.

import type { FileCommand } from "./file-commands.js";

export interface ConfigCommand extends FileCommand {
  /** agente de la sesión al ejecutar (si la clave era válida). */
  agent?: string;
  /** modelo de la sesión al ejecutar (variant `#…` descartada con aviso). */
  model?: string;
}

const MAX_TEMPLATE = 32 * 1024;      // igual que MAX_BODY de file-commands
const MAX_COMMANDS = 200;
const KNOWN = new Set(["template", "description", "agent", "model", "subagent", "subtask"]);
// Claves JSON explícitas: NO se sanitizan; lo que no case, se descarta con aviso.
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,63}$/;

/** Parsea la clave `commands` (ya mergeada y con {env:}/{file:} sustituidas). Nunca lanza. */
export function parseConfigCommands(raw: unknown): { commands: ConfigCommand[]; warnings: string[] } {
  const commands: ConfigCommand[] = [];
  const warnings: string[] = [];
  if (raw === undefined) return { commands, warnings };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { commands, warnings: ["«commands» debe ser un objeto {nombre: {template,…}}; se ignora"] };
  }
  for (const [rawName, rawDef] of Object.entries(raw as Record<string, unknown>)) {
    if (commands.length >= MAX_COMMANDS) { warnings.push("commands: demasiados (>200); el resto se ignora"); break; }
    const name = String(rawName).trim();
    if (!NAME_RE.test(name)) { warnings.push(`commands: nombre «${String(rawName)}» inválido ([a-zA-Z0-9:_-], empieza por alfanumerico); se ignora`); continue; }
    if (!rawDef || typeof rawDef !== "object" || Array.isArray(rawDef)) {
      warnings.push(`commands «${name}»: debe ser un objeto {template,…}; se ignora`); continue;
    }
    const def = rawDef as Record<string, unknown>;
    for (const k of Object.keys(def)) if (!KNOWN.has(k)) warnings.push(`commands «${name}»: clave desconocida (ignorada): ${k}`);
    // alias deprecado: `subtask`; `subagent` gana si ambos
    const subagentField = def["subagent"] !== undefined ? def["subagent"] : def["subtask"];
    if (subagentField !== undefined) warnings.push(`commands «${name}»: «subagent»/«subtask» no se honra en vireo-lite (sin sesiones en background); se ignora`);
    const template = typeof def["template"] === "string" ? def["template"] : "";
    if (!template.trim()) { warnings.push(`commands «${name}»: falta «template» (requerido en JSON); se ignora`); continue; }
    if (/(^|\n)\s*!`[^`]*`/.test(template)) warnings.push(`commands «${name}»: bloques shell (! + backtick) no se expanden en lite (quedan literales)`);
    let model = typeof def["model"] === "string" && def["model"].trim() ? def["model"].trim() : undefined;
    if (model?.includes("#")) { warnings.push(`commands «${name}»: «model#variant» — la variant se descarta; se usa ${model.split("#")[0]}`); model = model.split("#")[0]; }
    const agent = typeof def["agent"] === "string" && def["agent"].trim() ? def["agent"].trim() : undefined;
    const description = typeof def["description"] === "string" && def["description"].trim()
      ? def["description"].trim()
      : (template.split("\n").find((l) => l.trim()) ?? name).trim();
    commands.push({
      name,
      hint: description.slice(0, 60),
      description: description.slice(0, 512),
      body: template.slice(0, MAX_TEMPLATE),
      source: "opencode.json(c) «commands»",
      origin: "project",
      agent,
      model,
    });
  }
  return { commands, warnings };
}
