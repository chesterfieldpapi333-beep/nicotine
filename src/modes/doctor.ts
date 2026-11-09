// doctor: qué se cargó, qué quedó pendiente. Fase 1: capas, reglas, modelo, tools.

import { loadConfig } from "../core/config.js";
import { parseConfigCommands } from "../compat/config-commands.js";
import { parseConfigAgents } from "../compat/config-agents.js";
import { loadContextFiles } from "../compat/context-files.js";
import { loadSkillIndex } from "../compat/skills.js";
import { mcpServersFromConfig } from "../compat/mcp/manager.js";
import { discoverExtensions } from "../ext/loader.js";
import { discoverPlugins } from "../compat/plugins.js";
import { findAgent, registerExtraAgents, registerConfigAgents, allAgents } from "../core/agents.js";
import { PermissionEngine } from "../core/permissions.js";
import { ALL_TOOLS } from "../tools/index.js";
import { spawnSync } from "node:child_process";
import { sessionsDir } from "../core/session.js";
import { catalogStatus } from "../compat/skill-catalog.js";

export function runDoctor(opts: { cwd: string; configDir?: string; agentId?: string; modelFlag?: string }): number {
  const { config, rules, policies, layers, warnings: configWarnings, mcpOrigins, extensionOrigins } = loadConfig(opts.cwd, { configDir: opts.configDir });
  let plugins: ReturnType<typeof discoverPlugins>;
  try { plugins = discoverPlugins(opts.cwd); }
  catch (err) { plugins = { plugins: [], warnings: [`descubrimiento multi-CLI falló: ${(err as Error).message}`], unsupported: [], mcp: [], commands: [], themes: [], agents: [], hooks: [], hooksSkipped: [], contextFiles: [], skillSources: [] }; }
  registerExtraAgents(plugins.agents);
  const configAgents = parseConfigAgents(config["agents"]);
  registerConfigAgents(configAgents.agents);
  const contextFiles = loadContextFiles(opts.cwd, config);
  const skills = loadSkillIndex(opts.cwd, config, { extraSources: plugins.skillSources });
  const engine = new PermissionEngine(rules, policies);
  const policyCount = policies.length;
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
  out.push(`Policies v2 (hard-deny post-reglas): ${policyCount}`);
  out.push("");
  out.push("Modelo:");
  const model = opts.modelFlag ?? (config["model"] as string | undefined) ?? process.env.VIREO_MODEL ?? process.env.OPENAI_MODEL ?? "(sin configurar)";
  out.push(`  ${model}`);
  out.push(`  OPENAI_BASE_URL: ${process.env.OPENAI_BASE_URL ?? "(default api.openai.com)"}`);
  out.push(`  OPENAI_API_KEY:  ${process.env.OPENAI_API_KEY ? "definida" : "NO DEFINIDA (los modos que llaman al modelo fallarán con un error claro)"}`);
  out.push("");
  let seleccionado = "build";
  try { seleccionado = findAgent(opts.agentId ?? (config["default_agent"] as string | undefined)).id; }
  catch (err) { seleccionado = `(desconocido: ${(err as Error).message.split(".")[0]})`; }
  out.push(`Agentes: ${allAgents().map((a) => a.id + (a.hidden ? " (oculto)" : "")).join(", ")} (seleccionado: ${seleccionado})`);
  if (configAgents.agents.length) {
    out.push(`Agentes de config «agents» (${configAgents.agents.length}):`);
    for (const a of configAgents.agents) out.push(`  ✓ ${a.id}  (${a.mode ?? "primary"})${a.hidden ? " [oculto]" : ""}${a.disabled ? " [disabled]" : ""}  — ${(a.description || "(sin description)").slice(0, 60)}`);
  }
  for (const w of configAgents.warnings) out.push(`  ! agents: ${w}`);
  out.push(`Tools (${ALL_TOOLS.length}): ${ALL_TOOLS.map((t) => t.name).join(", ")}`);
  out.push("");
  out.push("Archivos de contexto (en orden de aplicación):");
  if (contextFiles.files.length === 0) out.push("  (ninguno encontrado)");
  else for (const f of contextFiles.files) out.push(`  ✓ ${f.path}  (${f.kind}, ${f.bytes} B${f.truncated ? ", TRUNCADO" : ""})`);
  out.push(`Instrucciones de config: ${Array.isArray(config["instructions"]) ? (config["instructions"] as unknown[]).length : 0} orígenes`);
  out.push("");
  out.push(`Skills (${skills.skills.length}${skills.hidden.length ? `, ${skills.hidden.length} ocultas del listado` : ""}):`);
  if (skills.skills.length === 0) out.push("  (ninguna)");
  else for (const sk of skills.skills) out.push(`  ✓ ${sk.id}  [${sk.source}]${sk.disableModelInvocation ? " — disable-model-invocation" : ""}`);
  const httpRe = /^https?:\/\//i;
  const catalogUrls = Array.isArray(config["skills"]) ? (config["skills"] as unknown[]).filter((x): x is string => typeof x === "string" && httpRe.test(x)) : [];
  if (catalogUrls.length) {
    out.push(`Catálogos HTTP de skills (${catalogUrls.length}):`);
    for (const st of catalogStatus(catalogUrls)) {
      out.push(st.downloaded
        ? `  ✓ ${st.url} — ${st.skills.length} en caché${st.updatedAt ? ` (actualizado ${st.updatedAt.slice(0, 10)})` : ""}`
        : `  ! ${st.url} — sin descargar (ejecuta \`vireo skills update\`)`);
    }
  }
  // MCP: se LISTA, nunca se conecta desde doctor (los servidores de proyecto piden confirmación al arrancar)
  const mcpDefs = mcpServersFromConfig(config);
  out.push(`Servidores MCP (${mcpDefs.length}${mcpDefs.length ? ", sin conectar — doctor no los lanza" : ""}):`);
  if (mcpDefs.length === 0) out.push("  (ninguno)");
  else for (const { name, raw } of mcpDefs) {
    const origin = mcpOrigins[name] ?? "project";
    const enabled = raw["enabled"] !== false;
    const kind = !raw["command"] && (raw["url"] || raw["httpUrl"]) ? "remote" : "local";
    const trust = origin === "project" ? " — pide confirmación al arrancar" : ` — confía (${origin})`;
    out.push(`  ${enabled ? "✓" : "✗"} ${name}  [${kind}${trust}]`);
  }
  out.push("");
  // Extensiones: se LISTAN, nunca se importan desde doctor (importar = ejecutar)
  const exts = discoverExtensions(opts.cwd, config, extensionOrigins);
  out.push(`Extensiones (${exts.candidates.length}, sin ejecutar — doctor no las importa):`);
  if (exts.candidates.length === 0) out.push("  (ninguna)");
  else for (const e of exts.candidates) out.push(`  ${e.origin === "project" ? "!" : "✓"} ${e.id}  [${e.origin}] ${e.path}${e.origin === "project" ? " — pide confirmación al arrancar" : ""}`);
  for (const w of exts.warnings) out.push(`  ! ${w}`);
  out.push("");
  const compatWarnings = [...contextFiles.warnings, ...skills.warnings];
  if (compatWarnings.length) {
    out.push("Avisos de carga (skills/contexto):");
    for (const w of compatWarnings) out.push(`  ! ${w}`);
  }
  if (configWarnings.length) {
    out.push("Avisos de config:");
    for (const w of configWarnings) out.push(`  ! ${w}`);
  }
  // ————— Plugins multi-CLI (solo DATOS; nada se ejecuta) —————
  out.push("");
  out.push("Plugins multi-CLI (solo datos — nunca se ejecuta código de terceros):");
  const pl = plugins.plugins;
  if (pl.length === 0) out.push("  (ninguno encontrado)");
  else for (const p of pl) out.push(`  ✓ ${p.kind}  [${p.origin}]  «${p.name}»  — ${p.root}`);
  if (plugins.unsupported.length) for (const u of plugins.unsupported) out.push(`  ! ${u}`);
  // MCP de otras CLIs: listado sin conectar
  out.push(`MCP de otras CLIs (${plugins.mcp.length}${plugins.mcp.length ? ", sin conectar — doctor no los lanza" : ""}):`);
  for (const m of plugins.mcp) {
    const t = !m.raw["command"] && (m.raw["url"] || m.raw["httpUrl"]) ? "remote" : "local";
    out.push(`  ✓ ${m.name}  [${t}, ${m.origin}]  ← ${m.source}${m.origin === "project" ? " — pide confirmación al arrancar" : ""}`);
  }
  out.push(`Comandos de archivo (${plugins.commands.length}):`);
  for (const c of plugins.commands) out.push(`  /${c.name}  [${c.origin}]${c.plugin ? ` (plugin ${c.plugin})` : ""}  ← ${c.source}`);
  const configCmds = parseConfigCommands(config["commands"]);
  out.push(`Comandos de config «commands» (${configCmds.commands.length}):`);
  for (const c of configCmds.commands) out.push(`  /${c.name}${c.agent ? `  agent=${c.agent}` : ""}${c.model ? `  model=${c.model}` : ""}`);
  for (const w of configCmds.warnings) out.push(`  ! ${w}`);
  out.push(`Agentes de archivo (${plugins.agents.length}):`);
  for (const a of plugins.agents) out.push(`  ✓ ${a.id}  (${a.mode})  — ${a.description.slice(0, 60)}`);
  out.push(`Temas de otras CLIs (${plugins.themes.length}):`);
  for (const t of plugins.themes) out.push(`  ✓ ${t.name}  [${t.origin}]  ← ${t.source}`);
  out.push(`Hooks (${plugins.hooks.length}):`);
  for (const h of plugins.hooks) out.push(`  ✓ ${h.event}${h.matcher ? ` matcher=/${h.matcher.source}/` : ""}  [${h.origin}]  ← ${h.source}`);
  for (const sk of plugins.hooksSkipped) out.push(`  - omitido ${sk.source}: ${sk.detail}`);
  if (plugins.mcp.some((m) => m.origin === "project") || plugins.hooks.some((h) => h.origin === "project")) {
    out.push("  ! MCP/hooks de proyecto: se pedirá confirmación al arrancar (igual que los nativos)");
  }
  if (plugins.contextFiles.length) out.push(`Archivos de contexto extra (gemini): ${plugins.contextFiles.map((c) => c.path).join(", ")}`);
  for (const w of plugins.warnings) out.push(`  ! ${w}`);
  out.push("");
  out.push("Entorno:");
  out.push(`  ripgrep: ${spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0 ? "sí" : "NO (grep usa fallback JS)"}`);
  out.push(`  websearch: ${process.env.VIREO_SEARXNG_URL ? "searxng" : process.env.EXA_API_KEY ? "exa" : "sin backend (configura VIREO_SEARXNG_URL o EXA_API_KEY)"}`);
  out.push(`  sesiones: ${sessionsDir()}`);
  out.push("");
  out.push("Avisos de seguridad: la cookie `ndus` de TeraBox u otras credenciales de terceros nunca deben escribirse en la config ni pegarse en el chat.");
  process.stdout.write(out.join("\n") + "\n");
  return 0;
}
