# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).
Versionado: el proyecto aún no sigue semver estricto; cada fase cerrada sube minor.

## [Sin publicar]
- Precisión D2 (sin ensanchar): `find -exec[dir]` detecta el comando como PRIMER token tras `-exec` con basename (`-exec echo rm` ya no dispara; `-exec /bin/rm` sí; `-execdir` igual). `.git` en redirecciones exige `/` o fin de ruta (`.git-ok/…` ya no dispara). Mismas asks, menos falsos positivos; ninguna validación se relaja.
- D2 G1-ter: redirecciones ABSOLUTAS multi-segmento a rutas sensibles ahora detectan (`/home/u/.ssh/…`, `/root/.gnupg/…`, `/srv/app/.git/hooks/…`, `tee /etc/…`); `myfile.ssh/x` absoluto y relativo sigue limpio; `/usr/bin/tee` y `/home/u/.cache` limpios. Solo-ensancha-ask, jamás deny. Queda cubierto el último límite reportado de D2.
- Refuerzo (arena/467143bf, PR #4): tests de borde + caracterización de huecos confirmados por probe (G2 fallback sin cierre · G3a `rmdir`/`unlink`/`rm` entre comillas · G3b `-F` mayúscula y `git -C … clean`) — congelar ≠ bendecir; src sin tocar, specs propuestas en el reporte del PR.
- Refuerzo (docs, PR #4): equipos viejos marcados «(superado)»; errata G2 («fallback al comportamiento anterior» → cuerpo segmentado, más ask); doctor sin `--security` = informativo (gate `--security`); nota de hashes en `arranque-workers.md` (solo verifican en clon completo).
- Higiene de claims (refuerzo detrás): README sin conteo fijo de tests; CHANGELOG sin conteo fijo de sumas; `plan-implementacion.md` — tabla de estado viva archivada como registro histórico (hechos vivos → README/CHANGELOG/sumas); `cea7ade4` (hash fantasma) eliminado.
- D2 G2: `shell-scan` extrae cuerpos de heredoc ANTES de segmentar — el `rm` dentro del heredoc ya no lo oculta (ni lo inventa); comandos tras el heredoc sí se detectan; ante cierre no encontrado, el cuerpo queda a la vista del splitter (más ask, nunca más allow; el comportamiento previo era un solo segmento — errata verificada por refuerzo, PR #4). Falso negativo estructural de D1 corregido.
- D2 (parcial): detección de `find … -delete`, `find … -exec[dir] rm`, y `git clean` con fuerza sin `-n` (simula) → ask; ambos aprobados por el dueño (OK «sí a todo», 2026-11-11).
- D2 (parcial): `exec` añadido a los wrappers de `bash-parser` (G4) y `.git` añadido al bloqueo de redirecciones incl. prefijo `./` (G1); invariantes intactos (solo ensancha `ask`).
- Arranque de la sesión de refuerzo (`docs/arranque-refuerzo.md`): revisa/mejora **detrás** del mantenedor (auditar lo fusionado, ampliar tests, proponer specs — jamás tocar `src/` sin spec).
- Propuesta L1 `docs/design/d2-bash-parser-gaps.md`: cerrar los huecos de D1 (G4 `exec` wrapper · G1 `.git` en redirecciones · G2 heredoc→segmentos · G3 `find -delete`/`git clean` con OK del dueño). Implementado completo (G4, G1, G3, G2; G1-bis 2026-11-12) con OK del dueño; el documento queda como registro de diseño.
- D1 fusionada: `tests/bash-parser-adversarial.test.ts` (+46 casos: heredocs un-segmento, citas mixtas, unicode, wrappers/flags, redirecciones, encadenados — los huecos conocidos documentados como caracterización «congelar ≠ bendecir»). Pipeline vigente: mantenedor construye; la sesión de refuerzo revisa/mejora detrás.
- Arranque-workers: D1 referencia la spec `docs/design/d1-bash-parser-tests.md`.
- Docs `docs/arranque-claude.md`: prompt de arranque para el ROL de mantenedor (specs, revisión, merges, releases; lanes L0/L1/L3/L6/L7; invariantes y loop de trabajo).
- Equipo simplificado a **Claude + DeepSeek** (dueño): GLM/Gemini fuera; `docs/equipo.md`, `docs/equipo-capas.md`, `docs/arranque-workers.md`, `docs/equipo-interno.md` reescritos (L0–L7 con dos roles); ejemplos de agentes reducidos a `deepseek-impl`; prompt único para DeepSeek.
- Mantenedor: Q1–Q4 marcados ✅ en `docs/qwen-tasks.md` (merge PR #2 `93ba8ce` / PR #3 `2ab5ba8`); addendum en `docs/verification-10f.md`; sumas in-repo regeneradas tras integrar los PRs (196 en ese momento).
- Docs `docs/equipo-capas.md`: equipo multi-modelo repartido por CAPAS (L0 dirección → L1 diseño → L2/L4 DeepSeek implementación+resiliencia → L3/L5 GLM documentación+tests masivos → L6 Gemini adversarial → L7 release) + matriz superficie×capas y prompts listos para pegar. (superado: reparto L3/L5 GLM · L6 Gemini reemplazado por el equipo simplificado a Claude + DeepSeek — ver «Equipo simplificado» arriba).
- Docs `docs/equipo-interno.md` + `docs/examples/multi-modelo/agents/`: cómo armar un equipo multi-modelo dentro de nicotine (gateway OpenAI-compatible único, agentes con `model` propio, analista de solo lectura); ejemplos verificados contra `scanAgentFiles`.
- Equipo multi-modelo documentado (`docs/equipo.md`, `docs/arranque-workers.md`): Claude estructura, DeepSeek/GLM programan, Gemini analiza (solo lectura), Qwen mantiene su cola. (superado: GLM/Gemini fuera del equipo actual — ver «Equipo simplificado a Claude + DeepSeek»).
- C5 `nic doctor`: sección «CLIs en PATH» con las CLIs detectadas en disco y `--versions` opt-in
  (ejecuta `--version` con timeout 2 s, primera línea ≤120 chars, sin secretos).
- Sanitización ANSI de salida no confiable (`src/security/sanitize.ts`): el texto del modelo y la
  salida de las tools se limpian antes de imprimir (fuera movimiento de cursor, borrado, OSC —incl. 52
  portapapeles—, DCS/SOS/PM/APC y controles C0/C1; solo sobrevive SGR básico).
- `undo`: el manifest se poda **antes** de escribirse y la escritura es atómica (`manifest.json.tmp` +
  `renameSync`), así nunca cita imágenes ya borradas ni se pierde por un corte a mitad de escritura.
- Pipeline unificado (dueño, 2026-11-12): la sesión de refuerzo se cerró sin entregas; «no hay más clon; vos nomás estás… trabajas solo devuelta». El mantenedor construye y refuerza solo. Docs del reparto actualizados (`docs/equipo.md`, `docs/equipo-capas.md`, `docs/arranque-workers.md`, `docs/arranque-refuerzo.md`, `docs/review-d1.md`).
- Como v0.2.0/v0.2.1: sin binarios, sin firmas; la publicación es el código fuente — quien clona, verifica (`docs/release.md`).

## [0.2.1] — 2026-11-11

### Corregido / añadido (hardening fusionado)
- H10 fix: `checkPath` deny-wins entre `external_directory` y la acción (`--readonly` + ruta externa → deny real). Detectado en la verificación final; `docs/verification-10f.md`.
- C3 «semantic action stream»: etiqueta de fase en el footer derivada de tool_start («analizando …», «editando <archivo>…», «ejecutando comando «…»»); toggle `ui.action_stream` en tui.json(c) (defecto: activado). El historial de tools no cambia.
- C6 perfil «minimal» `--solo-bash`: solo la tool `bash` + solo-lectura (read/glob/grep/webfetch); también restringe vault y LSP en runtime; pruebas de filtro.
- Bloqueo duro de rutas sensibles en tools de archivo (`src/security/paths.ts`): realpath/nearest-existing, symlink irresoluble fail-closed, `~/.ssh|aws|gnupg` y cualquier `.git` bloqueados sin importar reglas.
- Análisis estático de bash (`src/tools/bash-parser.ts`): destructivos (rm/dd/mkfs/chmod/chown/…), `curl|wget | sh|bash`, sustitución de red en shells, redirecciones a rutas sensibles → **ask forzado** (gana a allow; «always» degradar a «once»).
- C2 Refusal-failover (opt-in `compat.refusal_failover`): rechazo del proveedor → reintento con el siguiente `fallbackModels`; bufferiza el intento, nunca emite el texto del rechazo; solo routing, jamás prompts de evasión; motor fetch (vercel-ai lo ignora).
- Redacción de credenciales al persistir sesiones JSONL (`redactSecrets`).
- H1: `.editorconfig`, `.gitattributes`, `scripts/check-style.ts` (+`bun run check:style`).
- H2: verificación de release in-repo (`scripts/verify-release.sh`, `scripts/sbom.ts`) con
  `release/SHA256SUMS` y `release/SBOM.json` generados en el repo; sin publicar binarios.
- H7: fuzzing lite determinista de parsers (jsonc, shell-scan, text-tool-calls, apply_patch,
  matchPattern, redact) con PRNG sembrado.
- H9: release in-repo documentada (`docs/release.md`, tags `v0.2.0` y `v0.2.1`).

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

[0.2.1]: https://github.com/chesterfieldpapi333-beep/nicotine/releases/tag/v0.2.1
[0.2.0]: https://github.com/chesterfieldpapi333-beep/nicotine/releases/tag/v0.2.0
[0.1.0]: https://github.com/chesterfieldpapi333-beep/nicotine/releases/tag/v0.1.0
