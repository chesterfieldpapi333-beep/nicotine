// Política efectiva: exportación, validación e importación. Sin secretos.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseJsonc } from "../util/jsonc.js";
import { loadConfig } from "./config.js";
import { PermissionEngine, READONLY_RULES, type Effect, type Policy, type Rule } from "./permissions.js";
import { loadProjectApprovals } from "./approvals.js";

export const POLICY_VERSION = 1;
const MAX_RULES = 1000;
const MAX_PATTERN = 512;
const EFFECTS = new Set<Effect>(["allow", "ask", "deny"]);

export interface AnnotatedRule extends Rule { source: string }
export interface AnnotatedPolicy extends Policy { source: string }

export function policyFilePath(cwd: string): string {
  return join(cwd, ".nicotine", "policy.json");
}

export function annotatedRules(cwd: string, configDir?: string): AnnotatedRule[] {
  const { rules, ruleSources } = loadConfig(cwd, { configDir });
  const out = rules.map((r, i) => ({ ...r, source: ruleSources[i] ?? "defaults" }));
  for (const a of loadProjectApprovals(cwd)) out.push({ action: a.action, resource: a.resource, effect: "allow", source: "proyecto:aprobado" });
  return out;
}

export function annotatedPolicies(cwd: string, configDir?: string): AnnotatedPolicy[] {
  const { policies, policySources } = loadConfig(cwd, { configDir });
  return policies.map((p, i) => ({ ...p, source: policySources[i] ?? "config" }));
}

/** Vista exportable (stdout o archivo). `--readonly` añade las reglas CLI como origen cli:--readonly. */
export function buildPolicyExport(cwd: string, configDir: string | undefined, readonly: boolean): { version: number; rules: AnnotatedRule[]; policies: AnnotatedPolicy[] } {
  const rules = annotatedRules(cwd, configDir);
  const policies = annotatedPolicies(cwd, configDir);
  if (readonly) for (const r of READONLY_RULES) rules.push({ ...r, source: "cli:--readonly" });
  return { version: POLICY_VERSION, rules, policies };
}

/** Valida un archivo de política (export previo o escrito a mano). Lanza Error con mensaje claro. */
export function validatePolicyExport(raw: unknown): { rules: Rule[]; policies: Policy[] } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("la política debe ser un objeto JSON");
  const o = raw as Record<string, unknown>;
  if (o["version"] !== POLICY_VERSION) throw new Error(`version inválida: se esperaba ${POLICY_VERSION}`);
  const rawRules = o["rules"] ?? o["permissions"];
  if (!Array.isArray(rawRules)) throw new Error("falta el array «rules» (o «permissions»)");
  if (rawRules.length > MAX_RULES) throw new Error(`demasiadas reglas (máx. ${MAX_RULES})`);
  const rules: Rule[] = [];
  for (const item of rawRules) {
    if (typeof item !== "object" || item === null) throw new Error("regla no objeto");
    const r = item as Record<string, unknown>;
    const action = r["action"], resource = r["resource"], effect = r["effect"];
    if (typeof action !== "string" || !action.trim() || action.length > MAX_PATTERN) throw new Error("regla con action inválida");
    if (typeof resource !== "string" || !resource.trim() || resource.length > MAX_PATTERN) throw new Error(`regla «${action}» con resource inválido`);
    if (typeof effect !== "string" || !EFFECTS.has(effect as Effect)) throw new Error(`regla «${action}» con effect inválido (allow|ask|deny)`);
    rules.push({ action, resource, effect: effect as Effect });
  }
  const rawPolicies = o["policies"] ?? [];
  if (!Array.isArray(rawPolicies)) throw new Error("«policies» debe ser un array");
  const policies: Policy[] = [];
  for (const item of rawPolicies) {
    if (typeof item !== "object" || item === null) throw new Error("policy no objeto");
    const p = item as Record<string, unknown>;
    if (typeof p["action"] !== "string" || !p["action"].trim()) throw new Error("policy con action inválida");
    if (typeof p["resource"] !== "string" || !p["resource"].trim()) throw new Error("policy con resource inválido");
    policies.push({ action: p["action"] as string, resource: p["resource"] as string });
  }
  return { rules, policies };
}

export function readPolicyFile(path: string): { rules: Rule[]; policies: Policy[] } {
  const text = readFileSync(path, "utf8");
  let raw: unknown;
  try { raw = parseJsonc(text, path); } catch (err) { throw new Error(`no es JSON/JSONC válido: ${(err as Error).message}`); }
  return validatePolicyExport(raw);
}

/** Escribe la política del proyecto (sobrescribe). Crea .nicotine/ si falta. */
export function writeProjectPolicy(cwd: string, rules: Rule[], policies: Policy[]): string {
  const target = policyFilePath(cwd);
  mkdirSync(join(cwd, ".nicotine"), { recursive: true });
  const body = JSON.stringify({ version: POLICY_VERSION, permissions: rules.map(({ action, resource, effect }) => ({ action, resource, effect })), policies }, null, 2) + "\n";
  writeFileSync(target, body);
  return target;
}

/** Cadena explicada para action+resource (misma evaluación que el motor real). */
export function explainDecision(cwd: string, configDir: string | undefined, action: string, resource: string, readonly: boolean) {
  const PATH_ACTIONS = new Set(["read", "edit", "list", "write"]);
  let ruleList = annotatedRules(cwd, configDir);
  if (readonly) for (const r of READONLY_RULES) ruleList = [...ruleList, { ...r, source: "cli:--readonly" }];
  const pols = annotatedPolicies(cwd, configDir);
  const engine = new PermissionEngine(ruleList, pols);
  const res = PATH_ACTIONS.has(action)
    ? engine.checkPath(cwd, action, resource)
    : engine.check(action, resource);
  const matched = res.rule ? ruleList.filter((r) => r.action === res.rule!.action && r.resource === res.rule!.resource && r.effect === res.rule!.effect) : [];
  const winning = matched.length ? matched[matched.length - 1] : undefined;
  const near = ruleList.filter((r) => r.action === action || r.action === "*").slice(-8);
  return { effect: res.effect, policy: !!res.policy, rule: res.rule, source: res.policy ? "policy v2" : winning?.source, matched: near };
}
