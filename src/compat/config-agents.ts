// Agentes custom en JSON de config — clave de primer nivel `agents`:
//   "agents": { "reviewer": { "description": "…",
//                             "mode": "subagent",           // primary(def new) | subagent | all
//                             "system": "…",                // reemplaza el system prompt base (identidad/estilo)
//                             "model": "openai/x[#variant]",// subagentes lo usan; primaries NO cambian la sesión
//                             "permissions": [ { action, resource, effect } ], // se ANEXAN tras las globales
//                             "hidden": true,               // fuera de listados; --agent explícito sigue valiendo
//                             "disabled": true } }          // elimina el agente (incl. un built-in)
// Spec oficial verificada (opencode.ai/docs/agents, 2026-11):
//   - custom agent NUEVO: mode default `primary`; override de un built-in conserva su mode salvo `mode`;
//   - merge entre capas: escalares reemplazan; las reglas de `permissions` se ANEXAN
//     (deepMerge ya concatena `permissions` en cualquier nivel — no se re-mergea aquí);
//   - prefix-match de provider/model (vendor antes del primer `/`; `#variant` se descarta en la sesión).
// Lite, documentado: `steps`, `color`, `request` (headers/body) e IDs ajenos V1
// (temperature/prompt/tools/maxSteps/…) → IGNORADOS con aviso. `system` reemplaza
// solo identidad/estilo; el entorno + contexto de proyecto + skills se conservan.
// Nunca ejecuta nada: es un manifiesto de datos, como los comandos de config.

import type { AgentDef } from "../core/agents.js";
import { stripModel } from "../core/provider.js";
import { configToRules } from "../core/permissions.js";

export interface ConfigAgentsParse {
  agents: AgentDef[];
  warnings: string[];
}

const KNOWN = new Set(["description", "mode", "system", "model", "permissions", "hidden", "disabled"]);
const V1_LEGACY = new Set(["temperature", "top_p", "prompt", "permission", "tools", "disable", "maxSteps", "instructions", "steps", "color", "request", "subtask"]);
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const MODES = new Set(["primary", "subagent", "all"]);

export function parseConfigAgents(raw: unknown): ConfigAgentsParse {
  const agents: AgentDef[] = [];
  const warnings: string[] = [];
  if (raw === undefined) return { agents, warnings };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { agents, warnings: ["«agents» debe ser un objeto {id: {…}}; se ignora"] };
  }
  for (const [rawId, rawDef] of Object.entries(raw as Record<string, unknown>)) {
    const id = String(rawId).trim();
    if (!ID_RE.test(id)) { warnings.push(`agents: id «${rawId}» inválido ([a-zA-Z0-9._-], empieza por alfanumérico); se ignora`); continue; }
    if (!rawDef || typeof rawDef !== "object" || Array.isArray(rawDef)) {
      warnings.push(`agents «${id}»: debe ser un objeto {description?, mode?, system?, …}; se ignora`); continue;
    }
    const def = rawDef as Record<string, unknown>;
    for (const k of Object.keys(def)) {
      if (KNOWN.has(k)) continue;
      if (V1_LEGACY.has(k)) warnings.push(`agents «${id}»: campo heredado «${k}» ignorado en lite (ver spec agents#options)`);
      else warnings.push(`agents «${id}»: campo desconocido «${k}» ignorado`);
    }
    const out: AgentDef = { id, description: "", permissionRules: [] };
    if (def["description"] !== undefined) {
      out.description = String(def["description"]).trim().slice(0, 512);
      if (!out.description) warnings.push(`agents «${id}»: description vacía`);
    } else {
      warnings.push(`agents «${id}»: falta «description» (recomendada para que el modelo elija bien el agente)`);
    }
    const modeRaw = typeof def["mode"] === "string" ? def["mode"].trim().toLowerCase() : undefined;
    if (modeRaw !== undefined) {
      if (MODES.has(modeRaw)) out.mode = modeRaw as AgentDef["mode"];
      else warnings.push(`agents «${id}»: mode «${String(def["mode"])}» inválido (primary|subagent|all); se ignora`);
    }
    const sys = typeof def["system"] === "string" ? def["system"].trim() : "";
    if (sys) out.systemPrompt = sys.slice(0, 16 * 1024);
    const rawModel = typeof def["model"] === "string" ? def["model"].trim()
      : (def["model"] && typeof def["model"] === "object" ? String((def["model"] as Record<string, unknown>)["model"] ?? "").trim() : "");
    if (rawModel) out.model = rawModel; // la variante #… se descarta al aplicarlo (stripModelForSession)
    const perms = def["permissions"];
    if (perms !== undefined) {
      if (!Array.isArray(perms)) warnings.push(`agents «${id}»: «permissions» debe ser una lista de {action, resource, effect}; se ignora`);
      else {
        for (const item of perms) {
          try {
            const rules = configToRules(undefined, [item]);
            if (rules.length) out.permissionRules.push(...rules);
            else warnings.push(`agents «${id}»: entrada de permissions malformada (se omite): ${JSON.stringify(item)}`);
          } catch {
            warnings.push(`agents «${id}»: effect desconocido en permissions (se omite): ${JSON.stringify(item)}`);
          }
        }
      }
    }
    if (def["hidden"] !== undefined) out.hidden = def["hidden"] === true || def["hidden"] === "true";
    if (def["disabled"] !== undefined) out.disabled = def["disabled"] === true || def["disabled"] === "true";
    agents.push(out);
  }
  return { agents, warnings };
}
