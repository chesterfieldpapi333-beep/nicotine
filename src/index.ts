// nicotine — entry point y parser de argumentos (sin dependencias).

import { stdin, stdout, stderr } from "node:process";
import { runPrint } from "./modes/print.js";
import { runJson } from "./modes/json.js";
import { runRepl } from "./modes/repl.js";
import { runTui } from "./modes/tui.js";
import { runDoctor } from "./modes/doctor.js";
import { runDoctorSecurity } from "./modes/doctor-security.js";
import { runPolicy } from "./modes/policy.js";
import { runAudit } from "./modes/audit.js";
import { runServe } from "./modes/serve.js";
import { migrateLegacyDataDir } from "./core/migrate.js";
import { mcpServersFromConfig, asDef } from "./compat/mcp/manager.js";
import { runAuthorizationFlow, deleteOauthEntry, readOauthStore } from "./compat/mcp/oauth.js";
import { loadConfig } from "./core/config.js";
import { updateCatalogs } from "./compat/skill-catalog.js";
import { runModelsList, runModelsOverride, runModelsOverrides } from "./modes/models.js";
import { runDownload } from "./modes/download.js";
import { runAnalyze } from "./modes/analyze.js";

const VERSION = "0.2.1";

const HELP = `nic (nicotine) — agente de código CLI ligero (lite)

Uso:
  nic [opciones] [prompt...]     TUI en terminal (ANSI/OpenTUI); REPL plano sin TTY
  nic --print [opciones] [prompt]  un turno; respuesta a stdout
  nic --json  [opciones] [prompt]  eventos JSONL a stdout
  nic doctor [opciones]            diagnóstico
  nic doctor --security [--json]   seguridad del entorno (exit 0 limpio, 1 hallazgos)
  nic policy export [--readonly] [-o archivo]   reglas efectivas con origen
  nic policy import <archivo> [--yes]          valida y aplica política del proyecto (.nicotine/policy.json)
  nic policy explain <action> <resource> [--readonly] [--json]   por qué se permitió/denegó
  nic audit export [-o archivo]      vuelca el JSONL de auditoría (NICOTINE_AUDIT=1 la activa)
  nic mcp auth <nombre>         autoriza (OAuth 2.1+PKCE) a un servidor MCP remoto
  nic mcp logout <nombre>       olvida el token guardado de un servidor MCP remoto
  nic skills update [url…]      descarga catálogos HTTP de skills (discovery) y los cachea
  nic models [--json] [--filter <s>]     lista modelos del proveedor + herramientas/censura (heurística + overrides)
  nic models override <id> …    fija override manual (tools|no-tools|censored|uncensored|unknown)
  nic models overrides          muestra overrides y su ruta
  nic download <url> [-o salida]  descarga robusta (reintentos, límite 128 MiB, sha256)
  nic analyze <archivo> [--json]  análisis estático (magic bytes, sha256; ClamAV y VirusTotal opcionales)

Opciones:
  -p, --print        modo no interactivo (un turno)
      --json         eventos como JSONL
      --readonly     sin escrituras: edit/bash/vault-write → deny (deny-wins, no relajable)
      --solo-bash   perfil «minimal»: solo la tool bash + solo-lectura (read/glob/grep/webfetch)
      serve          servidor HTTP local (apagado por defecto; requiere NICOTINE_SERVER_PASSWORD)
      --port <n>     puerto de serve (defecto 4096)
      --hostname <h> bind de serve (defecto 127.0.0.1)
      --mdns         anuncia el servicio por mDNS/DNS-SD (_nicotine._tcp) al arrancar serve
      --mdns-domain <d> dominio mDNS (defecto nicotine.local); implica --mdns
  -m, --model <id>   modelo (p. ej. openai/gpt-4o-mini); [proveedor/]modelo
      --agent <id>   agente built-in: build | plan | architect | editor
      --auto         auto-aprueba lo que pregunte (deny sigue denegado)
  -c, --continue     reanuda la última sesión
  -s, --session <id> reanuda una sesión concreta
      --fork         bifurca la sesión reanudada (historial copiado, id nuevo)
      --config-dir <dir>  capa extra de configuración (menor precedencia que el proyecto)
  -h, --help         ayuda
      --version      versión

Entorno:
  NICOTINE_UI_ENGINE    motor de TUI: opentui (defecto) | ansi (fallback propio)
  NICOTINE_TUI_CONFIG   ruta alternativa a tui.json(c)
  NICOTINE_MODEL        modelo por defecto
  NICOTINE_SERVER_PASSWORD  contraseña para «nic serve» (obligatoria)
  NICOTINE_VAULT           ruta del vault de Obsidian (memoria persistente)
  NICOTINE_MEMORY_OFF=1    desactiva memoria Obsidian (tools y digest)
  NICOTINE_VT_API_KEY      clave de VirusTotal para «nic analyze» (solo lookup por hash)
  NICOTINE_TOOLCALL_STATS_OFF=1  desactiva estadísticas del rescate de tool-calls en texto

Fallbacks de modelo: provider.fallbackModels en config o NICOTINE_MODEL_FALLBACKS
(coma-separados) — se usan si TODAS las claves fallan con 401/403/429/5xx.

Si stdin no es un TTY, su contenido se añade al prompt entre <stdin>…</stdin>.
Config: opencode.json(c) — capas: /etc/opencode < ~/.config/opencode < proyecto
(raíz→cwd) < .opencode/ < --config-dir. Permisos: allow/ask/deny por acción y
patrón (objeto "permission" v1 o array "permissions" v2).
`;

interface Args {
  command?: string;
  print: boolean;
  json: boolean;
  auto: boolean;
  model?: string;
  agent?: string;
  sessionId?: string;
  continueLatest: boolean;
  fork: boolean;
  configDir?: string;
  port?: number;
  mdns?: boolean;
  mdnsDomain?: string;
  hostname?: string;
  help: boolean;
  version: boolean;
  readonly: boolean;
  soloBash: boolean;
  positional: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { print: false, json: false, auto: false, continueLatest: false, fork: false, help: false, version: false, readonly: false, soloBash: false, positional: [] };
  const next = (i: number, flag: string) => {
    if (i + 1 >= argv.length) throw new Error(`falta valor para ${flag}`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--print": case "-p": args.print = true; break;
      case "--json": args.json = true; break;
      case "--auto": args.auto = true; break;
      case "--model": case "-m": args.model = next(i, a); i++; break;
      case "--agent": args.agent = next(i, a); i++; break;
      case "--session": case "-s": args.sessionId = next(i, a); i++; break;
      case "--continue": case "-c": args.continueLatest = true; break;
      case "--fork": args.fork = true; break;
      case "--config-dir": args.configDir = next(i, a); i++; break;
      case "--port": { const v = next(i, a); const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`--port inválido: ${v}`); args.port = n; i++; break; }
      case "--hostname": args.hostname = next(i, a); i++; break;
      case "--mdns": args.mdns = true; break;
      case "--mdns-domain": args.mdnsDomain = next(i, a); args.mdns = true; i++; break;
      case "--security": args.positional.push("--security"); break;
      case "--readonly": args.readonly = true; break;
      case "--solo-bash": args.soloBash = true; break;
      case "--help": case "-h": args.help = true; break;
      case "--version": args.version = true; break;
      case "doctor": case "serve": case "skills": case "mcp": case "models": case "download": case "analyze": case "policy": case "audit":
        if (!args.command) { args.command = a; break; }
        args.positional.push(a); break;
      case "--": args.positional.push(...argv.slice(i + 1)); i = argv.length; break;
      default:
        if (a.startsWith("-") && a !== "-") throw new Error(`flag desconocido: ${a} (usa --help)`);
        args.positional.push(a);
    }
  }
  return args;
}

async function readStdinIfPiped(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stdin as AsyncIterable<Buffer>) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function main(): Promise<number> {
  migrateLegacyDataDir(); // migración única vireo → nicotine (best-effort, nunca lanza)
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    stderr.write(`nicotine: ${(err as Error).message}\n`);
    return 2;
  }
  if (args.version) { stdout.write(`nicotine ${VERSION}\n`); return 0; }
  if (args.help) { stdout.write(HELP); return 0; }

  const cwd = process.cwd();

  if (args.command === "doctor") {
    if (args.positional.includes("--security")) {
      return runDoctorSecurity({ cwd, configDir: args.configDir, json: args.json || args.positional.includes("--json") });
    }
    return runDoctor({ cwd, configDir: args.configDir, agentId: args.agent, modelFlag: args.model });
  }
  if (args.command === "audit") {
    return runAudit({ cwd, positional: args.positional });
  }
  if (args.command === "policy") {
    return runPolicy({ cwd, configDir: args.configDir, positional: args.positional, readonly: args.readonly, json: args.json || args.positional.includes("--json") });
  }
  if (args.command === "models") {
    if (args.positional[0] === "override") return runModelsOverride(args.positional.slice(1));
    if (args.positional[0] === "overrides") return runModelsOverrides();
    if (args.positional[0] === "help") { stdout.write("uso: nic models [--json] [--filter <s>] | nic models override <id> [tools|no-tools|censored|uncensored|unknown] | nic models overrides\n"); return 0; }
    const filterIdx = args.positional.indexOf("--filter");
    const filter = filterIdx >= 0 ? args.positional[filterIdx + 1] : undefined;
    const json = args.positional.includes("--json") || args.json;
    return runModelsList({ cwd, configDir: args.configDir, json, filter });
  }
  if (args.command === "download") {
    if (!args.positional[0]) { stderr.write("uso: nic download <url> [-o salida] [--max-bytes <n>] [--retries <n>]\n"); return 2; }
    let out: string | undefined;
    let maxBytes: number | undefined;
    let retries: number | undefined;
    for (let i = 1; i < args.positional.length; i++) {
      const p = args.positional[i];
      if (p === "-o") { out = args.positional[i + 1]; i++; }
      else if (p === "--max-bytes") { const v = Number(args.positional[i + 1]); if (!Number.isFinite(v) || v <= 0) { stderr.write("--max-bytes inválido\n"); return 2; } maxBytes = v; i++; }
      else if (p === "--retries") { const v = Number(args.positional[i + 1]); if (!Number.isFinite(v) || v < 1) { stderr.write("--retries inválido\n"); return 2; } retries = v; i++; }
      else { stderr.write(`argumento desconocido: ${p}\n`); return 2; }
    }
    return runDownload({ url: args.positional[0], out, maxBytes, retries });
  }
  if (args.command === "analyze") {
    const target = args.positional[0];
    if (!target) { stderr.write("uso: nic analyze <archivo> [--json]\n"); return 2; }
    return runAnalyze({ file: target, json: args.positional.includes("--json") || args.json });
  }
  if (args.command === "skills") {
    if (args.positional[0] !== "update") { stderr.write("uso: nic skills update [url…]\n"); return 2; }
    const { config } = loadConfig(cwd, { configDir: args.configDir });
    const httpRe = /^https?:\/\//i;
    const fromConfig = Array.isArray(config["skills"])
      ? (config["skills"] as unknown[]).filter((x): x is string => typeof x === "string" && httpRe.test(x))
      : [];
    const urls = [...new Set([...args.positional.slice(1), ...fromConfig])];
    if (!urls.length) { stdout.write("No hay catálogos HTTP en `skills:` (y no se pasaron URLs). Nada que hacer.\n"); return 0; }
    const results = await updateCatalogs(urls);
    let failed = 0;
    for (const r of results) {
      stdout.write(`${r.url}\n  ✓ ${r.ok} skill(s) instalada(s) en caché\n`);
      for (const sk of r.skipped) stdout.write(`  - omitida ${sk.name}: ${sk.reason}\n`);
      for (const e of r.errors) { stdout.write(`  ✗ ${e}\n`); failed++; }
    }
    return failed ? 1 : 0;
  }
  if (args.command === "mcp") {
    return runMcpAuthCli({ cwd, configDir: args.configDir, positional: args.positional });
  }
  if (args.command === "serve") {
    return runServe({ cwd, configDir: args.configDir, auto: args.auto, agentId: args.agent, modelFlag: args.model, sessionId: args.sessionId, continueLatest: args.continueLatest, fork: args.fork, port: args.port, hostname: args.hostname, mdns: args.mdns, mdnsDomain: args.mdnsDomain });
  }

  const stdinText = await readStdinIfPiped();
  const promptBase = args.positional.join(" ").trim();
  const prompt = stdinText ? (promptBase ? `${promptBase}\n\n<stdin>\n${stdinText}\n</stdin>` : stdinText) : promptBase;

  // Ctrl+C: aborta el turno en curso (el loop y bash escuchan esta señal)
  const abort = new AbortController();
  process.on("SIGINT", () => abort.abort());

  const base = { cwd, configDir: args.configDir, auto: args.auto, agentId: args.agent, modelFlag: args.model, sessionId: args.sessionId, continueLatest: args.continueLatest, fork: args.fork, signal: abort.signal, readonly: args.readonly, soloBash: args.soloBash };

  try {
    if (args.json) {
      if (!prompt) { stderr.write("nic --json requiere un prompt (argumento o stdin).\n"); return 2; }
      return await runJson({ ...base, prompt });
    }
    if (args.print) {
      if (!prompt) { stderr.write("nic --print requiere un prompt (argumento o stdin).\n"); return 2; }
      return await runPrint({ ...base, prompt });
    }
    if (prompt) return await runPrint({ ...base, prompt }); // prompt directo = un turno
    if (stdout.isTTY && stdin.isTTY) return await runTui({ ...base }); // TUI interactiva
    return await runRepl(base);
  } catch (err) {
    stderr.write(`nicotine: ${(err as Error).message}\n`);
    return 1;
  }
}

main().then((code) => process.exit(code));


// ————— nicotine mcp auth|logout —————

async function runMcpAuthCli(opts: { cwd: string; configDir?: string; positional: string[] }): Promise<number> {
  const [sub, name] = opts.positional;
  if (sub === "list") {
    const store = readOauthStore();
    const names = Object.keys(store);
    process.stdout.write(names.length ? `OAuth MCP — autorizados (${names.length}): ${names.join(", ")}\n` : "OAuth MCP: ningún servidor autorizado.\n");
    return 0;
  }
  if ((sub !== "auth" && sub !== "logout") || !name) {
    process.stderr.write("uso: nic mcp auth \"<nombre>\" | nic mcp logout \"<nombre>\" | nic mcp list\n");
    return 2;
  }
  if (sub === "logout") {
    const done = deleteOauthEntry(name);
    process.stdout.write(done ? `token de «${name}» eliminado (oauth.json)\n` : `no hay token guardado para «${name}»\n`);
    return 0;
  }
  // auth
  const { loadConfig } = await import("./core/config.js");
  const { config, mcpOrigins } = loadConfig(opts.cwd, { configDir: opts.configDir });
  const entry = mcpServersFromConfig(config).find((s) => s.name === name);
  if (!entry) {
    process.stderr.write(`nic mcp auth: no hay servidor MCP «${name}» en la config (${mcpServersFromConfig(config).map((s) => s.name).join(", ") || "ninguno"})\n`);
    return 2;
  }
  const def = asDef(entry.name, entry.raw, mcpOrigins as Record<string, "system" | "global" | "project" | "custom">, opts.cwd);
  if (def.transport.kind !== "http") {
    process.stderr.write(`nic mcp auth: «${name}» es stdio — usa env/headers en su config; OAuth solo aplica a servidores remotos\n`);
    return 2;
  }
  const oauthCfgRaw = (entry.raw as Record<string, unknown>)["oauth"];
  const oauthConfig = (oauthCfgRaw && typeof oauthCfgRaw === "object" && !Array.isArray(oauthCfgRaw))
    ? { clientId: typeof (oauthCfgRaw as any).clientId === "string" ? String((oauthCfgRaw as any).clientId) : undefined,
        clientSecret: typeof (oauthCfgRaw as any).clientSecret === "string" ? String((oauthCfgRaw as any).clientSecret) : undefined,
        scope: typeof (oauthCfgRaw as any).scope === "string" ? String((oauthCfgRaw as any).scope) : undefined }
    : undefined;
  process.stdout.write(`Abriendo el navegador para autorizar «${name}»…\nsi no se abre solo, copia esta URL:\n`);
  try {
    const { issuer, resource } = await runAuthorizationFlow({
      def,
      oauthConfig,
      timeoutMs: 180_000,
      onUrl: (url) => process.stdout.write(url + "\n"),
    });
    process.stdout.write(`\n✓ «${name}» autorizado (issuer ${issuer}; resource ${resource})\n  token guardado en oauth.json (0600); nunca se muestra. Las próximas sesiones lo usan automáticamente.\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`nic mcp auth: ${(err as Error).message}\n`);
    return 1;
  }
}
