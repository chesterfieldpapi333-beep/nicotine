// nic policy export|import|explain [--json] — reglas efectivas con origen (defaults/config/CLI).

import { existsSync, writeFileSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { buildPolicyExport, explainDecision, policyFilePath, readPolicyFile, writeProjectPolicy, POLICY_VERSION } from "../core/policy.js";

const USAGE = "uso: nic policy export [--readonly] [-o archivo] | nic policy import <archivo> [--yes] | nic policy explain <action> <resource> [--readonly] [--json]\n";

function outJson(data: unknown): void { process.stdout.write(JSON.stringify(data, null, 2) + "\n"); }

export function runPolicy(opts: { cwd: string; configDir?: string; positional: string[]; readonly: boolean; json: boolean }): number {
  const { cwd, configDir, positional, readonly, json } = opts;
  const sub = positional[0];
  const rest = positional.slice(1);

  if (sub === "export") {
    const oIdx = rest.indexOf("-o");
    const target = oIdx >= 0 ? resolve(cwd, rest[oIdx + 1] ?? "") : undefined;
    if (oIdx >= 0 && !target) { process.stderr.write("nic policy export: falta el archivo tras -o\n"); return 2; }
    const data = buildPolicyExport(cwd, configDir, readonly || rest.includes("--readonly"));
    const body = JSON.stringify(data, null, 2) + "\n";
    if (target) { writeFileSync(target, body); process.stdout.write(`política efectiva escrita en ${target} (${data.rules.length} reglas, ${data.policies.length} policies)\n`); }
    else process.stdout.write(body);
    return 0;
  }

  if (sub === "import") {
    const file = rest.find((a) => !a.startsWith("-"));
    const yes = rest.includes("--yes");
    if (!file) { process.stderr.write(USAGE); return 2; }
    const abs = resolve(cwd, file);
    if (!existsSync(abs)) { process.stderr.write(`nic policy import: no existe ${abs}\n`); return 2; }
    let parsed: ReturnType<typeof readPolicyFile>;
    try { parsed = readPolicyFile(abs); } catch (err) { process.stderr.write(`nic policy import: ${(err as Error).message}\n`); return 2; }
    const target = policyFilePath(cwd);
    if (existsSync(target) && !yes) {
      if (process.stdin.isTTY) {
        process.stdout.write(`${target} existe y se sobrescribirá. ¿Continuar? [y/N] `);
        const answer = readLine().trim().toLowerCase();
        if (answer !== "y" && answer !== "sí" && answer !== "s") { process.stdout.write("cancelado.\n"); return 1; }
      } else {
        process.stderr.write(`nic policy import: ${target} existe; relanzá con --yes para sobrescribir\n`);
        return 2;
      }
    }
    const written = writeProjectPolicy(cwd, parsed.rules, parsed.policies);
    process.stdout.write(`política del proyecto importada en ${written} (${parsed.rules.length} reglas, ${parsed.policies.length} policies)\nSe aplica en la próxima ejecución de nic (defaults → config → política → CLI); deny-wins.\n`);
    return 0;
  }

  if (sub === "explain") {
    const args = rest.filter((a) => a !== "--readonly");
    if (args.length < 2) { process.stderr.write(USAGE); return 2; }
    const [action, resource] = args;
    const ro = readonly || rest.includes("--readonly");
    const res = explainDecision(cwd, configDir, action, resource, ro);
    if (json) { outJson({ action, resource, ...res, policyVersion: POLICY_VERSION }); return 0; }
    const lines = [
      `policy explain ${action} «${resource}»`,
      `  decisión: ${res.effect}${res.policy ? " (policy v2: hard-deny post-reglas)" : ""}`,
      res.rule
        ? `  causa:    regla ${res.rule.action} «${res.rule.resource}» → ${res.rule.effect}${res.source ? `  [origen: ${res.source}]` : ""}`
        : `  causa:    sin regla coincidente (default)`,
      `  precedencia: deny gana siempre (aun contra allows guardados); sin deny, la ÚLTIMA regla que coincide gana; las policies v2 se aplican al final (hard-deny).`,
      `  reglas cercanas (últimas ${res.matched.length}):`,
      ...res.matched.map((r) => `    ${r.effect.padEnd(5)} ${r.action}  «${r.resource.slice(0, 80)}»  [${r.source}]`),
    ];
    process.stdout.write(lines.join("\n") + "\n");
    return 0;
  }

  process.stderr.write(USAGE);
  return 2;
}

function readLine(): string {
  const buf = Buffer.alloc(1024);
  try { return buf.subarray(0, readSync(0, buf, 0, buf.length, null)).toString("utf8"); } catch { return ""; }
}
