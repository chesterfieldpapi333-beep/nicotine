// Motor de permisos: reglas ordenadas allow/ask/deny por (acción, recurso).
// Modelo compatible con OpenCode: la ÚLTIMA regla que coincide gana.
// - Objeto v1  (`permission`): { bash: { "*": "ask", "git status *": "allow" } }
// - Array v2   (`permissions`): [ { action, resource, effect }, ... ]
// Ambos se traducen a la misma lista ordenada (defaults primero, config después).

import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export type Effect = "allow" | "ask" | "deny";
export interface Rule { action: string; resource: string; effect: Effect }

// Alias aceptados en config: el spec lite usa nombres clásicos pero la
// configuración v2 trae los nuevos; normalizamos a los clásicos.
export function normalizeAction(action: string): string {
  const a = action.trim().toLowerCase();
  if (a === "shell") return "bash";
  if (a === "subagent") return "task";
  if (a === "write" || a === "patch" || a === "apply_patch") return "edit";
  return a;
}

export class PermissionDenied extends Error {
  /**
   * `detail` resume UNA causa (regla o policy que coincide) o "rechazado por el
   * usuario" — JAMÁS el ruleset completo (legado: #opencode-53446 volcaba todo el
   * permission.bash en cada denegación y se reenviaba en cada request).
   */
  constructor(public readonly action: string, public readonly resource: string, public readonly detail?: string) {
    super(`permission denied: ${action} → ${resource}${detail ? ` (${detail})` : ""}`);
    this.name = "PermissionDenied";
  }
}

// Expande ~ y $HOME en recursos de rutas (no en comandos de shell).
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return homedir() + p.slice(1);
  return p.replaceAll("$HOME", homedir());
}

// Matching estilo OpenCode: `*` = cualquier cosa (incluida /), `?` = un carácter,
// el resto literal. Valor COMPLETO. Un patrón que termina en " *" también casa
// con la cadena sin argumentos ("git status *" casa "git status").
export function matchPattern(pattern: string, value: string): boolean {
  const norm = (s: string) => s.replaceAll("\\", "/").toLowerCase();
  let p = norm(pattern);
  const v = norm(value);
  // Atajo documentado por OpenCode: "cmd *" casa también "cmd".
  if (p.endsWith(" *") && v === p.slice(0, -2)) return true;
  let re = "";
  for (const ch of p) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(v);
}

export interface CheckResult { effect: Effect; rule?: Rule; /** true si lo impide una policy v2 (hard-deny post-reglas). */ policy?: boolean }

export interface Policy { action: string; resource: string }

export class PermissionEngine {
  private rules: Rule[];
  private savedAllows: Rule[] = []; // "allow always" en esta sesión (persistencia: fase 3)
  private policies: Policy[];

  constructor(rules: Rule[], policies: Policy[] = []) {
    this.rules = rules.map((r) => ({ ...r, action: normalizeAction(r.action) }));
    this.policies = policies.map((p) => ({ action: normalizeAction(p.action), resource: p.resource }));
  }

  addSavedAllow(rule: Rule) { this.savedAllows.push({ ...rule, action: normalizeAction(rule.action) }); }

  /** Última regla que coincide gana; sin coincidencia → ask (como OpenCode). Las policies v2 se aplican DESPUÉS: hard-deny gane a gane. */
  check(action: string, resource: string): CheckResult {
    const act = normalizeAction(action);
    let hit: Rule | undefined;
    for (const r of this.rules) if (matchPattern(r.action, act) && matchPattern(r.resource, resource)) hit = r;
    for (const r of this.savedAllows) if (matchPattern(r.action, act) && matchPattern(r.resource, resource)) hit = r;
    // Un deny configurado NUNCA lo pisan los allows guardados: se re-evalúa.
    let denied: Rule | undefined;
    for (const r of this.rules) if (r.effect === "deny" && matchPattern(r.action, act) && matchPattern(r.resource, resource)) denied = r;
    if (denied) return this.withPolicy(act, resource, { effect: "deny", rule: denied });
    return this.withPolicy(act, resource, { effect: hit?.effect ?? "ask", rule: hit });
  }

  private withPolicy(act: string, resource: string, base: CheckResult): CheckResult {
    for (const p of this.policies) {
      if (matchPattern(p.action, act) && matchPattern(p.resource, resource)) {
        return { effect: "deny", rule: { action: p.action, resource: p.resource, effect: "deny" }, policy: true };
      }
    }
    return base;
  }

  /** Varios recursos: deny > ask > allow (regla de OpenCode para ops compuestas). */
  checkAll(action: string, resources: string[]): CheckResult {
    const results = resources.map((r) => this.check(action, r));
    const deny = results.find((r) => r.effect === "deny");
    if (deny) return deny;
    const ask = results.find((r) => r.effect === "ask");
    if (ask) return ask;
    return results.find((r) => r.effect === "allow") ?? { effect: "ask" };
  }

  /** ¿La ruta queda fuera del proyecto (cwd)? → pasa por `external_directory`. */
  outsideProject(cwd: string, target: string): boolean {
    const abs = isAbsolute(expandHome(target)) ? resolve(expandHome(target)) : resolve(cwd, target);
    const root = resolve(cwd);
    return abs !== root && !abs.startsWith(root + "/");
  }

  /** Verificación completa de una operación sobre rutas. */
  checkPath(cwd: string, action: string, target: string): CheckResult {
    const abs = isAbsolute(expandHome(target)) ? resolve(expandHome(target)) : resolve(cwd, target);
    if (this.outsideProject(cwd, abs)) {
      // Spec Vireo: fuera del proyecto SIEMPRE pasa por external_directory;
      // si no hay regla, se pregunta (más estricto que el default v2 de OpenCode).
      const ext = this.check("external_directory", abs.endsWith("/") ? abs : abs + "/*");
      if (ext.effect !== "allow") return ext;
    }
    return this.check(action, abs);
  }
}

// Defaults base de OpenCode v2 (documentados en /docs/permissions#defaults),
// más "ask" para external_directory porque el spec de Vireo lo exige.
export function baseRules(): Rule[] {
  return [
    { action: "*", resource: "*", effect: "allow" },
    { action: "read", resource: "*.env", effect: "ask" },
    { action: "read", resource: "*.env.*", effect: "ask" },
    { action: "read", resource: "*.env.example", effect: "allow" },
    { action: "external_directory", resource: "*", effect: "ask" },
  ];
}

/** Lee `policies` (v2): hard-deny post-reglas. Se ignora lo inválido. */
export function policiesFromConfig(raw: unknown): Policy[] {
  const out: Policy[] = [];
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { action, resource } = item as Record<string, unknown>;
    if (typeof action !== "string" || typeof resource !== "string") continue;
    if (!action.trim() || !resource.trim()) continue;
    const act = normalizeAction(action);
    out.push({ action: act, resource: act === "bash" ? String(resource) : expandHome(String(resource)) });
  }
  return out;
}

/** Traduce el bloque `permission` (v1, objeto) o `permissions` (v2, array) a reglas. */
export function configToRules(permission: unknown, permissions: unknown): Rule[] {
  const rules: Rule[] = [];
  if (permission && typeof permission === "object") {
    for (const [tool, value] of Object.entries(permission as Record<string, unknown>)) {
      const action = normalizeAction(tool);
      if (typeof value === "string") {
        rules.push({ action, resource: "*", effect: asEffect(value) });
      } else if (value && typeof value === "object") {
        for (const [pattern, effect] of Object.entries(value as Record<string, unknown>)) {
          // Los patrones de rutas admiten ~ y $HOME; los de bash se dejan crudas.
          const expanded = action === "bash" ? pattern : expandHome(pattern);
          rules.push({ action, resource: expanded, effect: asEffect(String(effect)) });
        }
      }
    }
  }
  if (Array.isArray(permissions)) {
    for (const raw of permissions) {
      if (!raw || typeof raw !== "object") continue;
      const { action, resource, effect } = raw as Record<string, unknown>;
      if (typeof action !== "string" || typeof resource !== "string") continue;
      const act = normalizeAction(action);
      const res = act === "bash" || act === "external_directory" ? String(resource) : expandHome(String(resource));
      rules.push({ action: act, resource: res, effect: asEffect(String(effect)) });
    }
  }
  return rules;
}

function asEffect(s: string): Effect {
  const e = s.trim().toLowerCase();
  if (e === "allow" || e === "ask" || e === "deny") return e;
  throw new Error(`Efecto de permiso desconocido: "${s}" (usa allow|ask|deny)`);
}
