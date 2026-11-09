# Cargar otras CLIs en vireo (fase 7)

Vireo **lee los datos** que dejan en tu máquina Claude Code, OpenCode, Pi, Gemini CLI
y Codex — skills, comandos, agentes, temas, servidores MCP y hooks — para no
obligarte a duplicarlos. **Nunca ejecuta código de terceros**: plugins/extensiones
`.ts`/`.js` se listan en `doctor` como «no soportado» y se ignoran.

## Qué se carga de dónde

| CLI | Rutas (global) | Rutas (proyecto, raíz→cwd) | Qué carga |
|---|---|---|---|
| Claude | `~/.claude/plugins/*/​{commands,agents,skills,hooks}`, `~/.claude/{commands,agents}`, `~/.claude/settings.json` (hooks) | `.claude/plugins/*`, `.claude/{commands,agents}`, `.claude/settings.json` + `settings.local.json` | comandos .md, agentes .md, skills, hooks (Pre/PostToolUse) |
| OpenCode | `~/.config/opencode/{agents,commands,themes}` | `.opencode/{agents,commands,themes}` | comandos .md, agentes .md, temas JSON |
| Pi | `~/.pi/agent/{prompts,themes,agents,skills}` | `.pi/{prompts,themes,agents,skills}` | prompts .md, temas JSON, agentes .md, skills |
| Gemini | `~/.gemini/extensions/*/gemini-extension.json`, `~/.gemini/settings.json` | `.gemini/extensions/*/…`, `.gemini/settings.json` | MCP servers, `contextFileName`, `excludeTools` (skills de extensión vía `skills/`) |
| Codex | `~/.codex/config.toml` | `.codex/config.toml` | `[mcp_servers.*]` (mini-parser TOML sin deps) |
| Claude MCP | — | `.mcp.json` | `mcpServers` (stdio y http/sse) |
| — | `~/.config/opencode/themes`, `~/.pi/agent/themes` | `.opencode/themes`, `.pi/themes` | temas JSON (shape best-effort) |

**No se carga en v1 (y `doctor` lo dice):** plugins `.ts/.js` de opencode (`plugins/`),
packages de Pi en `node_modules` con clave `pi`, `~/.claude.json` (user-scope MCP),
comandos de extensiones Gemini (formato sin verificar), plugins de Claude sin
`.claude-plugin/plugin.json`.

## Compuerta de confianza (igual que MCP nativo)

| Origen | Qué pasa |
|---|---|
| global (tu home) | se usa sin preguntar (es tuyo) |
| proyecto — **datos inertes** (skills, comandos .md, agentes .md, temas, contexto) | se cargan sin preguntar (como las skills) |
| proyecto — **MCP servers** (`.mcp.json`, gemini settings, codex toml, extension mcpServers) | `ui.confirm` **una vez por servidor y sesión**; `--auto` aprueba con aviso; sin TTY rechaza |
| proyecto — **hooks** | una confirmación por sesión que lista las fuentes y avisa que se ata **cada tool call**; rechazo → solo quedan los hooks globales |
| proyecto — código ejecutable (`.ts`) | **nunca**, solo reporte |

## MCP de otras CLIs

Entradas → pipeline MCP normal (`<server>_<tool>`, probe `discover`, timeouts,
compuerta). Shapes aceptadas: `{command, args, env}` (stdio), `{url|httpUrl, headers}`
(remote). **Colisiones:** gana la config nativa de vireo; entre otras CLIs, primero
el proyecto de **dentro hacia fuera**, luego global; aviso en el log al descartar.
`excludeTools` de `gemini-extension.json` oculta esos tools del servidor de esa
extensión.

## Comandos de archivo

Markdown + frontmatter opcional (`description`, `argument-hint`), `$ARGUMENTS`
(resto de la línea crudo) y `$1..$9` (split con comillas). Descubiertos → comandos
slash en la TUI (y paleta): `/mi-comando args`. De un plugin: **`plugin:comando`**
(namespaced). En colisión con un builtin gana el builtin (aviso). `model` y `agent`
del frontmatter se ignoran (aviso). En modos planos no hay dispatch de slash:
el cuerpo no se envía (igual que los built-ins de la TUI).

## Agentes de archivo

`.claude|opencode|pi/agents/*.md` (y `<plugin>/agents/*.md` → `plugin:nombre`).
Frontmatter: `description` **requerida**, `mode: primary|subagent|all` (def:
`subagent`), `tools:` (nombres Claude `Read, Grep, …` → mapeados a vireo; los
no reconocidos se descartan con aviso). Función con `task`: los `subagent` aparecen
como tipos del tool `task` (`subagent_type: "critic"`). Sin `tools:` → todas las
tools menos `task`/`plan-*` (igual que `general`). El cuerpo es el system prompt
adicional. Son datos: no piden confirmación; son subagentes de la sesión, profundidad 1.

## Hooks (PreToolUse / PostToolUse)

Traducción mínima de los hooks de Claude. Fuentes: `~/.claude/settings.json`
(global), `<proyecto>/.claude/settings.json` y `settings.local.json`, y
`<plugin>/hooks/hooks.json`.

- **PreToolUse**: se ejecuta **antes** del diálogo de permisos. `exit 2` → la tool
  **no se ejecuta**; stderr se le devuelve al modelo. Otros códigos → aviso, continúa.
- **PostToolUse**: informativo; nunca bloquea.
- `matcher`: regex sobre el nombre de la tool; ausente/`*` = todas.
- `type: "command"` únicamente. `async` y otros tipos → aviso y omisión.
- Eventos sin equivalente (Notification, Stop, …) → omisión con aviso.
- Ejecución: `bash -lc`, stdin = JSON `{tool_name, args}`, timeout 5 s (máx 30 del
  frontmatter), env: `CLAUDE_PROJECT_DIR`/`VIREO_PROJECT_DIR` = proyecto,
  `CLAUDE_PLUGIN_ROOT` = raíz del plugin (si aplica).
- Variables expandidas en el comando: `${CLAUDE_PROJECT_DIR}`, `${VIREO_PROJECT_DIR}`,
  `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}` y sus formas `$VAR`.

## Temas

Themes JSON de opencode/pi (global, proyecto y plugins). Shape A (tokens vireo
conocidos) se acepta tal cual; shape B (`{"theme":{primary,text,background,…}}`) se
mapea *best-effort* (`primary→accent`, `text→fg`, `background→bg`, `muted→dim`,
`diffAdded→diffAdd`…); ≥2 tokens reconocibles o se descarta con aviso. Aparecen en
`/themes`; en colisión de nombre gana el que ya existía.

## doctor

`vireo doctor` añade la sección **«Plugins multi-CLI»**: plugins descubiertos,
MCP de otras CLIs (sin conectar), comandos de archivo, agentes, temas, hooks
(con matcher y `omitidos`), contexto extra gemini, y avisos. No conecta MCP ni
ejecuta hooks.
