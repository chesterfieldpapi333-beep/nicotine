// doctor: qué se cargó, qué quedó pendiente. Fase 1: capas, reglas, modelo, tools.

import { loadConfig } from "../core/config.js";
import { PermissionEngine } from "../core/permissions.js";
import { findAgent, BUILTIN_AGENTS } from "../core/agents.js";
import { ALL_TOOLS } from "../tools/index.js";
import { spawnSync } from "node:child_process";
import { sessionsDir } from "../core/session.js";

export function runDoctor(opts: { cwd: string; configDir?: string; agentId?: string; modelFlag?: string }): number {
  const { config, rules, layers } = loadConfig(opts.cwd, { configDir: opts.configDir });
  const engine = new PermissionEngine(rules);
  const out: string[] = [];
  out.push("vireo doctor");
  out.push("============");
  out.push(`cwd:        ${opts.cwd}`);
  out.push(`bun:        ${process.versions.bun ?? "?"} · node: ${process.versions.node}`);
  out.push("");
  out.push("Capas de configuración cargadas (en orden de precedencia):");
  if (layers.length) layers.forEach((l) => out.push(`  ✓ ${l}`));
  else out.push("  (ninguna; se usan defaults)");
  out.push("");
  out.push(`Reglas de permiso activas: ${rules.length}`);
  const deny = rules.filter((r) => r.effect === "deny").length;
  const ask = rules.filter((r) => r.effect === "ask").length;
  out.push(`  allow/ask/deny: ${rules.length - deny - ask}/${ask}/${deny}`);
  out.push(`  external_directory * → ${engine.check("external_directory", "/tmp/ejemplo/*").effect} (spec Vireo: ask por defecto)`);
  out.push("");
  out.push("Modelo:");
  const model = opts.modelFlag ?? (config["model"] as string | undefined) ?? process.env.VIREO_MODEL ?? process.env.OPENAI_MODEL ?? "(sin configurar)";
  out.push(`  ${model}`);
  out.push(`  OPENAI_BASE_URL: ${process.env.OPENAI_BASE_URL ?? "(default api.openai.com)"}`);
  out.push(`  OPENAI_API_KEY:  ${process.env.OPENAI_API_KEY ? "definida" : "NO DEFINIDA (los modos que llaman al modelo fallarán con un error claro)"}`);
  out.push("");
  out.push(`Agentes built-in: ${BUILTIN_AGENTS.map((a) => a.id).join(", ")} (seleccionado: ${findAgent(opts.agentId).id})`);
  out.push(`Tools (${ALL_TOOLS.length}): ${ALL_TOOLS.map((t) => t.name).join(", ")}`);
  out.push("");
  out.push("Entorno:");
  out.push(`  ripgrep: ${spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0 ? "sí" : "NO (grep usa fallback JS)"}`);
  out.push(`  websearch: ${process.env.VIREO_SEARXNG_URL ? "searxng" : process.env.EXA_API_KEY ? "exa" : "sin backend (configura VIREO_SEARXNG_URL o EXA_API_KEY)"}`);
  out.push(`  sesiones: ${sessionsDir()}`);
  out.push("");
  out.push("Pendiente (fases siguientes): skills/context-files (4), MCP (5), extensiones (6), loaders de plugins (7), TUI (2).");
  process.stdout.write(out.join("\n") + "\n");
  return 0;
}
