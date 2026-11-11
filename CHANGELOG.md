# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).
Versionado: el proyecto aún no sigue semver estricto; cada fase cerrada sube minor.

## [Sin publicar] — 2026-11-11
- C3 «semantic action stream»: etiqueta de fase en el footer derivada de tool_start («analizando …», «editando <archivo>…», «ejecutando comando «…»»); toggle `ui.action_stream` en tui.json(c) (defecto: activado). El historial de tools no cambia.
- C6 perfil «minimal» `--solo-bash`: solo la tool `bash` + solo-lectura (read/glob/grep/webfetch); también restringe vault y LSP en runtime; pruebas de filtro.
- Bloqueo duro de rutas sensibles en tools de archivo (`src/security/paths.ts`): realpath/nearest-existing, symlink irresoluble fail-closed, `~/.ssh|aws|gnupg` y cualquier `.git` bloqueados sin importar reglas.
- Análisis estático de bash (`src/tools/bash-parser.ts`): destructivos (rm/dd/mkfs/chmod/chown/…), `curl|wget | sh|bash`, sustitución de red en shells, redirecciones a rutas sensibles → **ask forzado** (gana a allow; «always» degradar a «once»).
- C2 Refusal-failover (opt-in `compat.refusal_failover`): rechazo del proveedor → reintento con el siguiente `fallbackModels`; bufferiza el intento, nunca emite el texto del rechazo; solo routing, jamás prompts de evasión; motor fetch (vercel-ai lo ignora).
- Redacción de credenciales al persistir sesiones JSONL (`redactSecrets`).
- H1: `.editorconfig`, `.gitattributes`, `scripts/check-style.ts` (+`bun run check:style`).

## [0.2.0] — 2026-11-11

### Añadido
- Memoria persistente en vault de Obsidian (`vault_search`/`vault_read`/`vault_write`,
  digest en system prompt, escritura confinada a `00-Inbox/`, `01-Decisiones/`,
  `03-Contexto/`; `02-Sesiones/` reservada; credenciales filtradas/bloqueadas).
- Rescate de tool-calls en texto ampliado (`<tool_call>`, fences, XML, `<invoke>`,
  `<function=>` MLF, JSON desnudo) para modelos sin function-calling nativo; stats
  anonimizadas en `toolcall-stats.jsonl`.
- Catálogo de modelos `nic models` (badges tools/censura con heurística conservadora,
  overrides manuales, TUI `/models`).
- `nic download` (reintentos con backoff, sha256) y `nic analyze` (magic bytes, VT hash-only).
- Regla heredada: `/fusion` eliminado del alcance.

### Seguridad
- vault_search/vault_read/digest: contenido con patrones de credenciales no sale hacia el modelo (fail-closed).
- `nic policy export|import|explain` + `--readonly`: política efectiva versionada (defaults→config→`.nicotine/policy.json`→CLI), deny-wins, export con origen de cada regla; `--readonly` deniega edit/bash/vault-write de forma no relajable.
- `nic doctor --security [--json]`: permisos 0600 de auth/oauth, scan de patrones de credencial en sesiones (conteo redactado), secretos literales en capas de config (solo clave, nunca valor), umask, credenciales en `.git/config`, deny-wins (sonda sintética). Exit 0/1.

## [0.1.0] — 2026-11-09 (fases 0–10f)
- Núcleo agéntico, TUI, sesiones, undo, compactación de 2 pasos, subagentes,
  skills multi-CLI, MCP, plugins lite, loaders multi-CLI, rename `vireo`→`nicotine`.

[0.2.0]: https://github.com/chesterfieldpapi333-beep/nicotine/releases/tag/v0.2.0
[0.1.0]: https://github.com/chesterfieldpapi333-beep/nicotine/releases/tag/v0.1.0
