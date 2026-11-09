# Informe de fases — vireo

**Fecha:** 2026-11-09 · **Versión:** vireo 0.1.0 · **Estado:** Fases 0–7 publicadas en `master` (`7576162 → 5368ddd`); **Fase 8 implementada y verificada** (commit en este informe).

**vireo** es un agente de código CLI *lite*, compatible con el formato `opencode.json(c)`,
que lee skills/plugins/MCP de Claude Code, Codex, Gemini CLI, OpenCode y Pi. Motor propio
(sin `@opentui` forzado: ANSI de respaldo), TypeScript sobre Bun, **cero dependencias de
runtime de agentes** (solo `@opentui/core` opcional para la TUI).

Métricas globales al cierre de Fase 8:

| Métrica | Valor |
|---|---|
| Commits de fase | 11 (`14edee4`…agentes desde config) |
| Tests | **245/245** (`bun test`, 24 archivos) |
| Typecheck | `tsc --noEmit` limpio (TS 7.0.2, Bun 1.4.4) |
| Presupuesto core+compat | **4247 líneas** (`src/core` 1796 + `src/compat` 2451) + `src/ext` 267 |
| Paridad (conteo de filas) | **104 hecho · 9 parcial · 4 falta** (ver `docs/parity.md`) |
| Líneas del repo (src+tests+docs+examples) | ~10 600 |
| Estrategia de testing en vivo | 100% mock (proveedor OpenAI falso + MCP fake + pty); sin APIs reales |

---

## 0 — Investigación de paridad (`14edee4`, con Fase 1)

**Objetivo:** documento guía con la paridad OpenCode *lite*, sección por sección (A–N).

**Entregado:** `docs/parity.md` — fuente de verdad de toda la ejecución: leyenda de
estados, fuentes consultadas (docs v1/v2 de OpenCode, specs MCP 2026-07-28, agentskills.io,
docs de Claude/Codex/Gemini/Pi), mapa fase → secciones, y TODOs «sin verificar».

**Decisiones:** lite = OpenCode sin la épica (sin Code Mode, sin browser, sin LSP completo,
sin OAuth MCP); español en la UI; sin dependencias si se puede hand-rollear.

## 1 — Núcleo + tools + permisos + config (`14edee4`)

**Entregado:** loop del agente (`src/core/loop.ts`, tool-calling con snapshots de undo),
provider OpenAI-compatible (SSE, streaming), resolución de provider/config con **capas**
(sistema/global/proyecto raíz→cwd/custom, merge profundo + last-match-wins en permisos),
12 tools (`bash`, `read/edit/write/glob/grep/list`, `apply_patch`, `todowrite`, `skill`,
`webfetch`, `websearch`), `ask/allow/deny` con `deny` siempre gana, diálogo de permiso con
diff, `--auto`, `--print/--json/repl`, `doctor` (esqueleto), sesiones JSONL, `--session/
--continue/--fork`.

**Verificación:** suite `loop/tools/permissions/config/session/compact/undo`; e2e con
`scripts/mock-provider.ts`.

## 2 — TUI (`835f7c4`)

**Entregado:** TUI propio — motor **ANSI** (alt-screen, diff-paint por línea, decodificador
propio) y motor **OpenTUI** (`@opentui/core` 0.8.3) tras la interfaz de componentes, con
fallback automático (`VIREO_UI_ENGINE=ansi` para forzar); editor multilínea (ctrl+j),
autocompletado `@file` fuzzy + `/` comandos y paleta (`ctrl+p`), ciclos de agente (tab),
selector de modelos/sesiones/temas, keybinds estilo leader (`ctrl+x`) con `tui.json`
merge-over-defaults, `/help`, temas JSON (tokens sobre `vireo-dark`), permisos con diff inline.

**Verificado:** `createTestRenderer` headless + smoke con pty.

## 3 — Sesiones, undo, compactación, subagentes (`ae39658`)

**Entregado:** fork de sesión sin truncar (copia, nunca destructiva), listar/renombrar/
borrar (`/sessions`, no se puede borrar la activa), título auto, **undo/redo por turno** sin
git (pre/post imagen + respaldo `pre-undo/`), compactación un paso (`compaction.*` en config),
**subagentes** `task` (tipos `general`/`explore`, profundidad 1, sin herencia de MCP,
comparten el undo), tools `plan-enter/plan-exit`, `/init` (prompt canned para AGENTS.md),
permisos `skill` para el tool `skill`.

## 4 — Skills + archivos de contexto (`21f5f25`)

**Entregado:** formato `SKILL.md` (agentskills.io) con parser YAML propio mínimo
(`yaml-lite.ts`, nesting ≤3, sin deps); escaneo global (opencode/claude/agents/pi) y proyecto
raíz→cwd + `.pi`, `.agents`, `.gemini` tras flag `compat.geminiSkills`; carga progresiva
(nombre+desc al arranque; body vía tool `skill` bajo demanda); `disable-model-invocation`;
validación name/directorio con aviso; precedencia last-wins-with-warning; archivos de
contexto (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `AGENTS.override.md`, 32 KiB por archivo);
`doctor` lista skills y contexto. **`instructions` de config: paths+globs, no URLs** (aviso).
**HTTP catalogs: NO** (sin fetch en arranque; sigue pendiente).

## 5 — MCP sin dependencias (`7576162`)

**Entregado:** cliente JSON-RPC 2.0 propio (desviación aceptada: `@modelcontextprotocol/client@2.4.0`
existe pero su API no estaba verificada; filosofía lite). stdio (line-delimited) y Streamable HTTP
(JSON directo o SSE; `mcp-session-id` capturado/reenviado). **Spec 2026-07-28 stateless**:
`server/discover` + headers `Mcp-Method/Mcp-Name` + `_meta io.modelcontextprotocol/protocolVersion`;
escalera legacy `2025-11-25 → 2025-06-18 → 2025-03-26 → 2024-11-05` (baja solo ante rechazo).
Timeouts startup/catalog/execution (5s/10s/60s, override por servidor). **Compuerta de confianza
por origen de proyecto** (una vez por servidor y sesión; `--auto` aprueba con aviso; sin TTY rechaza;
`doctor` nunca lanza). Nombres `<server>_<tool>` saneados; colisiones → primera + aviso. Resources
(`opencode_list/read_mcp_resource(s)`) solo si hay capability. **Prompts → comandos dinámicos: fase 6.**

**Verificado:** fakes stdio/HTTP/SSE + stateless 2026-07-28 (tests).

## 6 — API de extensiones lite + slots TUI (`90ad249`, ajustes en `97cf8c6`)

**Entregado (`src/ext/`, diseño propio):** `on(evento|*)` con unsubscribe, `registerTool`
(todos los modos), `registerCommand`/`registerShortcut`/slots/temas (solo TUI; no-op con aviso
fuera). Descubrimiento global (`~/.config/vireo/extensions`, confiable) / proyecto
(`.vireo/extensions/`, **compuerta de confianza ANTES de importar**; `--auto` aprueba con aviso;
rechazo ⇒ el módulo jamás se importa) / `extensions: [rutas]` en config. Errores de una
extensión no tumban a las demás; tools registradas solo tras `activate` OK. Slots render-only
(header/messages/widgets/editor/footer, con `safeRender`); atajos exigen ctrl/alt; builtins ganan.
**MCP prompts → `/<server>:<prompt>`** (args posicionales en orden declarado; el renderizado se
envía como turno). **Aprobaciones «always» persistentes por proyecto**
(`$XDG_DATA_HOME/vireo/approvals/<sha1(cwd)>.json`; deny siempre gana; el diálogo muestra el
patrón que se guardará). Extensión de referencia `examples/extensions/shout.ts`. Guía
`docs/extensions.md`.

**Métricas:** 148 → 150 tests (6.5). **Diferido explícitamente: `/fusion`** (sin spec; no se
inventó comportamiento). HTTP catalogs de skills: pendiente (init async).

## 7 — Loaders multi-CLI (`5368ddd`)

**Alcance aprobado con 5 decisiones** (hooks ejecución sí; comandos .md sí; TOML mini sí;
agentes sí; temas sí).

**Entregado:** descubrimiento multi-CLI (`src/compat/plugins.ts`): plugins Claude
(`plugin.json`; commands/agents/skills/hooks), extensiones Gemini (`gemini-extension.json`:
mcpServers + `excludeTools` + `contextFileName`), `.opencode/{commands,agents,themes}`,
`.pi/{prompts,themes,agents,skills}`, `~/.pi/agent/*`, `~/.config/opencode/*`. **Nunca ejecuta
código de terceros**: `.opencode/plugins/*.ts`, packages pi en `node_modules`, comandos Gemini
de extensión (formato sin verificar), `~/.claude.json` → reporte «no soportado».

- **Comandos de archivo** (`file-commands.ts`): frontmatter `description`/`argument-hint`
  (`model`/`agent` ignorados con aviso), `$ARGUMENTS` crudo + `$1..$9`, namespacing `plugin:cmd`,
  builtins ganan.
- **Agentes de archivo** (`agent-files.ts`): `description` requerida; `mode` (def subagent);
  `tools:` Claude→vireo mapeado; TUI `/agent` y tool `task` los ven (`subagent_type`).
- **Hooks** (`hooks.ts`): `PreToolUse` (exit 2 **bloquea antes del diálogo**; stderr → modelo),
  `PostToolUse` (informativo); `matcher` regex; stdin JSON; `bash -lc`; env
  `CLAUDE_PROJECT_DIR`/`VIREO_PROJECT_DIR`/`CLAUDE_PLUGIN_ROOT`; timeout 5s. **Proyecto →
  una confirmación por sesión** (lista fuentes); global no pregunta. Si el usuario rechaza,
  solo globales activos.
- **MCP multi-origen** (`manager.ts` + `toml-lite.ts` propio): `.mcp.json`, gemini settings.json,
  codex `[mcp_servers]`; nativa > proyecto (dentro→fuera) > global; `excludeTools` aplicado.
- **Temas JSON ajenos** (`foreign-themes.ts`): shape A (tokens vireo) y B best-effort; ≥2 tokens
  o descarte; aparecen en `/themes`.
- **doctor**: sección «Plugins multi-CLI» completa; nunca conecta ni ejecuta.

**Métricas:** 170/170 tests; e2e: hook PreToolUse bloqueó `bash` end-to-end vía mock;
`demo_echo` vía `.mcp.json`; doctor completo. **+1554 líneas** → presupuesto core+compat
**2506 → 3548** (decisión de la fase 8; candidato: extraer `src/compat`).

---

## 8+ — Cierre de paridad (commit propio tras fase 8)

**Objetivo:** cerrar las filas de paridad honestamente implementables tras la fase 8,
sin inventar alcance (serve/OAuth/LSP se mantienen fuera).

**Entregado:**

- **Comandos custom desde config** `commands: {}` (`src/compat/config-commands.ts`):
  `template` requerido; `$ARGUMENTS` y `$1..$9`; **el posicional mayor consume su
  argumento y todo lo posterior** (spec commands verificada 2026-11); plantillas sin
  placeholder y con argumentos los anexan tras línea en blanco (fallback spec);
  `agent` cambia el agente de la sesión en TUI (como /agent), `model` fija el modelo
  (variant `#…` descartada con aviso); `subagent`/`subtask` se aceptan pero se IGNORAN
  con aviso (sin sesiones en background); bloques shell `` !`…` `` quedan LITERALES
  con aviso; builtins ganan > config > comandos de archivo; `doctor` lista los comandos
  de config y sus avisos.
- **Fix de expansión posicional** en `renderCommandBody` (compat): pasa a cumplir la
  spec ($N mayor greedy) y añade el fallback — afecta también a comandos de archivo.
- **Fallback de `default_agent`**: agente desconocido EN LA CONFIG → aviso + `build`;
  `--agent` desconocido → error exit 1 (comportamiento previo preservado).
- **Docs honestas**: 8 filas de parity.md flipadas a hecho o parcial-con-motivo
  (carpetas plurales f7, saved approvals 6.5, `model`+fallback, `tui.json`,
  `default_agent`, modos, «ocultar internos» (no aplica: no hay agentes internos),
  `/init` fase 3, `/commands{}` nueva). Faltas restantes justificadas: Vercel AI SDK,
  LSP ×2, `serve` (fase propia), merge de agentes en config.
- **Sin crecimiento de core**: los cambios viven en `src/compat` (config-commands.ts,
  +~95 LOC) y `src/modes`/`src/ui`; el cap de core (≤1800) se respeta (1796).

**Métricas:** 220 → **245/245** tests. e2e con mock provider: doctor lista comandos
de config con avisos; `--print` con `default_agent` inválido cae a build (exit 0);
`--agent nope` → exit 1 con mensaje.

### 8+i — Agentes personalizados en config (`agents: {}`)

**Objetivo:** cerrar la última fila «falta» de la sección F/E en condiciones seguras
(solo datos, nunca ejecución), con la spec oficial verificada.

**Entregado:**

- `src/compat/config-agents.ts`: parsea `agents: {}` desde la config. Soporta
  `description`, `mode` (primary por defecto para nuevos; override conserva el del
  built-in), `system` (sustituye la identidad/estilo, conserva entorno + contexto +
  skills), `model` (usado por subagentes; vendor/ y #variant se descartan al
  aplicarlo), `permissions` (reglas anexadas tras globales), `hidden`,
  `disabled`. `steps`, `color`, `request` y campos V1 se ignoran con aviso.
- Merge canónico de agentes (spec agents#merging): primero capas de config
  (`deepMerge` ya concatena `permissions` en cualquier nivel), luego
  built-in < archivo < config; escalares sustituyen; las reglas se ANEXAN;
  `disabled` elimina (incluso un built-in), `hidden` oculta de tab y del catálogo
  `task` sin impedir `--agent`.
- La tool `task` expone el catálogo real de subagentes (`subagent`/`all` no
  ocultos), y el subagente ejecuta con **su modelo** (verificado con fetch inyectado:
  padre «mock-model», hijo «helper-x», padre «mock-model»).
- `--agent` y `default_agent` aceptan agentes de config; `doctor` lista los de config
  marcando `(oculto)` y `[disabled]`.
- **Fix latente**: los modelos fijados por comando/subagente pasan por `stripModel`
  (antes se enviaba «vendor/model» crudo al endpoint). Sin
  cambios en `src/core/provider.ts` aparte del helper exportado.

**Métricas:** 232 → **245/245** tests. e2e: ver `docs/parity.md` §Verificación.

## Cierre de candidatos menores (2026-11)

Hasta 251/251. Bloque de paridad menor entregado:
- `/connect`: añade proveedor con API key (catálogo OpenAI-compatible + personalizado); clave oculta, `auth.json` 0600, encaje exacto por baseURL (o default openai), config/env ganan siempre; `doctor` reporta nº de proveedores (nunca la clave).
- `/export`: sesión actual → Markdown en `$XDG_DATA_HOME/vireo/exports/` (0600; roles usuario/asistente/tool; omite el system prompt). No abre `$EDITOR` en v1.
- tui.json `scroll_speed`: honrado como paso de PgUp/PgDn (`round(speed×4)` líneas) y de rueda (`scroll_speed` líneas/notch). Rueda cableada en ANSI (SGR-mouse 1006) y OpenTUI (`onMouseScroll`); `mouse: false` la desactiva.
- Agentes `.md`: frontmatter `permissions:` (por entrada, con `normalizeAction`; efecto inválido → aviso + omisión), `hidden`/`disabled`, `body→systemPrompt`, `model` honrado (vendor/ y #variant cortados al pedir), IDs anidados por subdirectorio (`team/reviewer`); `name:` pisa el ID de ruta. `yaml-lite` ahora parsea listas de mapas en bloques.
- Tests nuevos: `tests/connect-export.test.ts` (4) + 2 en `config-agents.test.ts`.
- serve **hecho** (fase 9, aprobada): diseño propio mínimo, auth básica obligatoria,
  ask→reject sin --auto, un turno a la vez; LSP **hecho** (solo diagnostics, off por
  defecto con `lsp:` en config; JSON-RPC Content-Length propio); OAuth MCP **hecho**
  (OAuth 2.1 + PKCE S256 + RFC 8707/9728/8414/7591; refresh single-flight; 401→refresh→
  1 reintento; `vireo mcp auth|logout|list`; tokens 0600; sin CIMD);
  `/editor` y `$EDITOR` en `/export` (suspend/resume de la TUI en ANSI y OpenTUI);
  failover de **modelos** (`provider.fallbackModels`/`VIREO_MODEL_FALLBACKS`);
  `diff_style=stacked` real; suite **275/275**.
- Sigue sin implementarse: `/fusion` (sin spec pública). Sigue fuera por diseño:
  código de terceros, browser/Code Mode.

## Estado de paridad por sección (ver `docs/parity.md` para el detalle fila a fila)

| Sección | Resumen |
|---|---|
| A. Tools | 12/12 del set lite; `edit` con snapshot undo; `apply_patch` propio |
| B. Permisos | allow/ask/deny last-match; deny re-evalúa tras allows guardados |
| C. Config | opencode.json(c) + capas raíz→cwd + `.opencode/`; `tui.json`; `extensions` |
| D. Core loop | streaming SSE; tool-calls; subagentes depth 1 |
| E. Sesiones | JSONL, fork, undo/redo, compactación **2 pasos** (poda sin LLM → resumen); agentes desde config con merge spec (8+i) |
| F. Comandos | builtins + `/init` + MCP prompts + extensiones + archivo + **`commands: {}` en config** (2026-11) |
| G. TUI | paridad funcional lograda; ANSI + OpenTUI; temas; leader; `tui.json` separado (`scroll_speed` → PgUp/PgDn); `/export`·`/connect` vivos; sin `onKey` para ext (v1) |
| H. Sesiones/historial | hecho; `snapshots: false` honrado (no se toman snapshots) |
| I. Skills | hecho **+ catálogos HTTP** con verificación sha256 (`vireo skills update`; init nunca descarga) |
| J. MCP | stdio/HTTP stateless+legacy; multi-origen; OAuth fuera de lite |
| K. Plugins/hooks | **hecho** (este informe, fase 7) |
| L. Contexto | hecho; URLs en `instructions` **falta** (parcial deliberado) |
| M. Modos | hecho — `serve` **hecho** (diseño propio, auth obligatoria) |
| N. No-objetivos | respeto: sin browser, sin Code Mode, LSP solo diagnostics mínimo (fase 9), sin plugins ejecutables |

## Decisiones arquitectónicas relevantes

| # | Decisión | Fase | Razón |
|---|---|---|---|
| 1 | UI en español; paths `~/.config/vireo`, sesiones `~/.local/share/vireo` | 1 | identidad lite propia |
| 2 | Cero deps en núcleo; YAML/TOML propios mínimos | 1,4,7 | filosofía lite |
| 3 | MCP client hand-rolled (desviación aceptada) | 5 | API de client@2 no verificada |
| 4 | `.ts` de terceros NUNCA se ejecuta; datos sí | 6,7 | confianza > paridad |
| 5 | Compuerta de confianza única y consistente (MCP/ext/hooks proyecto) | 5–7 | un solo modelo mental |
| 6 | Hooks PreToolUse bloquean ANTES del permiso | 7 | el usuario manda, no el modelo |
| 7 | Slots de extensión render-only, aditivos | 6 | robustez del frame |
| 8 | Undo por pre/post imagen sin git | 3 | portabilidad |
| 9 | Presupuesto: tope único <1500 retirado; política nueva (core ≤ 1800, compat fuera del tope) | 8 | paridad exige datos multi-CLI; corte artificial peor que presupuesto honesto |
| 10 | `/fusion` nunca se inventó | 6–7 | sin spec; honestidad |

## Sin verificar / TODOs explícitos (vigentes)

1. ~~client@2.4.0 API~~ (resuelto fase 5, hand-roll).
2. ~~Sintaxis args file-commands~~ (resuelto fase 7).
3. ~~Ruta de skills de Codex~~ (resuelto fase 8: `$CODEX_HOME/skills` y `.codex/skills/` verificados; se escanean).
4. ~~Layout `.codex-plugin/`~~ (resuelto fase 8: verificado; se cargan `skills/` y `.mcp.json`; hooks/apps → reporte, jamás ejecución).
5. ~~Formato de comandos de extensiones Gemini~~ (resuelto fase 8: TOML en `commands/**/*.toml`, espacio de nombres `<ext>:...`).
6. Scanner de shell de vireo — **limitación aceptada, no pendiente**: conservador por diseño; nunca amplía permisos.
7. ~~Ancho de celdas CJK/emoji en el motor ANSI~~ (resuelto fase 8: `ui/width.ts` — CJK/emoji = 2, combinantes/VS = 0; integrado en `ansi-wrap`).
8. ~~Modelo "tiny core" (<1500)~~ (resuelto fase 8 por decisión documentada: ver §Decisión de presupuesto en `parity.md`).

## 8 — Mejoras OpenCode-v2 + cierre de paridad (esta entrega)

**Objetivo:** cerrar el backlog de mejoras internas (edit inteligente, compactación
de dos pasos, rotación de claves, tool-calls en texto, memoria, agentes architect/editor,
policies v2) y los TODOs «sin verificar» de las fases anteriores, más la decisión del
presupuesto núcleo.

**Entregado (todo en este árbol, commit adjunto):**

- **Compactación de dos pasos** (`src/core/compact.ts`): (1) poda **sin LLM** —
  salidas de tool > 1.2 KB se truncan y los `arguments` grandes de tool_calls se
  encogen; (2) resumen con el modelo solo si aún no cabe. Menos tokens legado, mismo
  comportamiento visible.
- **Edit con near-match** (`src/core/tools/edit.ts`): si ningún fragmento casa
  exactamente, se propone el más parecido con diff coloreado antes del diálogo de
  permisos (el modelo ve la sugerencia; el usuario decide).
- **Failover de proveedor / rotación de claves** (`provider.ts`): pool
  `provider.apiKey`/`provider.apiKeys`; ante 401/403/429/5xx rota y reintenta con
  backoff; agota el pool y entonces falla limpio.
- **Tool-calls en texto** (`text-tool-calls.ts`): rescate de `<tool_call>{…}</tool_call>`
  (Hermes/Qwen) y bloques ```` ```json ```` con `name`/`arguments` cuando el modelo no
  usa FC nativo.
- **Memoria por proyecto** (`.vireo/memory.md`): se carga como archivo de contexto
  `kind=memory` al arrancar; `/init` y agentes la escriben con la tool write.
- **Agentes `architect` y `editor`** (built-ins): architect deniega edit (diseño);
  editor aplica cambios mínimos verificados (deniega bash destructive patterns).
- **`policies` v2** (`policies: [{action, resource}, …]`): hard-deny post-reglas;
  `bash` sin expansión; gana incluso a `--auto` (verificado end-to-end).
- **PermissionDenied** review: errores de permisos llegan al modelo con detalle
  (acción/recurso/regla) en vez de un «no» genérico.
- **`snapshots: false`** honrado: no se crean pre/post snapshots (paridad v2).
- **Catálogos HTTP de skills** (`src/compat/skill-catalog.ts` + `vireo skills update`):
  índice `.well-known/agent-skills/index.json`, **digest sha256 obligatorio** por
  SKILL.md, caché limpia en `$XDG_CACHE_HOME/vireo/skills-http/<hash-url>/`, init jamás
  descarga (lectura síncrona de caché), `doctor` reporta estado y fecha. Riesgo de
  supply-chain mitigado: NUNCA se ejecuta nada de la red; digest impide swaps.
- **Formats VERIFICADOS** (vs TODOs): Codex skills (`$CODEX_HOME/skills`
  + proyecto `.codex/skills/`), `.codex-plugin/plugin.json` (carga `skills/` y
  `.mcp.json`; hooks/apps → reporte), comandos de extensiones Gemini (TOML en
  `commands/**/*.toml`, `{{args}}` → `$ARGUMENTS`, nombre `<ext>:a:b…`).
- **CJK/emoji** (`ui/width.ts`): anchos de celda correctos; integrado en `ansi-wrap`.
- **`$schema` de la config**: predicado aceptaba «agentskills|agent-skills»; el discovery
  oficial `schemas.agentskills.io/discovery/0.2.0/schema.json` ya no provoca aviso falso.
- **Decisión de presupuesto** (documentada en `parity.md` §Verificación de entorno):
  se retira el tope único <1500; política nueva — `src/core` ≤ **1800 LOC** (hoy 1796),
  `src/compat/` fuera del tope (zero-dep, parse-only, un test por loader, ~400/archivo),
  `src/ext/` congelada (267). Extracción de compat a paquete propio queda como fase
  opcional futura, no como precondición.

**Métricas:** 170 → **220/220** tests (1 archivo nuevo (`config-commands.test.ts`; +12 tests): `tests/fase8.test.ts`,
`tests/skill-catalog.test.ts`); e2e con mock provider: `skills update` instaló 1 skill
desde catálogo local con digest verificado; doctor lista `memory`/architect/policies;
`--agent architect --print` ejecutó bash (ok) y con
`policies: [{action:"bash", resource:"echo *"}]` el MISMO comando fue bloqueado
(`policy v2 «echo *»`); MCP multi-origen y hooks sin cambios de comportamiento.

**Diferido (sin cambios):** `/fusion` (sin spec), `serve` HTTP, OAuth MCP, URLs en
`instructions`, LSP real.

## Operación del repo (entorno)

- Tests: `bun test` · typecheck: `bun x tsc --noEmit` · doctor: `bin/vireo doctor`.
- Push: `git push` (helper `~/.config/gh/git-credential.sh`, lee `~/.config/gh/hosts.yml`).
- **El sandbox se reinicia periódicamente** (pérdida de exec bits; `.git` y `node_modules`
  excluidos de snapshots): ejecutar `~/repair-env.sh` (chmod +x `bun`/`bin/vireo`, re-init
  `.git` + `reset --mixed origin/master`, `bun install`). El working tree sobrevive siempre.
  Re-ejecutado **2026-11-09** (fase 8); el árbol surviviente incluía todos los cambios de fase.
- `/home/user/arena-terabox.md` nunca se commitea (credenciales TeraBox).
- `gh` **no está instalado** actualmente; el helper propio lo suple para push.
- Pendiente del usuario: **rotar el token de GitHub** (filtrado en logs el 2026-11-09, fase 6.5).

## Riesgos conocidos

- PreToolUse hooks ejecutan shell del proyecto (tras confirmación/auto): superficie real;
  la compuerta es la frontera, no hay sandbox.
- Ancho CJK/emoji en motor ANSI **resuelto** (fase 8); quedan matices menores de temas
  ajenos best-effort (shape B).
- `instructions` sin URLs (parcial deliberado); `snapshots:false` **resuelto**; `/init`
  requiere un modelo real; HTTP catalogs exigen digest sha256 índice ↔ disco.
- Presupuesto core+compat: riesgo de deriva de compat LOC si se añaden loaders sin
  discusión previa (tope blando ~400/archivo + test por loader lo contienen).

- **Fase 10c (2026-11, aprobación «todo»):** adaptador **Vercel AI SDK** opt-in (`provider.engine: "vercel-ai"` o `VIREO_PROVIDER_ENGINE=vercel-ai`). Import dinámico de `ai` + `@ai-sdk/openai-compatible`; el núcleo sigue con cero deps; sin paquetes, el error dice exactamente qué instalar. Failover del motor fetch replicado (`maxRetries: 0`); conversión OpenAI→ModelMessage probada en seco + contra mock SSE local con los paquetes reales (ai@7.0.166 / @ai-sdk/openai-compatible@3.0.87). El paquete de verdad sale de `package.json`/`bun.lock` tras verificar.

- **Fase 10 (2026-11, aprobación «todo»):** `instructions` con URLs (fetch post-arranque, timeout 10s, 32 KiB/8 URLs, solo texto; fallos → aviso y omisión; `prepareUrlContext`); suite **277/277**. repair-env.sh re-añade credential helpers automáticamente.
