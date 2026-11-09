# Informe de fases — vireo

**Fecha:** 2026-11-09 · **Versión:** vireo 0.1.0 · **Estado:** Fases 0–7 cerradas y publicadas en `master` (`7576162 → 5368ddd`); Fase 8 **no aprobada**.

**vireo** es un agente de código CLI *lite*, compatible con el formato `opencode.json(c)`,
que lee skills/plugins/MCP de Claude Code, Codex, Gemini CLI, OpenCode y Pi. Motor propio
(sin `@opentui` forzado: ANSI de respaldo), TypeScript sobre Bun, **cero dependencias de
runtime de agentes** (solo `@opentui/core` opcional para la TUI).

Métricas globales al cierre de Fase 7:

| Métrica | Valor |
|---|---|
| Commits de fase | 8 (`14edee4`…`5368ddd`) |
| Tests | **170/170** (`bun test`, 19 archivos) |
| Typecheck | `tsc --noEmit` limpio (TS 7.0.2, Bun 1.4.4) |
| Presupuesto core+compat | **3548 líneas** (`src/core` 1424 + `src/compat` 2124) + `src/ext` 267 |
| Paridad (conteo de filas) | 87 hecho · 15 parcial · 16 falta (ver `docs/parity.md`) |
| Líneas del repo (src+tests+docs+examples) | ~10 100 |
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

## Estado de paridad por sección (ver `docs/parity.md` para el detalle fila a fila)

| Sección | Resumen |
|---|---|
| A. Tools | 12/12 del set lite; `edit` con snapshot undo; `apply_patch` propio |
| B. Permisos | allow/ask/deny last-match; deny re-evalúa tras allows guardados |
| C. Config | opencode.json(c) + capas raíz→cwd + `.opencode/`; `tui.json`; `extensions` |
| D. Core loop | streaming SSE; tool-calls; subagentes depth 1 |
| E. Sesiones | JSONL, fork, undo/redo, compactación 1 paso |
| F. Comandos | builtins + `/init` + MCP prompts + extensiones + archivo (fase 7); `commands: {}` en config **falta** |
| G. TUI | paridad funcional lograda; ANSI + OpenTUI; temas; leader; sin `onKey` para ext (v1) |
| H. Sesiones/historial | hecho; `snapshots:false` sin efecto (fase 8) |
| I. Skills | hecho; HTTP catalogs **falta** |
| J. MCP | stdio/HTTP stateless+legacy; multi-origen; OAuth fuera de lite |
| K. Plugins/hooks | **hecho** (este informe, fase 7) |
| L. Contexto | hecho; URLs en `instructions` **falta** |
| M. Modos | hecho; `serve` **falta** |
| N. No-objetivos | respeto: sin browser, sin Code Mode, sin LSP completo, sin plugins ejecutables |

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
| 9 | Presupuesto core+compat NO se cumplió (3548 vs <1500) | 8 | pendiente decisión fase 8 |
| 10 | `/fusion` nunca se inventó | 6–7 | sin spec; honestidad |

## Sin verificar / TODOs explícitos (vigentes)

1. ~~client@2.4.0 API~~ (resuelto fase 5, hand-roll). 
2. ~~Sintaxis args file-commands~~ (resuelto fase 7).
3. Ruta de skills de Codex (`~/.codex/skills`) — no confirmada; no se escanea.
4. Layout `.codex-plugin/` — sin manifest oficial; no se carga.
5. Formato de comandos de extensiones Gemini — sin verificar; no se cargan.
6. Cobertura del scanner de shell de vireo — conservador; no sustituye el de OpenCode.
7. Ancho de celdas CJK/emoji en el motor ANSI — mejora menor pendiente.
8. Modelo "tiny core" (<1500) — decisión fase 8.

## Fase 8 — pendiente de aprobación

Según `docs/parity.md` §Mapa: edit fail con "fragmento más parecido", compactación
**2 pasos**, failover/rotación de claves, tool-calls en texto, **memoria por proyecto**,
architect/editor, PermissionDenied legacy review, decisión de presupuesto (y posible
extraer `src/compat` del binomio). HTTP catalogs de skills podrían colar aquí.

## Operación del repo (entorno)

- Tests: `bun test` · typecheck: `bun x tsc --noEmit` · doctor: `bin/vireo doctor`.
- Push: `git push` (helper `~/.config/gh/git-credential.sh`, lee `~/.config/gh/hosts.yml`).
- **El sandbox se reinicia periódicamente** (pérdida de exec bits; `.git` y `node_modules`
  excluidos de snapshots): ejecutar `~/repair-env.sh` (chmod +x `bun`/`bin/vireo`, re-init
  `.git` + `reset --mixed origin/master`, `bun install`). El working tree sobrevive siempre.
- `/home/user/arena-terabox.md` nunca se commitea (credenciales TeraBox).
- `gh` **no está instalado** actualmente; el helper propio lo suple para push.
- Pendiente del usuario: **rotar el token de GitHub** (filtrado en logs el 2026-11-09, fase 6.5).

## Riesgos conocidos

- PreToolUse hooks ejecutan shell del proyecto (tras confirmación/auto): superficie real;
  la compuerta es la frontera, no hay sandbox.
- Tema/paleta y ancho CJK imperfectos en motor ANSI.
- `instructions` sin URLs; `snapshots:false` sin efecto; `/init` requiere un modelo real.
