# Nicotine — Paridad con OpenCode y CLIs compatibles

> **Nombre del proyecto:** `nicotine` (binario `nic`; antes `vireo`, shim deprecado `vireo`). Nombre neutro, sin marca ni
> logo de ninguna herramienta existente. Renombrado 2026-11 (fase 10f); `VIREO_*` → `NICOTINE_*` con alias deprecado.
>
> **Objetivo:** réplica funcional y visual de OpenCode *lite*: mismo conjunto de
> herramientas, mismos flujos de TUI, misma configuración — recontra liviana,
> fácil de aprender y de modificar, compatible con skills/plugins/MCP de otras
> CLIs (Claude Code, Codex, Gemini CLI, OpenCode, Pi y similares).
>
> **Fecha de investigación:** 2026-11-08. **Estado del código:** **Fase 8 implementada** —
> edit con «fragmento más parecido», compactación de dos pasos (poda sin LLM → resumen),
> rotación de API keys (401/403/429/5xx), tool-calls en texto (Hermes/Qwen), memoria por
> proyecto (`.nicotine/memory.md`), agentes `architect`/`editor`, `policies` v2 (hard-deny),
> catálogos HTTP de skills (`nicotine skills update`, digest sha256 verificado), shell-scan
> conservador, ancho CJK/emoji en el motor ANSI, `snapshots: false`, formats VERIFICADOS
> de Codex (skills, `.codex-plugin`) y Gemini (comandos TOML de extensión).
> `bun test` → 220/220 verde. `/fusion` diferido (sin spec). **Fases 0–8 completas.**
> Esta tabla es la guía de las fases 1–8.

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

OpenCode está en transición v1 → v2. Esto afecta nombres; Nicotine decide así:

| Concepto | v1 (docs.opencode.ai) | v2 (opencode.ai/docs) | **Decisión Nicotine** |
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
| Adaptador Vercel AI SDK opcional (desactivado por defecto) | hecho (fase 10; **opt-in**) — `provider.engine: "vercel-ai"` en config o `NICOTINE_PROVIDER_ENGINE=vercel-ai`; import dinámico de `ai` + `@ai-sdk/openai-compatible` (cero deps en el núcleo); sin paquetes → error claro con `bun add ai @ai-sdk/openai-compatible`; replicar failover (claves×modelos, 12 intentos, 401/403/429/5xx, `maxRetries: 0` para no duplicar el retry del SDK); mensajes OpenAI→ModelMessage (incl. tool-calls/results y `role:system` intermedios vía `allowSystemInMessages`); tools del SDK sin `execute` (nicotine las ejecuta); integración real verificada con ai@7.0.166 + @ai-sdk/openai-compatible@3.0.87. Tests en `tests/vercel.test.ts` (live: `NICOTINE_LIVE_VERCEL_AI=1`) | `ai` + `@ai-sdk/openai-compatible`; detrás de flag | 1 |
| Sesión en JSONL (append-only, sin ORM) | hecho — create/load/list/título/fork/remove; fork herida del historial (`--fork`); padres→hijos en `task` | spec; una línea por mensaje/evento | 1 / 3 |
| Contexto: instrucciones + skills + tools en el prompt | hecho — system prompt + archivos de contexto (AGENTS/CLAUDE/GEMINI, raíz→cwd) + listado de skills (nombre+desc; body bajo demanda) | spec + `/docs/agents` | 1/4 |
| Compactación (auto al llenar buffer; keep.tokens) | hecho (**dos pasos**, fase 8): (1) poda SIN LLM — salidas de tool >1.2 KB y `tool_calls.arguments` gigantes (→ JSON mínimo válido); si basta, sin llamar al modelo; (2) resumen LLM de lo antiguo (conserva cola `keep_tokens`; corte seguro sin partir tool_calls). Si el paso 2 falla, el historial del usuario NO se toca (se trabaja sobre copia). Estimación chars/4, sin tokenizer | `/docs/config#compaction`; claves `compaction.auto`, `threshold_tokens`, `keep_tokens` | 3 / 8 |
| Undo/redo de cambios de archivos por turno | hecho — snapshots pre/post de archivos tocados por write/edit/apply_patch (2 MB/archivo); `bash` registrado pero NO deshacible; **desviación del spec:** sin git (funciona fuera de repos); respaldo automático del estado actual en `pre-undo/` antes de sobrescribir/borrar (la edición post-turno del usuario nunca se pierde); la conversación no se toca | spec lite; `/docs/snapshots` | 3 |
| Subagentes (sesiones hijas, depth 1) | hecho — tool `task` (general/explore); explore deniega edición; sesión JSONL hija con título `task: …`; eventos de tools del hijo etiquetados `[agent]` para la UI; el hijo no ve el historial del padre salvo en el prompt; profundidad 1 (sin `task` dentro); misma señal de abort; heredan provider (sin config multi-modelo en lite) | `task` tool; `/docs/agents` | 3 |
| Failover de modelos / rotación de claves ante 429/401 | hecho (8+9) — parcial — **rotación de CLAVES hecha** (fase 8): pool `provider.apiKey`/`provider.apiKeys` (config) + `OPENAI_API_KEYS` (coma-separadas), deduplicado; ante 401/403/429/5xx se prueba la siguiente (aviso `provider_retry` sin exponer claves; `--auto` no salta este camino); 400/errores de cliente NO rotan. **Failover de MODELOS** (fase 9): `provider.fallbackModels: []` (config) o `NICOTINE_MODEL_FALLBACKS` (env, coma-separados; cortes `vendor/` y `#variant`); si TODAS las claves fallan con 401/403/429/5xx se salta al siguiente modelo (máx. 12 intentos; `provider_retry` lleva `model`/`nextModel`; el failover pega en la sesión — visible en /models). También aplica al motor «vercel-ai» (fase 10; `maxRetries: 0` en el SDK para no duplicar) | spec fase 8 | 8/9 |
| Fallback tool-calls en texto (modelos sin FC nativo) | hecho (fase 8) — Hermes/Qwen `<tool_call>{…}</tool_call>` y bloques ```` ```json ````/ ```` ```tool_call ```` con `name`+`arguments`; SOLO cuando el mensaje no trae `tool_calls` nativos; nombres de tool alucinados se descartan (validación contra el listado); `arguments` string JSON pasa tal cual (roto → no rescata); opt-out `compat.text_tool_calls: false` (también en subagentes) | spec fase 8 | 8 |
| Memoria por proyecto (`.nicotine/memory.md`) | hecho (fase 8) — `<cwd>/.nicotine/memory.md` se carga al arrancar como archivo de contexto kind `memory` (cap 32 KiB; solo desde el cwd — un proyecto = su raíz); la escribe el PROPIO agente con write/edit (permisos normales, con `pre-undo` si edita); la sección lleva la nota "mantenla al día…"; `/init` la menciona; doctor la lista | spec fase 8 | 8 |
| Tool `lsp` (experimental, diagnósticos) | hecho (2026-11, fase 9) — **OFF por defecto**; solo con `lsp:` en config (`command`+`extensions` por servidor); SOLO acción `diagnostics` para UN archivo; JSON-RPC Content-Length propio; cero servidores empaquetados; doctor lista los configurados | `/docs/tools`; cliente LSP mínimo | 1 (stub) / 9 |

### B. Herramientas (`src/tools/`) — paridad OpenCode lite

| Herramienta | Estado | Ref / nota | Fase |
|---|---|---|---|
| `read` (líneas numeradas, 2000 líneas/50 KiB, offset/limit) — imágenes/PDF devuelven nota textual | hecho | `/docs/tools#read` | 1 |
| `write` (crea dirs padres) | hecho | `/docs/tools#write` | 1 |
| `edit` (lectura previa obligatoria; estrategias exacta → trimEnd por línea → trim+re-indent; **diff antes de pedir permiso**; **si nada casa, sugiere el "fragmento más parecido"** (líneas N–M con similitud ≥45 %, fase 8); LSP diagnostics pendientes) | hecho | `/docs/tools#edit` + spec (estrategias propias) | 1 / 8 |
| `apply_patch` (patch multi-archivo `*** Add/Update/Delete File` + `*** Move To`) | hecho | `/docs/tools#patch`; expuesto a modelos GPT; `patch` vs `apply_patch` nombre clásico | 1 |
| `bash` (shell $SHELL o /bin/sh — config `shell` aún sin efecto; timeout 2 min; abort SIGTERM→SIGKILL; background básico: log en tmp, sin notificación) | hecho | `/docs/tools#shell` + spec (abort) | 1 |
| `glob` (`**/*.ts`, `path`, `hidden`, `limit` 100, timeout 30 s, `.gitignore` subconjunto) | hecho | `/docs/tools#glob` | 1 |
| `grep` (regex o `literal`, `path`/`include`/`caseSensitive`/`limit` 100, timeout 30 s, ripgrep si existe; fallback JS — `.gitignore` parcial) | hecho | `/docs/tools#grep` | 1 |
| `list` (listado no recursivo de directorio) | hecho | `read` cubre dir en OpenCode; spec pide `list` aparte | 1 |
| `webfetch` (URL → markdown/text/html; timeout ≤ 120 s; conversor HTML→md naive) | hecho | `/docs/tools#webfetch` | 1 |
| `websearch` (backends: `NICOTINE_SEARXNG_URL` o `EXA_API_KEY`; sin backend devuelve instrucciones, no rompe el loop) | hecho | `/docs/websearch`; sin credencial → tool ausente + aviso | 1 |
| `task` (subagentes general/explore) | hecho | `/docs/agents`; ver A | 3 |
| `plan-enter`, `plan-exit` (cambio de agente con consentimiento; plan-exit pide confirmación) | hecho (spec lite; v2 no los tiene como tools) | `/docs/cli`; `plan_exit` draft de permisos | 3 |
| `todowrite` (lista de tareas de la sesión) | hecho | `/docs/config#todos`; en Nicotine activado por defecto (era tool clásica) | 1 |
| `question` (flat: readline numerado; TUI fase 2; sin TTY → null) | hecho | `/docs/tools#question`; requiere cliente interactivo; sin él → auto-respuesta vacía + aviso | 1 |
| `skill` (carga body de SKILL.md por ID; solo nombre+descripción en prompt) | hecho — tool `skill`, cuerpo ≤16 KiB, archivos de soporte ≤10 listados; ids ocultados siguen cargándose; error listando disponibles | `/docs/skills` | 4 |
| `task` (subagente; depth 1; se ejecuta en bloque) | hecho (fase 3) — alias v2 `subagent` sin tool aparte | `/docs/tools#subagent` (v2); clásico `task` | 3 |
| `lsp` (experimental: diagnostics del servidor LSP si hay uno configurado) | hecho (2026-11, fase 9) — severidad/línea/columna/fuente/código; tope 50 líneas; `timeoutMs` (máx 60s) | v2 no la lista como acción core | 8/9 |
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
| `external_directory` — en Nicotine es **ask** por defecto (spec), configurable; expansión `~` `$HOME` | hecho (desviación deliberada del default v2) | `/docs/permissions#directories`; **pregunta extra en TUI si la regla es ask** | 1 |
| Regla compuesta (patch multi-archivo vía `permissionResources`; `deny` > `ask` > `allow`) | hecho | `/docs/permissions#matching` | 1 |
| Saved approvals ("always" guarda `carpeta/*` en memoria de sesión; **persistencia por proyecto** en `$XDG_DATA_HOME/nicotine/approvals/<sha1(cwd)>.json`; deny siempre gana) | hecho (6.5 — mostrando también patrón en diálogo) | `/docs/permissions#approvals` | 3 |
| Diálogo de aprobación en TUI con diff (once/always/reject + feedback) | hecho (flechas+enter, y/a/n, diff coloreado truncado al alto) | `/docs/permissions#approvals`; `permission.prompt.fullscreen` no soportado (lite) | 2 |
| Scanner de shell (heurística conservadora; análisis por subcomandos) | hecho (conservador) — `shell-scan.ts` divide `&&`, `||`, `;`, `|`, saltos de línea respetando comillas simples/dobles/backtick y `$(…)`/backticks recursivamente; heredoc (`<<`) o balanceo imposible → comando completo (como antes). Cada segmento se evalúa por separado y se combina deny > ask > allow; **nunca amplía permisos** | `/docs/permissions#scanner`; Nicotine lite: sin parser completo (bash/zsh/sh/powershell) — limitación inherente, documentada | 1 |
| `policies` v2 (hard-deny post-reglas) | hecho (fase 8) — `policies: [{action, resource}]` en config (array, acumulan entre capas; `bash` sin expandir `~`, rutas con expansión); se aplican DESPUÉS del motor y de los allows guardados — ningún allow las pisa; `doctor` las cuenta; `PermissionDenied` acota la causa a UNA regla/policy/«rechazado por el usuario» (nunca el ruleset completo — legado #53446 de opencode) | `/docs/permissions#policies` | 8 |
| Política aplicada en `before_tool` (dentro de `executeTool`: deny→error, ask→diff+confirmación) | hecho | spec + `/docs/plugins` | 1 |

### D. Configuración (`src/core/config.ts`)

| Función | Estado | Ref / nota | Fase |
|---|---|---|---|
| `opencode.json` y `opencode.jsonc` (JSONC propio: comentarios y trailing commas, respeta strings) | hecho | `/docs/config#format` | 1 |
| Capas: system < global < proyecto (raíz→cwd) < `.opencode/` < `--config-dir` (custom) | hecho | `/docs/config#locations` | 1 |
| Carpetas plurales: `agents/`, `commands/`, `skills/`, `plugins/`, `themes/` — todas leídas (skills f4; commands/agents/themes/plugins f7); `plugins/*.ts` nunca ejecutan | hecho (fase 7) | `/docs/config#locations` | 1+ |
| Sustitución `{env:VAR}` y `{file:path}` en strings | hecho (`{file:}` relativo al dir del config) | `/docs/config#variables` | 1 |
| `$schema` ignorado con aviso si desconocido; claves desconocidas → aviso, no error | hecho (top-level; se lista en `doctor`) | spec (skills) + `/docs/config` | 1 |
| `model` (flag > config > `NICOTINE_MODEL`/`OPENAI_MODEL`), `default_agent` → hecho (**con fallback «build» + aviso** si la config nombra un agente desconocido; `--agent` desconocido → exit 1); `snapshots: false` y `policies` → hechos (fase 8); resto (`compaction`, `instructions`, `skills`, `commands`, `mcp`, …) vivo | hecho | `/docs/config` | 1 (subconjunto) / 3+ |
| `tui.json` separado — archivo+precedencia (`$NICOTINE_TUI_CONFIG` > global > proyecto raíz→cwd + `.opencode/`), merge keybinds-over-defaults, `"none"` desactiva, theme/leader_timeout/mouse/cursor/diff_style parseados | parcial — honrados: theme·leader_timeout·keybinds·mouse·cursor(·diff_style en diffs de permisos); **scroll_speed honrado como paso de PgUp/PgDn** (`round(speed×4)` líneas, mínimo 0.001, default 3→12) **y como paso de rueda** (`scroll_speed` líneas por notch); rueda cableada en ambos motores (ANSI: SGR-mouse 1006 decodificado → teclas sintéticas `wheelup`/`wheeldown`, reporting solo si `tui.mouse`; OpenTUI: `onMouseScroll` por fila vía `useMouse`) | `/docs/tui#configure` | 2 |
| Precedencia admin: managed prefs macOS / system dir | **fuera de alcance lite** | `/docs/config#locations` | — |

### E. Agentes (`src/core/agents` + `agents/`)

| Función | Estado | Ref | Fase |
|---|---|---|---|
| Built-ins `build`, `plan` (deniega edit), **`architect`** (deniega edit; diseño/tradeoffs) y **`editor`** (aplica cambios mínimos verificados) — primary, vía `--agent` y ciclo de tab; `general`/`explore` para `task` | hecho (fase 8: +architect/editor) | `/docs/agents#built-ins` | 1 (defs) / 3 / 8 |
| Agentes en Markdown con frontmatter — `description` requerida, `mode`, `tools:` mapeadas, body=system prompt, plugins con prefijo «plugin:id»; **IDs anidados por subdirectorio** (`team/reviewer`); `model` honrado (subagente; `#variant` y `vendor/` cortados al pedir); `permissions:` de archivo **sí honradas** (por-entrada, `normalizeAction`; efecto inválido → aviso + se omite); `hidden`/`disabled` honrados; `name:` pisa el ID de ruta | hecho (2026-11) | `/docs/agents#formats` | 1/3 |
| Merge: escalares reemplazan, permissions se **añaden** | hecho (2026-11) — por capas (deepMerge concatena `permissions` en cualquier nivel) y al overridear built-ins (config pisa > archivo > built-in; escalares sustituyen, reglas se ANEXAN; `disabled` elimina, `hidden` oculta sin impedir `--agent`) | `/docs/agents#merging` | 1 |
| `default_agent`, selección con fallback — config desconocido → aviso + `build`; `--agent` desconocido → error limpio con exit 1 | hecho (2026-11) | `/docs/agents#selection` | 3 |
| Modos `primary`/`subagent`/`all` (tab cicla solo primaries); subagentes depth 1, no visibles en tab, sin `task`/`plan-*` | hecho (3/7) | `/docs/agents#modes` | 3 |
| Agentes en JSON config `agents: {id: {…}}` — `description`, `mode` (default primary para nuevos; override conserva el mode del built-in), `system` (sustituye identidad/estilo; entorno+contexto+skills conservados), `model` (subagentes lo honran con vendor/ y #variant descartados; sesión de primario NO cambia), `permissions` (reglas anexadas), `hidden`, `disabled`; `steps`/`color`/`request`/V1 ignorados con aviso; `task` expone el catálogo "subagent|all" sin hidden; `doctor` los lista | hecho (2026-11) | `/docs/agents#jsonc` | 4 |
| Ocultar `compaction`/`title`/`summary` (internos, no seleccionables) | hecho — **no aplica**: nicotine no tiene agentes internos (compaction/title se hacen en código, no como agentes); nada que ocultar | `/docs/agents#built-ins` | 3 |

### F. Comandos slash built-in (TUI y print)

| Comando | Estado | Ref | Fase |
|---|---|---|---|
| `/help`, `/models`, `/new` (`/clear`), `/sessions` (`/resume`,`/continue`), `/compact` (`/summarize`) | hecho — además `/fork` (bifurca y cambia a la nueva); `/sessions` con renombrar (`r`) y borrar (`d`, con confirmación) en la TUI | `/docs/tui#commands` | 2/3 |
| `/undo`, `/redo` | hecho — ver A (sin git) | `/docs/tui#undo` | 3 |
| `/init` (crea/actualiza `AGENTS.md` guiado) | hecho — `/init` envía un prompt canned al agente (explora, escribe/fusiona AGENTS.md con la tool write/edit; requiere un proveedor real para el análisis) | `/docs/tui#init`, `/docs/rules` | 3 |
| `/themes`, `/thinking`, `/export`, `/editor`, `/connect` (API keys), `/exit` (`/quit`,`/q`) | parcial — `/themes`,`/thinking`(informativo),`/exit` en TUI; **`/connect`** hecho (2026-11): catálogo OpenAI-compatible (openai/openrouter/groq/deepseek/together) + personalizado; clave oculta, guardada en `$XDG_DATA_HOME/nicotine/auth.json` con **0600** (nunca logueada; encaje exacto por baseURL o default openai; config/env ganan); **`/export`** hecho (2026-11): sesión → Markdown en `$XDG_DATA_HOME/nicotine/exports/` (0600, sin system prompt ni `Eres Nicotine`); **no** abre `$EDITOR` (v1 no suspende la TUI); `/editor` **hecho (2026-11)**: buffer del prompt ↔ `$VISUAL`/`$EDITOR` (`vi` por defecto; GUI necesitan `--wait`); `/export` también abre `$VISUAL`/`$EDITOR` si está definido (suspend/resume de la TUI: ANSI alt-screen±raw · OpenTUI `renderer.suspend/resume`) | `/docs/tui#commands` | 2/3/9 |
| `/plan` (entrar/salir de agente plan) | hecho vía tools `plan-enter`/`plan-exit` (el modelo puede pedir el cambio); tab cicla build/plan manualmente | spec `plan-enter/plan-exit` | 3 |
| Comandos de archivo `commands/*.md` (frontmatter: description, model, agent; `$ARGUMENTS`; argumentos `$1..`/`$NAME`) | hecho (fase 7) — `.claude|.opencode/commands/**.md`, `.pi/prompts/*.md`, plugins namespaced `plugin:comando`; `$ARGUMENTS` y `$1..$9`; frontmatter `description`/`argument-hint` (`model`/`agent` ignorados con aviso); en v1 no hay dispatch de slash fuera de la TUI | `/docs/commands` | 4→7 |
| Comandos de MCP prompts `<server>:<prompt>` | hecho — comandos dinámicos en TUI; args posicionales→orden declarado (required ausente → error de uso); el prompt renderizado se envía como turno del usuario | `/docs/commands` | 5/6 |
| Comandos custom desde config `commands: {}` — `template` requerido; `$ARGUMENTS`/`$N` (mayor N consume el resto); sin placeholder → args anexados; `agent`/`model` honrados en TUI; `subagent`/`subtask` y bloques `` !`…` `` aceptados pero no honrados (aviso); builtins ganan; `doctor` los lista | hecho (2026-11) | `/docs/config#commands` | 4 |

### G. TUI (`src/ui/`)

| Función | Estado | Ref / nota | Fase |
|---|---|---|---|
| Motor `ansi` propio y mínimo (respaldo + `--print`-ish flat) | hecho (alt screen, SGR pass-through, diff-paint por línea, decodificador propio) | spec; primer entregable de UI | 2 |
| Motor `opentui` (`@opentui/core`, MIT) detrás de la interfaz de componentes | hecho (0.8.3; un `TextRenderable` por fila + `setCursorPosition`; `keyInput.on("keypress")`; verificado con `createTestRenderer` headless y bajo pty) | `/docs/tui`; fallback automático a ANSI si falla el arranque (`NICOTINE_UI_ENGINE=ansi` lo fuerza) | 2 |
| Flujos: stream de mensajes, editor de prompt, autocompletado `@file` (fuzzy), `!comando` shell | parcial — stream, editor multilínea (ctrl+j), `@file` fuzzy con walk propio (skip dirs, tope 6k); `/` comandos; `!comando` shell NO (evita saltarse permisos; el agente ya ejecuta bash con permisos) | `/docs/tui` | 2 |
| Selector de modelos (`/models`, `ctrl+x m`), lista de sesiones (`ctrl+x l`), ciclo de agentes (`tab`) | hecho para la sesión en curso (fetch `GET {baseURL}/models`; sesión nueva en memoria); persistencia permanente = editar `opencode.json`; ciclo tab entre build/plan reconstruye permisos+system prompt | `/docs/tui`, `/docs/keybinds` | 2 |
| Diálogo de permisos con diff, selector de agente, selector de tema, help | hecho (selector de agente = tab cicla; `/help` lista atajos) | `/docs/keybinds`, `/docs/tui` | 2 |
| Vista de diffs (inline, `diff_style: auto\|stacked`) | hecho (2026-11, fase 9) — parcial — color ✓/✗/+/−/@@ en tarjetas de tool y diálogo de permiso; `diff_style` **ya cambia el layout** (fase 9): `stacked` apila contexto+eliminadas y contexto+añadidas por hunk (separador «+ ···», `src/ui/diff-style.ts`); aplicado a tarjetas de tool y diálogo de permiso | `/docs/tui#configure` | 2/9 |
| Keybinds: leader `ctrl+x`, `tui.json` merge-over-defaults, `"none"` para desactivar | hecho (subset v1: leader, session/model/theme/agent lists, exit, submit, newline, paginado, ciclo agente; `<leader>x` notación; unión por comas) | `/docs/keybinds` (tabla completa) | 2 |
| Temas como JSON de tokens; `themes/` carpeta | hecho (nicotine-dark/nicotine-light built-in; merge por tokens parciales; `themes/`, `.opencode/themes/`, `.nicotine/themes/` de raíz→cwd + `~/.config/opencode|nicotine/themes`) | `/docs/themes` | 2 |
| Extensibilidad: `on(evento)`, `registerTool`, `registerCommand`, `registerShortcut`, `ui.setSlot` (header/messages/widgets/editor/footer), `ui.addWidget`, `ui.setRenderer`, `ui.setTheme` | hecho (`src/ext/`) — API propia lite; `on`/`registerTool` funcionan en todos los modos; comandos/atajos/slots/temas solo TUI (no-op con aviso fuera); descubrimiento global (`~/.config/nicotine/extensions`), proyecto (`.nicotine/extensions/`, raíz→cwd) y `extensions: []` en config; proyecto = compuerta de confianza ANTES de importar (doctor no importa); `ui.setRenderer` descartado (contradiría al motor); componente = `render(width): string[]` (render-only, sin `onKey` v1); atajos exigen ctrl/alt (`ctrl+g`…`alt+f2`); los builtins ganan en colisiones; guía: `docs/extensions.md`; referencia `examples/extensions/shout.ts` | spec (API propia, no hay fuente OpenCode pública 1:1 → **diseño propio**) | 6 |
| Componente `{ render(width): string[]; onKey?(key): boolean }` envuelto en try/catch | hecho (`src/ui/component.ts`, `safeRender`/`safeOnKey`); la TUI pinta slots/widgets de extensiones vía `safeRender` (errores de componente no tumban el frame) | spec | 2/6 |

### H. Sesiones / historial (`src/core/session.ts`)

| Función | Estado | Ref | Fase |
|---|---|---|---|
| Sesiones JSONL en `~/.local/share/nicotine/sessions/<id>.jsonl` (o `XDG_DATA_HOME`) | hecho | spec; ruta exacta ≠ OpenCode (sería `storage/session`) — decisión propia documentada | 1/3 |
| `--continue`, `--session <id>`, `--fork` | hecho (`--fork` bifurca la sesión sin tocar la original; `--fork` sin `-c`/`-s` bifurca la última) | `/docs/cli` (tui flags) | 3 |
| Título auto, listar/renombrar/borrar/cambiar | hecho — `/sessions`: cargar (enter), renombrar (`r`), borrar (`d` con confirmación; la sesión activa no se puede borrar); título auto desde el primer prompt | `/docs/cli` (agent create), `session_*` | 3 |
| Undo/redo por turno (sin git; pre/post imagen + respaldo `pre-undo/`) | hecho — ver sección A | `/docs/snapshots` | 3 |

### I. Skills (`src/compat/skills.ts`)

| Función | Estado | Ref / nota | Fase |
|---|---|---|---|
| Formato `SKILL.md`: frontmatter YAML (`name` ≤64, `description` ≤1024, opcionales `license`/`compatibility`/`metadata`/`allowed-tools`) + body Markdown | hecho — parser YAML propio mínimo (`yaml-lite.ts`, anidamiento ≤3 niveles, sin deps); `name`/`description` requeridos; desconocidas → aviso; body ≤16 KiB al cargar | agentskills.io spec; Claude Code skills docs | 4 |
| Carpetas escaneadas (global + proyecto) | hecho — global: opencode/claude/agents/pi/codex (`$CODEX_HOME/skills`, defecto `~/.codex/skills`, **verificado 2026-11**) (+gemini tras flag `compat.geminiSkills`, default false); proyecto raíz→cwd: `.opencode/skills`, `.claude/skills`, `.agents/skills`, `.pi/skills`, `.codex/skills` (+gemini tras flag) — Codex **verificado 2026-11** (agentskills + guías codex) | OpenCode `/docs/skills` (Discovery); Pi docs; Codex docs; Gemini CLI ext docs | 4 |
| Carga: solo nombre+descripción al inicio; body bajo demanda (tool `skill`); base dir + sample de hasta 10 archivos de soporte | hecho — `# Skills disponibles` en el system prompt; tool `skill` devuelve cuerpo + directorio + ≤10 archivos de soporte | `/docs/skills#loading` | 4 |
| Claves desconocidas → ignorar con advertencia (no error) | hecho (también claves desconocidas TOP-LEVEL de la config) | `/docs/skills#frontmatter` + spec | 4 |
| `skills: ["./dir", ...]` en config | hecho (fase 8: + HTTP catalogs) — paths locales (dir un nivel `*/SKILL.md` + suelto, o archivo directo); **catálogos HTTP de skills** (discovery `/.well-known/agent-skills/index.json`): NUNCA se descargan al arrancar (init sync) — `nicotine skills update [url…]` baja el índice, **verifica sha256 de cada SKILL.md contra el índice** (digest obligatorio) y cachea en `$XDG_CACHE_HOME/nicotine/skills-http/<hash-url>/`; el arranque lee la caché (sin red); `doctor` reporta estado y fecha; sin caché → aviso con instrucción | `/docs/skills#sources`,`#catalogs` | 4 / 8 |
| Precedencia por ID (última fuente gana; orden documentado) | hecho — global → proyecto (raíz→cwd) → `config.skills` (lo último referido gana; se avisa de pisado) | `/docs/skills#precedence` | 4 |
| `disable-model-invocation` / `metadata.opencode.autoinvoke: false` → oculta del listado, load explícito permitido | hecho (ambos; el tool `skill` sigue cargándolos por id) | `/docs/skills#frontmatter` | 4 |
| Validación name 1–64 `^[a-z0-9]+(-[a-z0-9]+)*$`, match con directorio — *OpenCode v2 no la enforcea; Nicotine avisa, no rechaza* | hecho (aviso; la skill se carga igualmente) | agentskills spec + `/docs/skills#ids` | 4 |

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
| Config multi-origen: OpenCode `mcp` (v2 `mcp.servers`; legacy top-level `mcp.<name>` — **aceptar ambas**, v2 pisa clásica), `.mcp.json` (Claude), Codex TOML, Gemini settings.json | hecho — OpenCode (ambos shapes) + `.mcp.json` + gemini settings.json + codex `[mcp_servers]` (toml-lite propio) + `gemini-extension.json` (mcpServers + excludeTools); colisiones: nativa > proyecto (dentro→fuera) > global, primera gana con aviso; proyecto pasa por la misma compuerta | docs de cada CLI (ver Fuentes) | 5/7 |
| Timeouts (startup/catalog/execution; per-server override) | hecho — defaults 5s/10s/60s; `timeouts: {startup, catalog, execution}` o `startup_timeout_ms`/`catalog_timeout_ms`/`tool_timeout_ms` (o `timeout`) | `/docs/mcp-servers#timeouts` | 5 |
| Confianza explícita antes de lanzar MCP de proyecto/paquete de terceros (diálogo; `trust` de Gemini **no** se honra en silencio) | hecho — project-origin → `ui.confirm` (una vez por servidor y sesión) con resumen de comando/URL + NOMBRES de env/headers (valores jamás); `--auto` aprueba con aviso; sin TTY rechaza; system/global/custom no preguntan; `doctor` nunca lanza servidores | spec + modelo Gemini `trust` | 5 |
| OAuth remoto (PKCE, CIMD/DCR) | **hecho (2026-11, fase 9)** — OAuth 2.1 + PKCE S256; RFC 9728 (PRM) + RFC 8414/OIDC (ASM); RFC 8707 `resource` en authorize/token/refresh; **DCR** (RFC 7591) cuando no hay `oauth.clientId` (CIMD requiere hosting público → fuera, documentado); refresh single-flight; caducidad −60s → refresh automático; **401 → refresh → 1 reintento**; `nicotine mcp auth\|logout\|list`; loopback redirect efímero (127.0.0.1); navegador vía xdg-open/open/start o URL impresa; tokens en `oauth.json` **0600**; headers `Authorization` explícitos ganan; doctor lista nombres autorizados | `/docs/mcp-servers#oauth` | 9 |
| MCP prompts → comandos `<server>:<prompt>` | hecho — `prompts/list` probe tras `tools/list` (capability-gated); `prompts/get` renderiza `role: text`; nombre saneado a `[a-zA-Z0-9_:-]`; columna de autocompletado y dispatch aceptan `:`; `splitArgs` con comillas | `/docs/mcp-servers#prompts` | 5/6 |
| MCP resources (`opencode_list_mcp_resources`…) | hecho — solo si el servidor anuncia capability: tools fijas `opencode_list_mcp_resources` y `opencode_read_mcp_resource` con `server` enum; texto y blob (blob: nota, sin binario) | `/docs/mcp-servers#resources`, `#names` | 5 |
| Confianza/verificación del SDK: **API exacta de client@2 (auto-fallback interno vs probe manual) — sin verificar** | resuelto por desviación: cliente propio hand-rolled (ver fila stateless); client@2.4.0 existe pero no se usa | npm registry (existe, MIT) | 5 |

### K. Plugins y hooks por origen (`src/compat/`)

| Loader | Estado | Qué carga | Ref | Fase |
|---|---|---|---|---|
| `claude` | hecho | skills/agents/commands/hooks `.claude/**` (raíz→cwd + `~/.claude`) + plugins `~/.claude/plugins/*` y `.claude/plugins/*` (manifest `plugin.json`; datos; código JAMÁS se ejecuta) + `.mcp.json` + hooks `settings.json|settings.local.json|plugin/hooks/hooks.json` | code.claude.com skills/plugins docs | 7 |
| `codex` | hecho | `[mcp_servers]` de `~/.codex/config.toml` y `.codex/config.toml` (mini-parser propio `toml-lite.ts`); skills global (`$CODEX_HOME/skills`, defecto `~/.codex/skills`) y proyecto (`.codex/skills/`) **verificado**; **plugins `.codex-plugin/plugin.json` VERIFICADO (2026-11)**: se escanean `~/.codex/plugins/*` (un nivel, manual), `~/.codex/plugins/cache/<marketplace>/<plugin>` (caché de `codex plugin marketplace add`) y proyecto `.codex/plugins/*`; se cargan `skills/` (raíz del plugin) y `.mcp.json` (`mcpServers`, raíz del plugin); `hooks/hooks.json` y `.app.json` → **reporte, NUNCA ejecución** (formato sin verificar / no soportado lite) | Codex docs/blogs 2026-11 | 7/8 |
| `gemini` | hecho | `mcpServers` (settings.json user+project) y `gemini-extension.json` (mcpServers + `excludeTools` + `contextFileName` → contexto extra); skills de extensión (`skills/`) como fuel para el scan de skills; GEMINI.md en fase 4; **comandos de extensión VERIFICADO (2026-11) y CARGADOS**: `commands/**/*.toml` (`prompt` requerido, `description` opcional; subdirectorios → namespace `:`; nicotine los registra siempre con prefijo `<ext>:a:b…` y normaliza `{{args}}`→`$ARGUMENTS`, `{{args[N]}}`→`$N+1`); skills `.gemini/skills` detrás del flag `compat.geminiSkills` (fase 4) | geminicli.com docs (extensions reference + custom-commands) | 7/8 |
| `opencode` | hecho | `.opencode/` del proyecto: `commands/*.md`, `agents/*.md`, `themes/*.json`, `skills/`; `opencode.json(c)` nativo; `plugins/*.ts` → reporte «no soportado» en `doctor`, JAMÁS se ejecuta | `/docs/plugins` | 7 |
| `pi` | parcial | `~/.pi/agent/` y `.pi/` (prompts/*.md → comandos, themes/*.json, agents/*.md, skills/); packages con clave `pi` en node_modules **no se escanean** (v1; aviso en doctor); **código de extensión NO se ejecuta** → reporte | github.com/earendil-works/pi | 7 |
| `agents-dir` | hecho (fase 4) | `.agents/skills/**/SKILL.md` genérico (cross-client), global y raíz→cwd | agentskills.io | 4 |
| Hooks (todos los orígenes) | hecho | `PreToolUse` (exit 2 bloquea ANTES del diálogo de permisos; stderr → modelo) y `PostToolUse` (informativo); `matcher` regex; stdin JSON `{tool_name, args}`; `bash -lc`; timeout 5s (frontmatter `timeout`, máx 30); env `CLAUDE_PROJECT_DIR`/`NICOTINE_PROJECT_DIR`/`CLAUDE_PLUGIN_ROOT`; `type:"command"` únicamente; async y otros tipos/eventos → aviso y omisión; **proyecto → confirmación por sesión** (global ejecuta sin preguntar) | Claude hooks docs | 7 |
| Variables de ruta normalizadas: `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PROJECT_DIR}`, `${extensionPath}${/}`, `${CLAUDE_SKILL_DIR}` → rutas absolutas del origen | parcial — `CLAUDE_PLUGIN_ROOT|CLAUDE_PLUGIN_DATA|CLAUDE_PROJECT_DIR|NICOTINE_PROJECT_DIR` (formas `${VAR}` y `$VAR`) expandidas en comandos de hooks; `${extensionPath}${/}` y `${CLAUDE_SKILL_DIR}` sin uso aún (no hay carga de código/skills de plugins que los consuma) | spec + docs | 7 |
| Namespaces: comandos de plugin `plugin:comando`; colisiones resueltas por precedencia y aviso | hecho — `plugin:comando` (y `plugin:dir:comando` en subdirs); builtins ganan; primera fuente registrada gana con aviso | Claude plugin docs (namespacing) | 7 |
| Confianza explícita antes de cargar hooks/MCP/extensiones de proyecto o paquete de terceros | hecho — proyecto: MCP una vez por servidor/sesión (igual que nativo); hooks una confirmación por sesión (lista fuentes); datos inertes (skills/comandos/agentes/temas) sin preguntar; código de terceros jamás se ejecuta; global no pregunta; doctor no lanza nada | spec; diálogo único por origen | 7 |

### L. Archivos de contexto (`src/compat/context-files.ts`)

| Función | Estado | Ref | Fase |
|---|---|---|---|
| `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` — recorrido de raíz → cwd, concatenados con encabezado de origen | hecho — encabezado `## ruta (kind)`; 32 KiB por archivo (nota de truncado en el bloque); aparecen en `doctor` | Codex (root→cwd, override), Claude, Gemini docs; spec | 4 |
| `AGENTS.override.md` (Codex) con precedencia sobre `AGENTS.md` en el mismo dir | hecho (misma directorio; en hijos no afecta al padre) | Codex docs | 4 |
| `instructions: []` en config (paths/globs/URLs) sumadas al contexto | hecho — paths y globs (relativos al cwd; `~`/`$HOME`/absolutos; máx 20) **y URLs**: se descargan ANTES del primer turno (no en el arranque síncrono) vía `prepareUrlContext`; timeout 10s, tope 32 KiB y máx 8 URLs por archivo; solo contenido textual; fallos/timeout → aviso claro y se omiten (la sesión arranca igual). 32 KiB por archivo local | `/docs/config#instructions` | 4 |
| `/init` genera `AGENTS.md` — prompt canned (explora y escribe/fusiona); `/init` no garantiza el modelo | hecho (3) | `/docs/tui#init` | 3 |

### M. Modos (`src/modes/`) y CLI

| Comando / modo | Estado | Ref | Fase |
|---|---|---|---|
| `nicotine` (TUI por defecto) | hecho — bare TUI en TTY (ANSI/OpenTUI); sin TTY cae al REPL plano | `/docs/cli` | 2 |
| `--print` / `-p` (un turno; stdout limpio, chatter en stderr) | hecho | `/docs/cli` run; Pi `-p` | 1 |
| `--json` (eventos JSONL a stdout) | hecho | spec | 1 |
| `serve` (HTTP opcional, **apagado por defecto**, expone el mismo flujo de eventos; basic auth por env `NICOTINE_SERVER_PASSWORD` **o `OPENCODE_SERVER_PASSWORD`**) | **hecho (2026-11, fase 9)** — diseño PROPIO mínimo (NO la API REST de OpenCode): `GET /health` `/session/current` `/sessions` `/session/export` · `POST /session/prompt` (SSE, mismos eventos del núcleo + `stream_end`) · `POST /session/abort`. Reglas duras: `NICOTINE_SERVER_PASSWORD` **obligatoria** (loopback incluido); sin TLS propio (proxy delante); bind 127.0.0.1; sin CORS; auth básica en TODOS los endpoints (usuario libre; comparación en tiempo constante); ask→reject sin `--auto`; un turno a la vez (409); body ≤1 MiB; mDNS/DNS-SD OPCIONAL (`--mdns` / `--mdns-domain`, `_nicotine._tcp`, `nicotine.local`; best-effort, ver fila); cierre limpio con señal. **Fase 10e (2026-11):** además de la API propia, serve añade un **subconjunto HONESTO de la API REST clásica de opencode** (SDK v1.18.0) para clientes opencode — ver fila «Subconjunto opencode REST»; `GET /session` pasa a forma opencode `Array<Session>` y la forma propia `{id,title}` se mueve a **`GET /session/current`** (cambio incompatible leve, documentado) | `/docs/server`; Pi `--mode json/rpc` | 3+/9 |
| `doctor` (fase 1: capas, reglas allow/ask/deny, modelo, tools, rg, websearch) — fase 4: orígenes de skills y archivos de contexto (+ `memory`) + avisos de config/compat; fase 7: sección Plugins multi-CLI (plugins, MCP ajeno, comandos/agentes/temas/hooks, unsupported); **fase 8**: policies v2 (contador) y estado de catálogos HTTP de skills (`nicotine skills update`) | hecho | spec | 1 / 4 / 7 / 8 |
| `--model provider/model`, `--agent`, `--continue/-c`, `--session/-s`, `--fork`, `--port/--hostname/--mdns` | hecho (2026-11) — `--port`/`--hostname` con `serve`; `--mdns`/`--mdns-domain` hecho (fase 10; ver fila serve) | `/docs/cli` | 2/3/9 |
| `--auto` (auto-aprueba lo no denegado) | hecho (también salta el diálogo TUI; deny sigue denegado) | `/docs/cli` | 2 |
| `--version`, `--help` | hecho | convención | 1 |

### N. No-objetivos de v1 (lite)

- Code Mode / `execute`, browser tool, worktrees, image_generate, warming, policies org, managed preferences, OAuth MCP completo, plugins ejecutables (OpenCode TS, Pi TS), telemetría, auto-update.
- `lsp` real: solo diagnóstico básico si hay servidor; no edición asistida.

## Verificación de entorno (2026-11-08)

- Bun **1.4.4** instalado en `~/.bun/bin` (npm global sin permisos → install script oficial). Node v20.20.2, git 2.47.3.
- Registry npm accesible: `@modelcontextprotocol/client@2.4.0`, `@modelcontextprotocol/core@2.4.0`, `@modelcontextprotocol/sdk@1.32.2` (legacy).
- OpenCode docs v1 (docs.opencode.ai) y v2 (opencode.ai/docs) accesibles; difieren en nombres (ver tabla v1/v2).
- Fase 8 (2026-11-09): **220/220 tests**, `tsc` limpio; e2e con mock provider contra un proyecto de pruebas (`/tmp/nicotine-e2e-proj`): `nicotine skills update` instaló y cacheó 1 skill desde un catálogo HTTP local (puerto 8798) con digest verificado; doctor lista contexto `memory`, agentes architect/editor, contador de policies; `--agent architect --print` ejecutó bash (ok) — y con `policies: [{action:"bash", resource:"echo *"}]` el MISMO comando fue bloqueado end-to-end aunque `--auto` lo habría aprobado (`policy v2 «echo *»`).
- Agentes en config `agents:{}` (2026-11-09, post-fase 8): **245/245 tests** (`tests/config-agents.test.ts`, +13); e2e: `doctor` lista los agentes de config con `(oculto)`/`[disabled]`, `--print --agent reviewer` envía el system prompt custom (sin «Eres Nicotine»), doctor marca `plan` como `[disabled]` (ausente de la selección), unit cubre merge canónico (permissions anexan en override de built-in), catálogo `task` con subagentes de config, modelo por subagente («helper-x» sin vendor/variant) verificado con fetch inyectado.
- Cierre de paridad (2026-11-09, post-fase 8): **232/232 tests** (`tests/config-commands.test.ts`, +12); e2e con mock provider (8799) sobre proyecto de pruebas: `nicotine doctor` lista «Comandos de config «commands» (2)» con avisos (variant descartada, def no-objeto ignorada); `--print` con `default_agent` inexistente → aviso + cae a `build` (exit 0); `--agent nope` → mensaje claro, exit 1. Expansión de argumentos corregida a la spec ($N mayor consume el resto; sin placeholder → args anexados tras línea en blanco). Implementado: `commands:{}` desde config (template requerido; `agent`/`model` honrados en TUI; `subagent`/`subtask` ignorados con aviso; builtins > config > archivo; `doctor` los lista). TODOs «sin verificar» quedaron resueltos en fase 8 (formatos Codex/Gemini verificados en máquina). Filas antes «falta» cerradas o honestamente parciales (tui.json: `scroll_speed` sin efecto; agentes de archivo sin merge de permissions; expansión de variables `${extensionPath}` pendiente).
- Cierre menor (2026-11): **247/247 → 251/251** tests. Añadido: `/connect` (auth.json 0600 + fallback en resolveProvider + línea en doctor; cobertura en `tests/connect-export.test.ts`), `/export` (Markdown a exports/, 0600), tui.json `scroll_speed` honrado como paso de paginado (PgUp/PgDn), frontmatter `permissions:`/`hidden:`/`disabled:` y body→`systemPrompt`/model en agentes `.md`, IDs anidados; `yaml-lite` ahora parsea listas de mapas en bloques. Sin tocar: serve/LSP/OAuth/`/fusion` (siguen gateados); auth nunca viaja a Google Drive.
- **mDNS (fase 10d):** `serve --mdns [--mdns-domain dominio]` anuncia el servicio DNS-SD `_nicotine._tcp.nicotine.local.` (por defecto) implementando PTR (enumeración y servicio), SRV, TXT (`path`, `api=nicotine-serve-1`, `version`) y A (primera IPv4 no-loopback). Zero-dep (node:dgram; codec DNS propio, RFC 6762 best-effort): respuestas QU-unicast o multicast según la pregunta; announce ×2 al arrancar; goodbye TTL 0 al cerrar; si 5353/multicast falla → aviso y serve arranca igualmente. Tests sobre unicast 127.0.0.1 con puertos efímeros (en sandbox no hay multicast fiable: la descubierta on-network no está verificada en vivo). opencode usa `_opencode._tcp.local` y `opencode.local`; nicotine usa su propio tipo/dominio para no aparentar ser opencode (su API REST tampoco es la de opencode).
- **Subconjunto opencode REST (fase 10e):** `nicotine serve` responde un subconjunto HONESTO de rutas de la API REST clásica de opencode (formas del SDK pre-generado **v1.18.0**, `packages/sdk/js`; NO el contrato experimental `/api/*` del repo actual — no es paridad y se documenta como tal). Auth: HTTP Basic (cualquier usuario) con `NICOTINE_SERVER_PASSWORD` **o** `OPENCODE_SERVER_PASSWORD` (la segunda solo para clientes opencode). `GET /doc` sirve un OpenAPI 3.1 con EXACTAMENTE las rutas implementadas; el resto devuelve 404 `{ error, doc: "/doc" }`. Implementado: `/global/health`, `/global/event`+`/event` (SSE; `server.connected` primero; GlobalEvent envuelve en `{directory, payload}`), `/path`, `/vcs` (git; 404 fuera de repo), `/project`+`/project/current` (proyecto sintético único por cwd), `/config` **sanitizada** (claves → `***`), `PATCH /config` → 404 (sin capa de escritura), `/config/providers`, `/provider`, `/provider/auth` (API key, nunca la clave), `/command` (comandos de config+plugins), `/agent` (permission APROXIMADO), `/mcp` (`untrusted`→`failed`; error con «oauth/401/authorize»→`needs_auth`), `/lsp` y `/formatter` (SIEMPRE `[]` — sin servidores persistentes), `/log`, `/find` (`rg --json` o fallback propio con offsets en bytes), `/find/file` (fuzzy, mismo motor que «@»), `/find/symbol` → 404, `/file`, `/file/content` (texto utf8 o base64 ≤2 MiB), `/file/status` (porcelain+numstat; `[]` fuera de repo), `/session` GET (todas las JSONL, forma opencode) + POST (crea; `parentID` → 400), `/session/status`, `/session/{id}` GET/PATCH(`title`)/DELETE (DELETE de la sesión activa → 409), `/session/{id}/message` GET (filas `{info,parts}`, `?limit=`) + POST (turno completo; `parts[]` de texto o `file://`; `noReply` → 400; `messageID` → 400; `model` → se honra `modelID` e ignora `providerID`; `tools{nombre:false}` filtra el turno; `agent` cambia el agente de la sesión; `system` sobreescribe el system SOLO ese turno; respuesta `{info: AssistantMessage, parts}` con el id ESTABLE derivado del JSONL), `/session/{id}/message/{messageID}`, `/session/{id}/prompt_async` (204 + turno en background), `/session/{id}/command` (solo comandos de config/plugins; builtins → 400 con la lista), `/session/{id}/abort` (true), `/session/{id}/todo` (última lista de `todowrite` del proceso; `id`/`priority` sintéticos), `/session/{id}/summarize` (compacta con el provider CONFIGURADO; `providerID/modelID` se aceptan y NO se honran; devuelve `compacted` boolean), `/experimental/tool(`/ids`) (tools del proceso; `parameters` = JSON Schema propio). Fuera: `/tui/*`, share/revert/unrevert/init/shell/diff/fork, `/pty`, `/instance/dispose`, `oauth/*`, `/find/symbol`, `/mcp/*/connect|disconnect`, PATCH `/config` → todos 404 honestos. Mapeo `ChatMessage → {info,parts}`: mensajes `tool` se pliegan en `ToolPart.state.completed.output` (el error de tool NO se persiste: siempre `completed`); `cost`/`tokens` = 0; ids `msg_<ts36>_<sha1>` estables entre live y recarga (deltas en vivo usan id provisional `msg_<ts>_live` hasta el `message.updated` final). Verificado en vivo (2026-11) con `scripts/mock-provider.ts`: turno E2E con tool `bash` (input parseado, output capturado), `prompt_async` 204→`idle`, `/find` con offsets, 404/409 honestos. Tests en `tests/opencode-rest.test.ts` (14 tests; XDG_DATA_HOME aislado).

- **Fase 10c (2026-11, aprobación «todo»):** adaptador **Vercel AI SDK** hecho como opt-in `provider.engine: "vercel-ai"` / `NICOTINE_PROVIDER_ENGINE` (import dinámico, 0 deps en core; falta de paquetes → error con el comando exacto; failover replicado con `maxRetries: 0`; integration real verificada contra ai@7.0.166 + @ai-sdk/openai-compatible@3.0.87 con mock SSE — texto, tool-call, usage; suite 295/295).

- **Fase 10 (2026-11, aprobación «todo» del usuario):** `instructions` con **URLs** hecho (fetch post-arranque, timeout 10s, tope 32 KiB, máx 8 URLs, contenido textual; fallos avisan y se omiten). repair-env.sh endurecido en el sandbox (re-añade credential helpers github/gist y la identidad git tras cada reset). **Rueda del ratón** hecho: ANSI engine decodifica SGR-mouse (1006, `?1000h`/`?1006h` solo si `tui.mouse`), rueda→scroll del historial en pasos de `scroll_speed`; OpenTUI engine registra `onMouseScroll` por fila (respeta `mouse: false`; requiere `useMouse`). Sigue fuera: `/fusion` (sin spec).

- **Fase 9 (2026-11, con aprobación explícita del usuario):** serve **hecho** (diseño propio, ver fila: auth básica obligatoria); LSP **hecho** (solo diagnostics, off con `lsp:` en config); OAuth MCP **hecho** (DCR+PKCE S256+RFC 8707; refresh automático; 401→refresh→1 reintento; sin CIMD); `/editor` y `$EDITOR` en `/export` (suspend/resume en ANSI y OpenTUI); failover de **modelos** (`provider.fallbackModels`/`NICOTINE_MODEL_FALLBACKS`); `diff_style=stacked` real; suite **275/275**. `/fusion` **sigue sin implementarse** (sin spec pública; no se inventa). Sigue fuera por diseño: ejecución de código de terceros, browser/Code Mode.
- **Decisión de presupuesto (fase 8, cierra TODO §Sin-verificar #8):** se RETIRA el tope único "core+compat < 1500 LOC" — era inalcanzable para la paridad demandada y seguir persiguiéndolo a martillazos producía cortes artificiales. Nueva política documentada y aplicada: (a) `src/core` (kernel agéntico: loop/provider/permissions/config/session/compact/undo/types/events/shell-scan/text-tool-calls/agents/context) ≤ **1800 LOC**, tope blando por archivo 300 — hoy **1796**; cualquier crecimiento neto debe desplazar o justificarse en el commit. (b) `src/compat/` (adaptadores de datos multi-CLI; nunca estado agéntico, nunca ejecución de código ajeno) queda FUERA del tope; protegida por: zero-dep, parse-only, un test por loader, tope blando ~400/archivo. (c) `src/ext/` (API pública de extensiones) 267 — congelada salvo extensiones aprobadas en fase. (d) Total a la vista: 1796 + 2451 + 267 ≈ 4.5k LOC con 220 tests. La extracción de compat a paquete propio queda como posible fase opcional futura si algún día se publica nicotine como librería; NO como precondición de la paridad.

- Fase 6 (2026-11-08): 148/148 tests (`bun test`), `tsc --noEmit` limpio; e2e con mock provider (`NICOTINE_MOCK_SCENARIO=extshout`): extensión de proyecto auto-aprobada con aviso, tool `ext_shout` ejecutada, `turn_end` log; `doctor` lista extensión sin importarla; MCP `prompts/list|get` verificados contra fake server.

- Fase 7 (2026-11-09): 170/170 tests, `tsc` limpio; e2e mock contra demo multi-CLI (`/tmp/mlcli-demo` con `.mcp.json`, `.claude/settings.json`, comandos/agentes .md): compuerta de proyecto MCP+hooks con aviso en `--auto`, hook PreToolUse `exit 2` bloqueando bash end-to-end, doctor lista sección multi-CLI sin conectar nada.

## Sin verificar / TODOs explícitos

1. ~~API de `@modelcontextprotocol/client@2.4.0`~~ **resuelto por desviación (Fase 5)**: cliente MCP propio sin deps; probe `server/discover` manual + fallback initialize; verificado con fakes stdio/HTTP/SSE.
2. ~~Sintaxis de argumentos de file-commands~~ **resuelto (Fase 7)**: `$ARGUMENTS` crudo + posicionales `$1..$9`.
3. ~~Ruta de skills de Codex~~ **resuelto (Fase 8)**: `$CODEX_HOME/skills` y proyecto `.codex/skills/` verificados; se escanean. `CODEX_HOME` respetado.
4. ~~Ruta de skills de Gemini CLI~~ **resuelto (Fase 4)**: flag `compat.geminiSkills: true` activa `.gemini/skills` + `~/.gemini/skills`; default false (ruta sin verificar).
5. ~~Layout de `.codex-plugin/`~~ **resuelto (Fase 8)**: verificado; carga `skills/` y `.mcp.json` de la raíz del plugin; hooks/apps → reporte, nunca ejecución.
6. ~~Formato de commands de extensiones Gemini~~ **resuelto (Fase 8)**: verificado; TOML en `commands/**/*.toml`, registrados como `<ext>:a:b…` con `{{args}}`→`$ARGUMENTS`.
7. **Cobertura del scanner de shell** (limitación aceptada de lite): splitter conservador propio (`shell-scan.ts`): `&&`, `||`, `;`, `|`, saltos de línea, comillas/escapes, `$(…)`/backticks recursivos; heredoc o balanceo imposible → comando completo; deny > ask > allow por segmento (nunca amplía permisos). No sustituye al scanner completo de OpenCode (bash/zsh/sh/powershell) — inherente a lite.
8. ~~Presupuesto core+compat (<1500)~~ **resuelto por decisión de fase 8**: tope único retirado; nueva política documentada (§Verificación de entorno, "Decisión de presupuesto"): `src/core` ≤ 1800 LOC (hoy 1796), `src/compat/` fuera del tope con sus propias salvaguardas, `src/ext/` congelada.
9. ~~Diff rendering OpenTUI~~ **resuelto (Fase 2 + Fase 8)**: `ui/width.ts` (CJK/emoji=2, combinantes/VS=0) integrado en `ansi-wrap`.
10. ~~`plan_enter`/`plan_exit`~~ **resuelto (Fase 3)**.

## Mapa fase → secciones

| Fase | Entrega (criterio de aceptación resumido) |
|---|---|
| 0 | Este documento ✔ |
| 1 | Núcleo + tools + permisos + config con renderer plano: `nicotine --print "hola"` responde; `bun test` verde |
| 2 | ✔ TUI: stream, editor multilínea, `@file` fuzzy, `/`+paleta, selector modelos/sesiones (en sesión), permisos con diff, temas, leader ctrl+x, motores opentui+ansi con fallback |
| 3 | ✔ Sesiones (fork/rename/delete), undo/redo por turno (sin git, pre/post imagen + backup), compactación un paso, subagentes (`task` general/explore, depth 1, sesión hija), `/init` (prompt canned), tools `plan-enter`/`plan-exit` |
| 4 | ✔ Skills + context files de todas las CLIs; `doctor` los lista; catálogos HTTP de skills llegaron en fase 8 (`nicotine skills update`) |
| 5 | ✔ MCP stdio/HTTP con probe `server/discover` + fallback legacy (prompts→comandos dinámicos pasan a fase 6) |
| 6 | ✔ Ext API + slots TUI (`src/ext/`, extensión de referencia `examples/extensions/shout.ts`). **`/fusion` diferido explícitamente** (sin spec; no se inventa comportamiento — decisión del usuario 2026-11-08) |
| 7 | ✔ Loaders plugins claude/codex/gemini/opencode/pi (+ `agents-dir` en fase 4) + hooks + MCP multi-origen + comandos/agentes/temas de archivo + `/fusion` sigue diferido |
| 8 | ✔ Mejoras: edit fail con "fragmento más parecido", compactación 2 pasos (poda sin LLM → resumen), failover/rotación claves (401/403/429/5xx), tool-calls-en-texto (Hermes/Qwen), memoria por proyecto (`.nicotine/memory.md`), architect/editor, policies v2 (hard-deny), PermissionDenied acotado, `nicotine skills update` (catálogos HTTP con verificación sha256), decisión de presupuesto (ver §N-2) |
