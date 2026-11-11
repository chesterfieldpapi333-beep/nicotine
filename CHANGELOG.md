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
- C3 «semantic action stream»: etiqueta de fase en el footer derivada de tool_start
  («analizando …», «editando <archivo>…», «ejecutando comando «…»»); toggle `ui.action_stream`
  en tui.json(c) (defecto: activado). El historial de tools no cambia.
- C6 perfil «minimal» `--solo-bash`: solo la tool `bash` + solo-lectura
  (read/glob/grep/webfetch); también restringe vault y LSP en runtime; pruebas de filtro.
- H1: `.editorconfig`, `.gitattributes`, `scripts/check-style.ts` (+`bun run check:style`).
- H2: verificación de release in-repo (`scripts/verify-release.sh`, `scripts/sbom.ts`) con
  `release/SHA256SUMS` y `release/SBOM.json` generados en el repo; sin publicar binarios.
- H7: fuzzing lite determinista de parsers (jsonc, shell-scan, text-tool-calls, apply_patch,
  matchPattern, redact) con PRNG sembrado.
- H9: release in-repo documentada (`docs/release.md`, tag `v0.2.0`).

### Seguridad
- vault_search/vault_read/digest: contenido con patrones de credenciales no sale hacia el modelo (fail-closed).
- `nic policy export|import|explain` + `--readonly`: política efectiva versionada (defaults→config→`.nicotine/policy.json`→CLI), deny-wins, export con origen de cada regla; `--readonly` deniega edit/bash/vault-write de forma no relajable.
- `nic doctor --security [--json]`: permisos 0600 de auth/oauth, scan de patrones de credencial en sesiones (conteo redactado), secretos literales en capas de config (solo clave, nunca valor), umask, credenciales en `.git/config`, deny-wins (sonda sintética). Exit 0/1.
- Bloqueo duro de rutas sensibles en tools de archivo (`src/security/paths.ts`):
  realpath/nearest-existing, symlink irresoluble fail-closed, `~/.ssh|aws|gnupg` y cualquier
  `.git` bloqueados sin importar reglas.
- Análisis estático de bash (`src/tools/bash-parser.ts`): destructivos
  (rm/dd/mkfs/chmod/chown/…), `curl|wget | sh|bash`, sustitución de red en shells,
  redirecciones a rutas sensibles → **ask forzado** (gana a allow; «always» degrada a «once»).
- Redacción de credenciales al persistir sesiones JSONL (`redactSecrets`, H3/H5).
- Sanitización ANSI de salida no confiable (`src/security/sanitize.ts`): el texto del
  modelo y la salida de tools se limpian antes de imprimir (se descartan movimiento de
  cursor, borrado, OSC —incl. 52 portapapeles—, DCS/SOS/PM/APC y controles C0/C1;
  solo sobrevive SGR básico).
- Límites de recursos (H4): salida de tools acotada (50 KiB por defecto,
  `NICOTINE_MAX_TOOL_OUTPUT_BYTES` o `tools.bash.maxOutputBytes`, máx. 4 MiB) y el completo
  en archivo temporal 0600.
- Auditoría opt-in (H8): `NICOTINE_AUDIT=1` escribe JSONL redactado y rotado;
  `nic audit export` lo vuelca.
- C2 refusal-failover (opt-in `compat.refusal_failover`): rechazo del proveedor → reintento
  con el siguiente `fallbackModels`; bufferiza el intento, nunca emite el texto del rechazo;
  solo routing, jamás prompts de evasión; motor fetch (vercel-ai lo ignora).
- Cadena de suministro (H6): pinning exacto + `packageManager` + lockfile congelado, sin
  lifecycle scripts (`docs/dependencies.md`).

### Corregido
- H10: `checkPath` deny-wins entre `external_directory` y la acción (`--readonly` + ruta
  externa → deny real). Detectado en la verificación final; `docs/verification-10f.md`.

## [0.1.0] — 2026-11-09 (fases 0–10f)
- Núcleo agéntico, TUI, sesiones, undo, compactación de 2 pasos, subagentes,
  skills multi-CLI, MCP, plugins lite, loaders multi-CLI, rename `vireo`→`nicotine`.

[0.2.0]: https://github.com/chesterfieldpapi333-beep/nicotine/releases/tag/v0.2.0
[0.1.0]: https://github.com/chesterfieldpapi333-beep/nicotine/releases/tag/v0.1.0
