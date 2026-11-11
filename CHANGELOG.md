# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).
Versionado: el proyecto aún no sigue semver estricto; cada fase cerrada sube minor.

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
- `nic doctor --security [--json]`: permisos 0600 de auth/oauth, scan de patrones de credencial en sesiones (conteo redactado), secretos literales en capas de config (solo clave, nunca valor), umask, credenciales en `.git/config`, deny-wins (sonda sintética). Exit 0/1.

## [0.1.0] — 2026-11-09 (fases 0–10f)
- Núcleo agéntico, TUI, sesiones, undo, compactación de 2 pasos, subagentes,
  skills multi-CLI, MCP, plugins lite, loaders multi-CLI, rename `vireo`→`nicotine`.

[0.2.0]: https://github.com/chesterfieldpapi333-beep/nicotine/releases/tag/v0.2.0
[0.1.0]: https://github.com/chesterfieldpapi333-beep/nicotine/releases/tag/v0.1.0
