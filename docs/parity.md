# Vireo — Paridad con OpenCode y CLIs compatibles

> **Nombre del proyecto:** `vireo` (binario `vireo`). Nombre neutro, sin marca ni
> logo de ninguna herramienta existente. Provisional: cambiarlo es tocar un solo
> archivo (`src/version.ts`) + `package.json`.
>
> **Objetivo:** réplica funcional y visual de OpenCode *lite*: mismo conjunto de
> herramientas, mismos flujos de TUI, misma configuración — recontra liviana,
> fácil de aprender y de modificar, compatible con skills/plugins/MCP de otras
> CLIs (Claude Code, Codex, Gemini CLI, OpenCode, Pi y similares).
>
> **Fecha de investigación:** 2026-11-08. **Estado del código:** Fase 6 implementada —
> Ext API lite (`src/ext/`): on/registerTool/registerCommand/registerShortcut/ui.setSlot/
> addWidget/setTheme; slots TUI; descubrimiento con compuerta de confianza; extensión de
> referencia (`examples/extensions/shout.ts`); MCP prompts → comandos dinámicos
> `/<server>:<prompt>`; aprobaciones «always» persistentes por proyecto.
> `bun test` → 148/148 verde. `/fusion` diferido (sin spec).
> Esta tabla es la guía de las fases 2–8.

## Leyenda

| Estado | Significado |
|---|---|
| `hecho` | Implementado y probado en este repo |
| `parcial` | Parte hecha o diseño cerrado, falta el resto |
| `falta` | No empezado (columna "Fase" indica cuándo) |
| `sin verificar` | No se pudo confirmar contra fuente oficial; queda como TODO |

## Fuentes consultadas (2026-11-08)

**OpenCode (referencia principal)**
- Docs v2 actuales: <https://opencode.ai/docs/> (tools, permissions, agents, config, mcp-servers, skills, plugins, cli)
- Docs TUI/keybinds (heredadas de v1): <https://docs.opencode.ai/docs/tui/>, <https://docs.opencode.ai/docs/keybinds/>
- Repo: <https://github.com/anomalyco/opencode> (MIT) · OpenTUI: <https://github.com/anomalyco/opentui> (MIT)

**Otras CLIs (compatibilidad)**
- Agent Skills (estándar): <https://agentskills.io> · spec: <https://github.com/agentskills/agentskills/blob/main/docs/specification.mdx>
- Claude Code: <https://code.claude.com/docs/en/skills>, <https://code.claude.com/docs/en/plugins/manifest-reference>
- Codex: `~/.codex/config.toml` `[mcp_servers.*]`, `.agents/skills/`, `AGENTS.md` (jerarquía por directorio)
- Gemini CLI: <https://geminicli.com/docs/reference/configuration/> (`mcpServers`, `httpUrl`, extensiones `gemini-extension.json`)
- Pi: <https://github.com/earendil-works/pi> (`package.json` clave `pi`, `~/.pi/agent/skills`, `.agents/skills`)

## Nota importante: OpenCode v1 vs v2

OpenCode está en transición v1 → v2. Esto afecta nombres; Vireo decide así:

| Concepto | v1 (docs.opencode.ai) | v2 (opencode.ai/docs) | **Decisión Vireo** |
|---|---|---|---|
| Config | `opencode.json(c)`, `permission: { "bash": { "*": "ask" } }` | `permissions: [{action,resource,effect}]` ordenadas (última gana) | Leer **ambas**: `permission` (objeto, como pidió el spec) y `permissions` (array v2). Se traducen al mismo modelo interno |
| Shell tool | `bash` | `shell` | Nombre clásico **`bash`** (es el que usan todas las CLIs). Aceptar alias `shell` en config |
| Permission actions | `bash`, `edit`, `read`… | `shell`, `edit`, `read`… | Aceptar ambos nombres en reglas |
| Subagente tool | `task` | `subagent` | Clásico **`task`**, alias `subagent` |
| Novedades v2 | — | `execute` (Code Mode), worktrees, browser, políticas | **Fuera de lite v1**; `execute` y browser se marcan `falta (v-lite-2)` |
| Default allow | v1: `ask` por defecto en muchos casos | v2 base: `*` allow + `.env` ask | **v2 base**: `*` allow excepto `*.env`/`*.env.*` ask, `*.env.example` allow (documentado en defaults) |
| Directorio externo | `external_directory` ask | default allow | Default v2 (allow) + regla opcional `ask` |
| MCP | `mcp` directo | `mcp.servers`, `protocol: legacy\|auto\|2026-07-28` | **Espejo de v2** (verificado, ver abajo) |
| Skill discovery | `.opencode/skills`, `~/.claude/skills`, `~/.agents/skills` | igual + `skills: []` en config (paths y HTTP catalogs) | Igual + orígenes de todas las CLIs (tabla Compat) |
| Plugin JS ejecutable | soportado | soportado | **No en v1**: solo carga de *datos* (skills/commands/MCP/hooks/themes); código ejecutable de plugins = reporte `doctor` |

## Tabla de paridad

### A. Núcleo (`src/core/`)

| Función | Estado | Ref / nota | Fase |
|---|---|---|---|
| Loop agéntico (stream → tool calls → resultados, multi-paso) | hecho (maxSteps 50) | OpenCode v2 loop; patrón ReAct estándar | 1 |
| Eventos tipados (`text_delta`, `tool_start`, `tool_end`, `turn_end`, `error`, `todos_updated`, `session_saved`) — el núcleo no imprime | hecho | spec; base para serve + TUI + print/json | 1 |
| Proveedor OpenAI-compatible con streaming (chat/completions) | hecho (SSE manual; `--model` con prefijo `proveedor/` informativo) | `/docs/providers`; baseURL+apiKey+model en config/env | 1 |
| Adaptador Vercel AI SDK opcional (desactivado por defecto) | falta | `ai` + `@ai-sdk/openai-compatible`; detrás de flag | 1 |
| Sesión en JSONL (append-only, sin ORM) | hecho — create/load/list/título/fork/remove; fork herida del historial (`--fork`); padres→hijos en `task` | spec; una línea por mensaje/evento | 1 / 3 |
| Contexto: instrucciones + skills + tools en el prompt | hecho — system prompt + archivos de contexto (AGENTS/CLAUDE/GEMINI, raíz→cwd) + listado de skills (nombre+desc; body bajo demanda) | spec + `/docs/agents` | 1/4 |
| Compactación (auto al llenar buffer; keep.tokens) | hecho (un paso: resumir lo viejo, conservar cola `keep_tokens`; corte seguro sin partir tool_calls; fallo limpio sin tocar el historial; estimación chars/4, sin tokenizer) — dos pasos en fase 8 | `/docs/config#compaction`; claves `compaction.auto`, `threshold_tokens`, `keep_tokens` | 3 / 8 |
| Undo/redo de cambios de archivos por turno | hecho — snapshots pre/post de archivos tocados por write/edit/apply_patch (2 MB/archivo); `bash` registrado pero NO deshacible; **desviación del spec:** sin git (funciona fuera de repos); respaldo automático del estado actual en `pre-undo/` antes de sobrescribir/borrar (la edición post-turno del usuario nunca se pierde); la conversación no se toca | spec lite; `/docs/snapshots` | 3 |
| Subagentes (sesiones hijas, depth 1) | hecho — tool `task` (general/explore); explore deniega edición; sesión JSONL hija con título `task: …`; eventos de tools del hijo etiquetados `[agent]` para la UI; el hijo no ve el historial del padre salvo en el prompt; profundidad 1 (sin `task` dentro); misma señal de abort; heredan provider (sin config multi-modelo en lite) | `task` tool; `/docs/agents` | 3 |
| Failover de modelos / rotación de claves ante 429/401 | falta | spec fase 8 | 8 |
| Fallback tool-calls en texto (modelos sin FC nativo) | falta | spec fase 8 | 8 |
| Memoria por proyecto (`.vireo/memory` o similar) | falta | spec fase 8 | 8 |
| Tool `lsp` (experimental, diagnósticos) | falta | `/docs/tools`; cliente LSP mínimo | 1 (stub) / 8 |

### B. Herramientas (`src/tools/`) — paridad OpenCode lite

| Herramienta | Estado | Ref / nota | Fase |
|---|---|---|---|
| `read` (líneas numeradas, 2000 líneas/50 KiB, offset/limit) — imágenes/PDF devuelven nota textual | hecho | `/docs/tools#read` | 1 |
| `write` (crea dirs padres) | hecho | `/docs/tools#write` | 1 |
| `edit` (lectura previa obligatoria; estrategias exacta → trimEnd por línea → trim+re-indent; **diff antes de pedir permiso**; LSP diagnostics pendientes) | hecho | `/docs/tools#edit` + spec (estrategias propias) | 1 |
| `apply_patch` (patch multi-archivo `*** Add/Update/Delete File` + `*** Move To`) | hecho | `/docs/tools#patch`; expuesto a modelos GPT; `patch` vs `apply_patch` nombre clásico | 1 |
| `bash` (shell $SHELL o /bin/sh — config `shell` aún sin efecto; timeout 2 min; abort SIGTERM→SIGKILL; background básico: log en tmp, sin notificación) | hecho | `/docs/tools#shell` + spec (abort) | 1 |
| `glob` (`**/*.ts`, `path`, `hidden`, `limit` 100, timeout 30 s, `.gitignore` subconjunto) | hecho | `/docs/tools#glob` | 1 |
| `grep` (regex o `literal`, `path`/`include`/`caseSensitive`/`limit` 100, timeout 30 s, ripgrep si existe; fallback JS — `.gitignore` parcial) | hecho | `/docs/tools#grep` | 1 |
| `list` (listado no recursivo de directorio) | hecho | `read` cubre dir en OpenCode; spec pide `list` aparte | 1 |
| `webfetch` (URL → markdown/text/html; timeout ≤ 120 s; conversor HTML→md naive) | hecho | `/docs/tools#webfetch` | 1 |
| `websearch` (backends: `VIREO_SEARXNG_URL` o `EXA_API_KEY`; sin backend devuelve instrucciones, no rompe el loop) | hecho | `/docs/websearch`; sin credencial → tool ausente + aviso | 1 |
| `task` (subagentes general/explore) | hecho | `/docs/agents`; ver A | 3 |
| `plan-enter`, `plan-exit` (cambio de agente con consentimiento; plan-exit pide confirmación) | hecho (spec lite; v2 no los tiene como tools) | `/docs/cli`; `plan_exit` draft de permisos | 3 |
| `todowrite` (lista de tareas de la sesión) | hecho | `/docs/config#todos`; en Vireo activado por defecto (era tool clásica) | 1 |
| `question` (flat: readline numerado; TUI fase 2; sin TTY → null) | hecho | `/docs/tools#question`; requiere cliente interactivo; sin él → auto-respuesta vacía + aviso | 1 |
| `skill` (carga body de SKILL.md por ID; solo nombre+descripción en prompt) | hecho — tool `skill`, cuerpo ≤16 KiB, archivos de soporte ≤10 listados; ids ocultados siguen cargándose; error listando disponibles | `/docs/skills` | 4 |
| `task` (subagente; depth 1; se ejecuta en bloque) | hecho (fase 3) — alias v2 `subagent` sin tool aparte | `/docs/tools#subagent` (v2); clásico `task` | 3 |
| `lsp` (experimental: diagnostics del servidor LSP si hay uno configurado) | falta | v2 no la lista como acción core; spec fase 1/8 | 8 |
| `plan-enter` / `plan-exit` (cambiar agente build↔plan dentro de la sesión) | hecho (fase 3) — nombres con guión; plan-exit pide confirmación | v2 los pliega en agente plan | 3 |
| MCP tools (`<server>_<tool>`, saneado `[^a-zA-Z0-9_-]` → `_`) | hecho — ver sección J | `/docs/mcp-servers#names` | 5 |
| `execute` / Code Mode (v2) | **fuera de alcance lite** | `/docs/tools#execute` | — |
| `image_generate`, `browser`, worktrees (v2) | **fuera de alcance lite** | `/docs/tools` | — |

### C. Permisos (`src/core/permissions.ts`)

| Función | Estado | Ref / nota | Fase |
|---|---|---|---|
| Reglas ordenadas `allow`/`ask`/`deny` por acción y patrón (`*`, `?`, valor completo; `cmd *` casa `cmd`) | hecho | `/docs/permissions#matching` | 1 |
| Objeto v1 `permission` + array v2 `permissions` concatenado entre capas (defaults < system < global < proyecto < .opencode < --config-dir < agente) | hecho | ver "v1 vs v2" | 1 |
| Defaults: `*` allow; `read *.env`/`*.env.*` ask; `*.env.example` allow | hecho | `/docs/permissions#defaults` | 1 |
| `external_directory` — en Vireo es **ask** por defecto (spec), configurable; expansión `~` `$HOME` | hecho (desviación deliberada del default v2) | `/docs/permissions#directories`; **pregunta extra en TUI si la regla es ask** | 1 |
| Regla compuesta (patch multi-archivo vía `permissionResources`; `deny` > `ask` > `allow`) | hecho | `/docs/permissions#matching` | 1 |
| Saved approvals ("always" guarda patrón en memoria de sesión — para rutas, `carpeta/*`; persistencia proyecto-scoped: fase 3; nunca pisan `deny`) | parcial | `/docs/permissions#approvals` | 3 |
| Diálogo de aprobación en TUI con diff (once/always/reject + feedback) | hecho (flechas+enter, y/a/n, diff coloreado truncado al alto) | `/docs/permissions#approvals`; `permission.prompt.fullscreen` no soportado (lite) | 2 |
| Scanner de shell (heurística conservadora; el recurso es el comando completo; análisis por subcomandos: pendiente) | parcial | `/docs/permissions#scanner`; Vireo lite: splitter conservador (`&&`, `||`, `;`, `|`, `$()`, backticks), sin parser completo → **sin verificar cobertura completa** | 1 |
| `policies` v2 (hard-deny post-reglas) | falta | `/docs/permissions#policies` | 8 |
| Política aplicada en `before_tool` (dentro de `executeTool`: deny→error, ask→diff+confirmación) | hecho | spec + `/docs/plugins` | 1 |

### D. Configuración (`src/core/config.ts`)

| Función | Estado | Ref / nota | Fase |
|---|---|---|---|
| `opencode.json` y `opencode.jsonc` (JSONC propio: comentarios y trailing commas, respeta strings) | hecho | `/docs/config#format` | 1 |
| Capas: system < global < proyecto (raíz→cwd) < `.opencode/` < `--config-dir` (custom) | hecho | `/docs/config#locations` | 1 |
| Carpetas plurales: `agents/`, `commands/`, `skills/`, `plugins/`, `themes/` — `skills/` leída (fase 4); el resto faltan (fases 6–7) | parcial | `/docs/config#locations` | 1+ |
| Sustitución `{env:VAR}` y `{file:path}` en strings | hecho (`{file:}` relativo al dir del config) | `/docs/config#variables` | 1 |
| `$schema` ignorado con aviso si desconocido; claves desconocidas → aviso, no error | hecho (top-level; se lista en `doctor`) | spec (skills) + `/docs/config` | 1 |
| `model` (flag `--model` > config > `VIREO_MODEL`/`OPENAI_MODEL`), `default_agent` → hecho; resto (`snapshots`, `compaction`, `instructions`, `skills`, `commands`, `mcp`, …) se parsea pero aún sin efecto — fases 3–7 | parcial | `/docs/config` | 1 (subconjunto) / 3+ |
| `tui.json` separado (theme, leader_timeout 2000, keybinds, scroll_speed, diff_style, mouse, cursor) | falta | `/docs/tui#configure` | 2 |
| Precedencia admin: managed prefs macOS / system dir | **fuera de alcance lite** | `/docs/config#locations` | — |

### E. Agentes (`src/core/agents` + `agents/`)

| Función | Estado | Ref | Fase |
|---|---|---|---|
| Built-ins `build` (primary) y `plan` (primary, deniega edit; plan files aún no) — vía `--agent`; `general`/`explore` y `/init`: fase 3 | parcial | `/docs/agents#built-ins` | 1 (defs) / 3 |
| Agentes en Markdown con frontmatter (`description`, `mode`, `model`, `permissions`) — body = system prompt; ID `team/reviewer` por subdirectorio | falta | `/docs/agents#formats` | 1/3 |
| Merge: escalares reemplazan, permissions se **añaden** | falta | `/docs/agents#merging` | 1 |
| `default_agent`, selección con fallback (build → primer primary visible) | falta | `/docs/agents#selection` | 3 |
| Modos `primary`/`subagent`/`all`; profundidad subagentes = 1 | falta | `/docs/agents#modes` | 3 |
| Ocultar `compaction`/`title`/`summary` (internos, no seleccionables) | falta | `/docs/agents#built-ins` | 3 |

### F. Comandos slash built-in (TUI y print)

| Comando | Estado | Ref | Fase |
|---|---|---|---|
| `/help`, `/models`, `/new` (`/clear`), `/sessions` (`/resume`,`/continue`), `/compact` (`/summarize`) | hecho — además `/fork` (bifurca y cambia a la nueva); `/sessions` con renombrar (`r`) y borrar (`d`, con confirmación) en la TUI | `/docs/tui#commands` | 2/3 |
| `/undo`, `/redo` | hecho — ver A (sin git) | `/docs/tui#undo` | 3 |
| `/init` (crea/actualiza `AGENTS.md` guiado) | hecho — `/init` envía un prompt canned al agente (explora, escribe/fusiona AGENTS.md con la tool write/edit; requiere un proveedor real para el análisis) | `/docs/tui#init`, `/docs/rules` | 3 |
| `/themes`, `/thinking`, `/export`, `/editor`, `/connect` (API keys), `/exit` (`/quit`,`/q`) | parcial — `/themes`,`/thinking`(informativo),`/exit` en TUI; `/export`,`/editor`,`/connect` falta | `/docs/tui#commands` | 2/3 |
| `/plan` (entrar/salir de agente plan) | hecho vía tools `plan-enter`/`plan-exit` (el modelo puede pedir el cambio); tab cicla build/plan manualmente | spec `plan-enter/plan-exit` | 3 |
| Comandos de archivo `commands/*.md` (frontmatter: description, model, agent; `$ARGUMENTS`; argumentos `$1..`/`$NAME`? — **sin verificar sintaxis exacta de args en v2**) | falta | `/docs/commands` | 4 |
| Comandos de MCP prompts `<server>:<prompt>` | hecho — comandos dinámicos en TUI; args posicionales→orden declarado (required ausente → error de uso); el prompt renderizado se envía como turno del usuario | `/docs/commands` | 5/6 |
| Comandos custom desde config `commands: {}` | falta | `/docs/config#commands` | 4 |

### G. TUI (`src/ui/`)

| Función | Estado | Ref / nota | Fase |
|---|---|---|---|
| Motor `ansi` propio y mínimo (respaldo + `--print`-ish flat) | hecho (alt screen, SGR pass-through, diff-paint por línea, decodificador propio) | spec; primer entregable de UI | 2 |
| Motor `opentui` (`@opentui/core`, MIT) detrás de la interfaz de componentes | hecho (0.8.3; un `TextRenderable` por fila + `setCursorPosition`; `keyInput.on("keypress")`; verificado con `createTestRenderer` headless y bajo pty) | `/docs/tui`; fallback automático a ANSI si falla el arranque (`VIREO_UI_ENGINE=ansi` lo fuerza) | 2 |
| Flujos: stream de mensajes, editor de prompt, autocompletado `@file` (fuzzy), `!comando` shell | parcial — stream, editor multilínea (ctrl+j), `@file` fuzzy con walk propio (skip dirs, tope 6k); `/` comandos; `!comando` shell NO (evita saltarse permisos; el agente ya ejecuta bash con permisos) | `/docs/tui` | 2 |
| Selector de modelos (`/models`, `ctrl+x m`), lista de sesiones (`ctrl+x l`), ciclo de agentes (`tab`) | hecho para la sesión en curso (fetch `GET {baseURL}/models`; sesión nueva en memoria); persistencia permanente = editar `opencode.json`; ciclo tab entre build/plan reconstruye permisos+system prompt | `/docs/tui`, `/docs/keybinds` | 2 |
| Diálogo de permisos con diff, selector de agente, selector de tema, help | hecho (selector de agente = tab cicla; `/help` lista atajos) | `/docs/keybinds`, `/docs/tui` | 2 |
| Vista de diffs (inline, `diff_style: auto\|stacked`) | parcial — color ✓/✗/+/−/@@ en tarjetas de tool y diálogo de permiso; `diff_style` se lee del tui.json pero aún no cambia el layout | `/docs/tui#configure` | 2 |
| Keybinds: leader `ctrl+x`, `tui.json` merge-over-defaults, `"none"` para desactivar | hecho (subset v1: leader, session/model/theme/agent lists, exit, submit, newline, paginado, ciclo agente; `<leader>x` notación; unión por comas) | `/docs/keybinds` (tabla completa) | 2 |
| Temas como JSON de tokens; `themes/` carpeta | hecho (vireo-dark/vireo-light built-in; merge por tokens parciales; `themes/`, `.opencode/themes/`, `.vireo/themes/` de raíz→cwd + `~/.config/opencode|vireo/themes`) | `/docs/themes` | 2 |
| Extensibilidad: `on(evento)`, `registerTool`, `registerCommand`, `registerShortcut`, `ui.setSlot` (header/messages/widgets/editor/footer), `ui.addWidget`, `ui.setRenderer`, `ui.setTheme` | hecho (`src/ext/`) — API propia lite; `on`/`registerTool` funcionan en todos los modos; comandos/atajos/slots/temas solo TUI (no-op con aviso fuera); descubrimiento global (`~/.config/vireo/extensions`), proyecto (`.vireo/extensions/`, raíz→cwd) y `extensions: []` en config; proyecto = compuerta de confianza ANTES de importar (doctor no importa); `ui.setRenderer` descartado (contradiría al motor); componente = `render(width): string[]` (render-only, sin `onKey` v1); atajos exigen ctrl/alt (`ctrl+g`…`alt+f2`); los builtins ganan en colisiones; referencia en `examples/extensions/shout.ts` | spec (API propia, no hay fuente OpenCode pública 1:1 → **diseño propio**) | 6 |
| Componente `{ render(width): string[]; onKey?(key): boolean }` envuelto en try/catch | hecho (`src/ui/component.ts`, `safeRender`/`safeOnKey`); la TUI pinta slots/widgets de extensiones vía `safeRender` (errores de componente no tumban el frame) | spec | 2/6 |

### H. Sesiones / historial (`src/core/session.ts`)

| Función | Estado | Ref | Fase |
|---|---|---|---|
| Sesiones JSONL en `~/.local/share/vireo/sessions/<id>.jsonl` (o `XDG_DATA_HOME`) | hecho | spec; ruta exacta ≠ OpenCode (sería `storage/session`) — decisión propia documentada | 1/3 |
| `--continue`, `--session <id>`, `--fork` | hecho (`--fork` bifurca la sesión sin tocar la original; `--fork` sin `-c`/`-s` bifurca la última) | `/docs/cli` (tui flags) | 3 |
| Título auto, listar/renombrar/borrar/cambiar | hecho — `/sessions`: cargar (enter), renombrar (`r`), borrar (`d` con confirmación; la sesión activa no se puede borrar); título auto desde el primer prompt | `/docs/cli` (agent create), `session_*` | 3 |
| Undo/redo por turno (sin git; pre/post imagen + respaldo `pre-undo/`) | hecho — ver sección A; `snapshots: false` aún sin efecto (config flag pendiente, fase 8) | `/docs/snapshots` | 3 |

### I. Skills (`src/compat/skills.ts`)

| Función | Estado | Ref / nota | Fase |
|---|---|---|---|
| Formato `SKILL.md`: frontmatter YAML (`name` ≤64, `description` ≤1024, opcionales `license`/`compatibility`/`metadata`/`allowed-tools`) + body Markdown | hecho — parser YAML propio mínimo (`yaml-lite.ts`, anidamiento ≤3 niveles, sin deps); `name`/`description` requeridos; desconocidas → aviso; body ≤16 KiB al cargar | agentskills.io spec; Claude Code skills docs | 4 |
| Carpetas escaneadas (global + proyecto): `~/.config/opencode/skills`, `.opencode/skills`, `~/.claude/skills`, `.claude/skills`, `~/.agents/skills`, `.agents/skills`, `~/.codex/skills`? — *Codex usa `.agents/skills` (verificado) y `~/.agents/skills`*; `~/.pi/agent/skills`, `.pi/skills`; `.gemini/skills`? **sin verificar** (Gemini docs mencionan "Agent skills" sin ruta clara en lo leído) → se incluye `.gemini/skills` como candidato con flag | hecho — global: opencode/claude/agents/pi (+gemini tras flag `compat.geminiSkills`, default false); proyecto raíz→cwd: `.opencode/skills`, `.claude/skills`, `.agents/skills`, `.pi/skills` (+gemini tras flag); `~/.codex/skills` NO se escanea (sin verificar) | OpenCode `/docs/skills` (Discovery); Pi docs; Codex blog; Gemini CLI ext docs | 4 |
| Carga: solo nombre+descripción al inicio; body bajo demanda (tool `skill`); base dir + sample de hasta 10 archivos de soporte | hecho — `# Skills disponibles` en el system prompt; tool `skill` devuelve cuerpo + directorio + ≤10 archivos de soporte | `/docs/skills#loading` | 4 |
| Claves desconocidas → ignorar con advertencia (no error) | hecho (también claves desconocidas TOP-LEVEL de la config) | `/docs/skills#frontmatter` + spec | 4 |
| `skills: ["./dir", ...]` en config | parcial — paths locales hechos (dir escaneado un nivel `*/SKILL.md` + SKILL.md suelto, o archivo directo); **HTTP catalogs NO soportados** (sin fetch en el arranque; se hará cuando la init sea asíncrona o con fetch acotado por timeout) — aviso claro, no fallo | `/docs/skills#sources`,`#catalogs` | 4 |
| Precedencia por ID (última fuente gana; orden documentado) | hecho — global → proyecto (raíz→cwd) → `config.skills` (lo último referido gana; se avisa de pisado) | `/docs/skills#precedence` | 4 |
| `disable-model-invocation` / `metadata.opencode.autoinvoke: false` → oculta del listado, load explícito permitido | hecho (ambos; el tool `skill` sigue cargándolos por id) | `/docs/skills#frontmatter` | 4 |
| Validación name 1–64 `^[a-z0-9]+(-[a-z0-9]+)*$`, match con directorio — *OpenCode v2 no la enforcea; Vireo avisa, no rechaza* | hecho (aviso; la skill se carga igualmente) | agentskills spec + `/docs/skills#ids` | 4 |

### J. MCP (`src/compat/mcp/`)

**Verificado (2026-11-08):**
- La spec **2026-07-28** existe y hace MCP **stateless**: sin `initialize`, sin `Mcp-Session-Id`; cada request lleva `_meta` con `io.modelcontextprotocol/protocolVersion`, `clientCapabilities`, `clientInfo`; servidores **MUST** implementar `server/discover` (devuelve `supportedVersions`, capabilities, identity); clientes pueden enviar cualquier request y reintentar ante `UnsupportedProtocolVersionError`. Headers requeridos `Mcp-Method`, `Mcp-Name`; `resultType: complete|input_required`. [1](https://cloudsoftsol.com/blog/mcp-2026-spec-changes/) [2](https://dev.to/fabwaseem/stateless-mcp-servers-what-the-2026-07-28-spec-changed-and-how-to-migrate-5ccl) [3](https://tempreon.com/blog/mcp-went-stateless)
- npm: **`@modelcontextprotocol/client@2.4.0`** (nuevo paquete split; MIT; deps `@modelcontextprotocol/core@2.4.0`, zod ^4) — la línea v2 para el spec 2026-07-28. **`@modelcontextprotocol/sdk@1.32.2`** sigue como línea legacy (initialize, ≤ 2025-11-25). **Verificado en registry.npmjs.org.**
- OpenCode expone `protocol: legacy (default, initialize) | auto (probe server/discover, fallback legacy) | 2026-07-28 (estricto)`; `auto` en una sonda local añade proceso extra → acotar. [4](https://opencode.ai/docs/mcp-servers/#protocol-version)

| Función | Estado | Ref / nota | Fase |
|---|---|---|---|
| stdio servers (command/args/env/cwd) | hecho — JSON-RPC 2.0 por \n, sin deps; `env` o `environment`; `enabled:false` deshabilita; client hand-rolled | `/docs/mcp-servers#local` | 5 |
| Streamable HTTP servers (url/headers) | hecho — POST con SSE o JSON directo; `mcp-session-id` capturado/reenviado (legacy con sesión); timeouts por petición | `/docs/mcp-servers#remote` | 5 |
| **2026-07-28 stateless** | hecho — **desviación:** cliente propio mínimo SIN dependencias (el API de client@2.4.0 no está verificado; filosofía lite); `_meta` con `io.modelcontextprotocol/protocolVersion` + headers `Mcp-Method`/`Mcp-Name`; verificado contra fake HTTP en tests | spec 2026-07-28 | 5 |
| **Fallback a initialize:** `protocol: auto` → probe `server/discover`; si falla/timeout → reintenta con handshake legacy (anunciando última versión ≤ 2025-11-25); `legacy` = solo initialize; `2026-07-28` = estricto | hecho — stdio default `legacy`, HTTP default `auto`; escalera initialize 2025-11-25→2025-06-18→2025-03-26→2024-11-05 (solo baja si el servidor rechaza la versión); `2026-07-28` estricto falla limpio | `/docs/mcp-servers#protocol-version` + spec 2026-07-28 | 5 |
| `server/discover` sonda antes de `tools/list` | hecho (probe manual; si anuncia 2026-07-28 → modo stateless, si no → fallback) | spec 2026-07-28 | 5 |
| Normalización nombres `<server>_<tool>` (sanear a `[a-zA-Z0-9_-]`) | hecho — colisiones: primera gana + aviso; tools de resources con nombre fijo + `server` enum: `opencode_list_mcp_resources` / `opencode_read_mcp_resource` | `/docs/mcp-servers#names` | 5 |
| Config multi-origen: OpenCode `mcp` (v2 `mcp.servers`; legacy top-level `mcp.<name>` — **aceptar ambas**, v2 pisa clásica), `.mcp.json` (Claude), Codex TOML, Gemini settings.json | parcial — OpenCode hecho (ambos shapes); Claude/Codex/Gemini vía loaders en fase 7 | docs de cada CLI (ver Fuentes) | 5/7 |
| Timeouts (startup/catalog/execution; per-server override) | hecho — defaults 5s/10s/60s; `timeouts: {startup, catalog, execution}` o `startup_timeout_ms`/`catalog_timeout_ms`/`tool_timeout_ms` (o `timeout`) | `/docs/mcp-servers#timeouts` | 5 |
| Confianza explícita antes de lanzar MCP de proyecto/paquete de terceros (diálogo; `trust` de Gemini **no** se honra en silencio) | hecho — project-origin → `ui.confirm` (una vez por servidor y sesión) con resumen de comando/URL + NOMBRES de env/headers (valores jamás); `--auto` aprueba con aviso; sin TTY rechaza; system/global/custom no preguntan; `doctor` nunca lanza servidores | spec + modelo Gemini `trust` | 5 |
| OAuth remoto (PKCE, CIMD/DCR) | **fuera de alcance lite v1** (headers + env vars sí) | `/docs/mcp-servers#oauth` | — |
| MCP prompts → comandos `<server>:<prompt>` | hecho — `prompts/list` probe tras `tools/list` (capability-gated); `prompts/get` renderiza `role: text`; nombre saneado a `[a-zA-Z0-9_:-]`; columna de autocompletado y dispatch aceptan `:`; `splitArgs` con comillas | `/docs/mcp-servers#prompts` | 5/6 |
| MCP resources (`opencode_list_mcp_resources`…) | hecho — solo si el servidor anuncia capability: tools fijas `opencode_list_mcp_resources` y `opencode_read_mcp_resource` con `server` enum; texto y blob (blob: nota, sin binario) | `/docs/mcp-servers#resources`, `#names` | 5 |
| Confianza/verificación del SDK: **API exacta de client@2 (auto-fallback interno vs probe manual) — sin verificar** | resuelto por desviación: cliente propio hand-rolled (ver fila stateless); client@2.4.0 existe pero no se usa | npm registry (existe, MIT) | 5 |

### K. Plugins y hooks por origen (`src/compat/`)

| Loader | Estado | Qué carga | Ref | Fase |
|---|---|---|---|---|
| `claude` | falta | Skills `.claude/skills`, commands `.claude/commands/*.md`, agents, `.mcp.json`, hooks de `settings.json` + `hooks/hooks.json` de plugin, `.claude-plugin/plugin.json` (datos: name/description/version/components; **no ejecuta código**) | code.claude.com skills/plugins docs | 7 |
| `codex` | falta | `[mcp_servers]` TOML, skills `.agents/skills` + `~/.agents/skills`, `AGENTS.md`/`AGENTS.override.md`, `.codex-plugin` (si existe — **sin verificar layout oficial**) | Codex docs/blog | 7 |
| `gemini` | falta | `mcpServers` de `settings.json` (user `~/.gemini/settings.json` + proyecto `.gemini/settings.json`), `gemini-extension.json` (name/version/mcpServers/contextFileName/excludeTools; `${extensionPath}`), GEMINI.md, comandos TOML/MD? — **sin verificar formato de commands de extensión** | geminicli.com docs | 7 |
| `opencode` | falta | `.opencode/` del proyecto: `agents|commands|skills|plugins|themes`, `opencode.json(c)`, plugins `.opencode/plugins/*.ts` — **solo datos; código TS ejecutable NO se soporta** → reporte en `doctor` | `/docs/plugins` | 7 |
| `pi` | falta | `packages` con clave `pi` en `package.json` (`extensions/skills/prompts/themes`), keywords `pi-package`; `~/.pi/agent/`, `.pi/` proyecto; **código de extensión NO se ejecuta** → reporte | github.com/earendil-works/pi | 7 |
| `agents-dir` | falta | `.agents/skills/**/SKILL.md` genérico (cross-client) | agentskills.io | 4/7 |
| Hooks (todos los orígenes) | falta | Traducir hooks de comando shell a `before_tool`/`after_tool`; eventos sin equivalente (Notification, Stop, SessionStart…) → omitir con advertencia; `matcher` (regex sobre tool name) → filtro; exit code 2 = bloquear (PreToolUse) | Claude hooks docs | 7 |
| Variables de ruta normalizadas: `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PROJECT_DIR}`, `${extensionPath}${/}`, `${CLAUDE_SKILL_DIR}` → rutas absolutas del origen | falta | spec + docs | 7 |
| Namespaces: comandos de plugin `plugin:comando`; colisiones resueltas por precedencia y aviso | falta | Claude plugin docs (namespacing) | 7 |
| Confianza explícita antes de cargar hooks/MCP/extensiones de proyecto o paquete de terceros | falta | spec; diálogo único por origen | 7 |

### L. Archivos de contexto (`src/compat/context-files.ts`)

| Función | Estado | Ref | Fase |
|---|---|---|---|
| `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` — recorrido de raíz → cwd, concatenados con encabezado de origen | hecho — encabezado `## ruta (kind)`; 32 KiB por archivo (nota de truncado en el bloque); aparecen en `doctor` | Codex (root→cwd, override), Claude, Gemini docs; spec | 4 |
| `AGENTS.override.md` (Codex) con precedencia sobre `AGENTS.md` en el mismo dir | hecho (misma directorio; en hijos no afecta al padre) | Codex docs | 4 |
| `instructions: []` en config (paths/globs/URLs) sumadas al contexto | parcial — paths y globs hechos (relativos al cwd; `~`/`$HOME`/absolutos; máx 20); **URLs no soportadas** (sin fetch en arranque) — aviso claro; 32 KiB por archivo | `/docs/config#instructions` | 4 |
| `/init` genera `AGENTS.md` | falta | `/docs/tui#init` | 3 |

### M. Modos (`src/modes/`) y CLI

| Comando / modo | Estado | Ref | Fase |
|---|---|---|---|
| `vireo` (TUI por defecto) | hecho — bare TUI en TTY (ANSI/OpenTUI); sin TTY cae al REPL plano | `/docs/cli` | 2 |
| `--print` / `-p` (un turno; stdout limpio, chatter en stderr) | hecho | `/docs/cli` run; Pi `-p` | 1 |
| `--json` (eventos JSONL a stdout) | hecho | spec | 1 |
| `serve` (HTTP opcional, **apagado por defecto**, expone el mismo flujo de eventos; basic auth por env `VIREO_SERVER_PASSWORD` análogo a `OPENCODE_SERVER_PASSWORD`) | falta | `/docs/server`; Pi `--mode json/rpc` | 3+ |
| `doctor` (fase 1: capas, reglas allow/ask/deny, modelo, tools, rg, websearch) — fase 4: orígenes de skills y archivos de contexto + avisos de config/compat; reporte completo fase 7 | parcial | spec | 1 (esqueleto) / 4 (skills+contexto) / 7 (completo) |
| `--model provider/model`, `--agent`, `--continue/-c`, `--session/-s`, `--fork`, `--port/--hostname/--mdns` | parcial — model/agent/continue/session/fork hechos; `--port/--hostname/--mdns` llegan con `serve` | `/docs/cli` | 2/3 |
| `--auto` (auto-aprueba lo no denegado) | hecho (también salta el diálogo TUI; deny sigue denegado) | `/docs/cli` | 2 |
| `--version`, `--help` | hecho | convención | 1 |

### N. No-objetivos de v1 (lite)

- Code Mode / `execute`, browser tool, worktrees, image_generate, warming, policies org, managed preferences, OAuth MCP completo, plugins ejecutables (OpenCode TS, Pi TS), telemetría, auto-update.
- `lsp` real: solo diagnóstico básico si hay servidor; no edición asistida.

## Verificación de entorno (2026-11-08)

- Bun **1.4.4** instalado en `~/.bun/bin` (npm global sin permisos → install script oficial). Node v20.20.2, git 2.47.3.
- Registry npm accesible: `@modelcontextprotocol/client@2.4.0`, `@modelcontextprotocol/core@2.4.0`, `@modelcontextprotocol/sdk@1.32.2` (legacy).
- OpenCode docs v1 (docs.opencode.ai) y v2 (opencode.ai/docs) accesibles; difieren en nombres (ver tabla v1/v2).
- Líneas: `src/core` 1397, `src/compat` 1109 (fase 6) → core+compat = 2506; `src/ext` 267 (API+loader, categoría nueva fuera del binomio core+compat). El objetivo "tiny core" (<1500) quedó muy atrás: decisión pendiente en fase 8 (estrechar presupuesto o factorizar undo/compact a util).

- Fase 6 (2026-11-08): 148/148 tests (`bun test`), `tsc --noEmit` limpio; e2e con mock provider (`VIREO_MOCK_SCENARIO=extshout`): extensión de proyecto auto-aprobada con aviso, tool `ext_shout` ejecutada, `turn_end` log; `doctor` lista extensión sin importarla; MCP `prompts/list|get` verificados contra fake server.

## Sin verificar / TODOs explícitos

1. ~~API de `@modelcontextprotocol/client@2.4.0`~~ **resuelto por desviación (Fase 5)**: cliente MCP propio sin deps; probe `server/discover` manual + fallback initialize; verificado con fakes stdio/HTTP/SSE.
2. **Sintaxis de argumentos de file-commands en v2** (`$ARGUMENTS` vs posicionales) — verificar `/docs/commands`. (Comandos personalizados: fase 6+; hoy no hay file-commands en Vireo)
3. **Ruta de skills de Codex**: `.agents/skills` verificado; ¿`~/.codex/skills` existe? no confirmado → no se esc anea salvo flag. (Fase 4)
4. ~~Ruta de skills de Gemini CLI~~ **resuelto (Fase 4)**: flag `compat.geminiSkills: true` activa `.gemini/skills` + `~/.gemini/skills`; default false (ruta sin verificar). El repo de Gemini no publica la ruta en lo leído.
5. **Layout de `.codex-plugin/`**: no se encontró manifest oficial → loader `codex` reporta `sin verificar` y carga solo convenciones (skills/mcp/commands) si existen. (Fase 7)
6. **Formato de commands de extensiones Gemini** (TOML vs MD) — verificar `docs/extensions`. (Fase 7)
7. **Cobertura del scanner de shell**: Vireo lite usa splitter conservador; no sustituye al scanner de OpenCode (bach/zsh/sh/powershell completos). (Fase 1)
8. **`python -m pytest` vs harness de tests**: se usará `bun test`.
9. ~~Diff rendering OpenTUI~~ **resuelto (Fase 2)**: `StyledText` + `TextRenderable.content`; verificado con `createTestRenderer` y bajo pty. Ancho de celdas ignora dobles-anchos unicode (CJK/emoji) — mejora menor pendiente.
10. ~~`plan_enter`/`plan_exit`~~ **resuelto (Fase 3)**: tools `plan-enter` (cambio directo) y `plan-exit` (con confirmación del usuario; rechazo = sigue en plan). Nombres con guión tal como dice el spec parity.

## Mapa fase → secciones

| Fase | Entrega (criterio de aceptación resumido) |
|---|---|
| 0 | Este documento ✔ |
| 1 | Núcleo + tools + permisos + config con renderer plano: `vireo --print "hola"` responde; `bun test` verde |
| 2 | ✔ TUI: stream, editor multilínea, `@file` fuzzy, `/`+paleta, selector modelos/sesiones (en sesión), permisos con diff, temas, leader ctrl+x, motores opentui+ansi con fallback |
| 3 | ✔ Sesiones (fork/rename/delete), undo/redo por turno (sin git, pre/post imagen + backup), compactación un paso, subagentes (`task` general/explore, depth 1, sesión hija), `/init` (prompt canned), tools `plan-enter`/`plan-exit` |
| 4 | ✔ Skills + context files de todas las CLIs; `doctor` los lista (HTTP catalogs pendientes a hook de init async) |
| 5 | ✔ MCP stdio/HTTP con probe `server/discover` + fallback legacy (prompts→comandos dinámicos pasan a fase 6) |
| 6 | ✔ Ext API + slots TUI (`src/ext/`, extensión de referencia `examples/extensions/shout.ts`). **`/fusion` diferido explícitamente** (sin spec; no se inventa comportamiento — decisión del usuario 2026-11-08) |
| 7 | Loaders plugins claude/codex/gemini/opencode/pi (+ `agents-dir`) |
| 8 | Mejoras: edit fail con "fragmento más parecido", compactación 2 pasos, failover/rotación claves, tool-calls-en-texto, memoria por proyecto, architect/editor |
