# Plan de implementación — nicotine

**Fecha:** 2026-11-08 · **Autor:** mantenedor · **Repo:** público (desde 2026-11-11) ·
**Versión:** 0.1.0 · **Estado del código al escribir este plan:** fase 11 publicada
(`387ade4` en `origin/master`) + 2 commits locales (`c714a2d`, `4e627b4`) sin push.

Este documento **no promete** «inexpugnable» ni «libre de errores»; promete propiedades
verificables. Es complementario a `plan-hardening.md` (H0–H10) y `linaje.md` (wishlist
de la research); acá se unifica todo, se expande y se ordena. Si este plan y el código
discrepan, **gana el código** (paridad honesta).

**Reglas permanentes (de toda la vida del proyecto):** nomenclatura `nicotine`/`nic`
(+ shim `vireo` deprecado); español en UI, mensajes de commit y docs; cero dependencias
en el núcleo; deny-wins y fail-closed; `serve` apagado por defecto; sin telemetría; sin
atribución de IA; docs y tests viajan con el código; `/fusion` ELIMINADO (no se
implementa); SHA-256/SBOM solo como salidas documentadas del repo (sin binarios
publicados, sin releases firmados); correcciones de seguridad solo defensivas.

**Lección operativa (2026-11-08):** el entorno de trabajo puede revertir archivos a
snapshots anteriores (perdió historial git local dos veces; `node_modules` y bits de
ejecución se borran). Mitigación obligatoria: **push después de cada commit** y
verificación (`git status` limpio + fetch anónimo) antes de dar por cerrado un bloque.

## 1. Estado verificado (hoy)

| Pieza | Estado |
|---|---|
| Repo público (`master`) | ✅ `origin/master` = `cea7ade4` (fase 11) |
| Suite de tests | ✅ 344 tests (1 skip: live vercel-ai), `tsc` limpio |
| `README.md` / `LICENSE` / `.github` | ❌ **no existen** |
| H0–H10 (hardening) | ❌ nada implementado (sin `threat-model.md`, `doctor --security`, redacción, política, sandbox, audit log, fuzzing, SBOM) |
| linaje.md wishlist | ❌ nada implementado (refusal-failover, action stream, repo map, discovery, single-file, watch mode) |
| Push de `c714a2d` + `4e627b4` | ⏳ autorizado pendiente |
| `docs/plan-hardening.md` | etapa H0–H10 descrita a nivel boceto; dice «repo privado» (obsoleto: ahora público) |
| Medición de tokens | ❌ sin baseline (research hecha; herramientas sin instalar) |
| Reestructura del vault | ⏳ script entregado; lo ejecuta el usuario en Windows |

## 2. Track A — Cierre de publicación

| ID | Entrega | Detalle | Esfuerzo |
|---|---|---|---|
| A1 | Push | `git push origin master` (`c714a2d`, `4e627b4`) + fetch anónimo de verificación | minutos |
| A2 | Docs coherentes | `plan-hardening.md`: «repo privado» → «código público, sin binarios»; H9 reescrito (SHA256SUMS in-repo, sin releases firmados, sin npm/winget) | 30 min |
| A3 | `README.md` | Español: qué es, instalación (`bun install`, `./bin/nic`), config mínima (provider), comandos (`doctor`, `models`, `vault_*`), seguridad en 4 bullets (deny-wins, no telemetría, fail-closed, serve off), limitaciones honestas, licencia | 1–2 h |
| A4 | `LICENSE` | **Decisión D2** (ver §8). Sin licencia el repo público es «all rights reserved» por defecto | minutos + decisión |
| A5 | `CHANGELOG.md` | Sembrar desde `docs/informe-fases.md` (fases 0–11, una línea por fase); versionar: fase 11 → `0.2.0` | 30 min |

Criterio de salida A: repo público con README + LICENSE + CHANGELOG; `bun install && bun test` verde desde un clon limpio; `nic --help`, `nic doctor`, `nic models` funcionan con un provider mock.

## 3. Track B — Hardening H0–H10 (expandido)

Orden obligado (dependencias reales). Cada ítem = 1 commit (o varios por ítem si es grande); `tsc` + `bun test` antes de cada commit; push al terminar cada H.

### H0 — Threat model + `nic doctor --security` (½–1 día)
- `docs/threat-model.md`: activos (API keys en `auth.json`/keychain, sesiones JSONL, código del usuario, contexto→proveedor), amenazas (tool escape, secreto en sesión/logs, plugin malicioso, config hostil, `serve` expuesto, parser roto), controles y **límites** (qué NO protege: malware en la máquina, modelo malicioso vía prompt injection — mitigación parcial por redacción y permisos).
- `nic doctor --security`: permisos 0600 de `auth.json`/`oauth.json`; scan de secretos en `sessions/`, `config`, datos de usuario (patrones `sk-`, `gho_`, `ghp_`, `github_pat_`, `AIza`, `BEGIN ... PRIVATE KEY`, `xox`); `umask`; deny-wins efectivo; password de serve si habilitado; **nunca imprime el secreto** (redacta `sk-***`). Exit 0/1 + `--json`.
- Tests con XDG aislado (tmp): detecta permiso abierto y secreto ficticio; salida redactada.

### H1 — Higiene (½ día)
- Barrido final de comentarios no derivables (los que quedan), consistencia de estilo, `.gitattributes` (LF), chequeo de archivos grandes (`vault_dump_completo.md` NO en repo; ya ignorado).

### H2 — Suministro (1 día)
- Script `scripts/verify-release.sh`: build reproducible desde clon limpio (`bun install --frozen-lockfile`), `SHA256SUMS` del tree (excluye `node_modules`, `.git`), `SBOM` simple (lista de deps pinadas de `bun.lock` + hashes). Salidas **in-repo** bajo `release/` documentado; sin binarios; no publicar.

### H3 — Política: `--readonly` + `nic policy export|import|explain` (1–2 días)
- `--readonly`: override global de todas las tools de escritura a deny (fallo cerrado, deny-wins).
- `nic policy export|import|explain <rule>`: muestra reglas efectivas (origen: defaults, config, CLI); `explain` responde «por qué se denegó/permitieron este action+resource».
- Archivo de política: JSON/JSONC versionado, mismo modelo `{action, resource, effect}` de opencode v2; carga ordenada defaults→config→CLI (última gana); **deny-wins**.
- Tests: carga, precedencia, `--readonly` bloquea write/edit/apply_patch/vault_write/bash ambiguo, export/import ida-vuelta.

### H4 — Sandbox y límites (1–2 días)
- Límites duros para `bash` hijos: timeout configurable (ya parcial), salida ≤ N bytes (trunca con aviso), sin red para comandos con `--offline` (o default?), guard de symlinks en writes fuera de cwd (preguntar), `NICOTINE_MAX_TOOL_OUTPUT_BYTES`.
- `serve` sigue OFF por defecto; si se habilita sin password → error claro. Documentar.

### H5 — Redacción de secretos en tránsito (1 día)
- `redactSecrets(text)` reutilizado: tool outputs, logs, sesiones JSONL (import), doctor report, `audit export`. Tests con `gho_`/`sk-`/`AIza` ficticios. Integrar con H0.

### H6 — Dependencias (½ día)
- `bun.lock` verificado en CI-local (script `scripts/verify-release.sh` lo usa); revisión manual de las 16 deps (ya mínimas); `bun outdated` documentado; sin `postinstall` ejecutables sin revisar.

### H7 — Fuzzing ligero (1–2 días)
- Targets: `text-tool-calls` (parser de 6 formatos), `yaml-lite`, `toml-lite`, `jsonl` de sesiones, `analyze` magic bytes, `safeJoin` (zip-slip/`..`), frontmatter de skills.
- Propiedad: nunca panic/throw sin control; máximo 1 s por iteración; corpus semilla en `tests/fuzz/`; `bun test tests/fuzz.test.ts` con N iteraciones fijas.

### H8 — Audit log (1 día)
- `NICOTINE_AUDIT=1` (o config `audit.enabled`): append JSONL en `dataHome()/audit.jsonl` con ts/acción/recurso/efecto; rotación por tamaño; **redacción H5**; `nic audit export [--since] [--json]`.
- Sin telemetría: solo local; documentado en `doctor`.

### H9 — Publicación de código (repo abierto, sin binarios) (½ día)
- SHA-256/SBOM verificables **in-repo** (`release/SHA256SUMS`) generados por H2; README con verificación (`git clone` + sumas); **no** binarios, **no** firmas, **no** releases, **no** npm/winget.

### H10 — Informe final (½ día)
- `docs/informe-hardening.md`: amenazas cubiertas/descubiertas, límites explícitos, lista de qué falta (H4 parcial? red team?), actualización de `informe-fases.md` y `parity.md`, y decisión H9 confirmada.

**Esfuerzo Track B: ~7–10 días-persona.**

## 4. Track C — Features de la research (linaje)

Decisión previa (ya tomada): solo lo honesto y medible. Ordenado por valor/coste.

| ID | Feature | Detalle | Esfuerzo |
|---|---|---|---|
| C2 | **Refusal-failover** | Ante patrón de rechazo del proveedor (lista conservadora + umbral de confianza), reintenta con el siguiente proveedor configurado en `fallbackModels`; opt-in (`compat.refusal_failover: true`); **sin** contenido de bypass, sin prompts de evasión; solo routing. Tests con mocks: 3 proveedores, 2º responde rechazo → 3º responde ok | 1–2 días |
| C3 | **Semantic action stream** | TUI: etiqueta de fase en footer («analizando…», «editando …», «ejecutando comando…») derivada de tool_start (read/write/bash/search); reemplaza ruido, no oculta info; toggle `ui.action_stream` | ½–1 día |
| C5 | **Agent discovery** (solo lectura informativa) | `nic doctor` / `nic models`: detecta CLIs en PATH (git, gh, codex, claude, opencode, pi, aider…) y las lista con versión si responde a `--version`; nunca ejecuta nada sin pedirlo | ½ día |
| C6 | **Single-file / bash-only mode** | `--solo-bash`: expone SOLO la tool `bash` + tools de solo-lectura (read/glob/grep/webfetch); perfil «minimal» estilo markov/mini-swe-agent; tests: solo se envían esas tools al provider | ½ día |

**No se hacen (por coste/valor o diseño):** C4 repo map (AST/regex parcial aporta poco), C7 disposable tools (registro dinámico amplía superficie), C8 WASM profiles (fuera de lite), watch mode (nicho), refusal-failover «por contenido censurado» (elusión: no), sub-agentes anidados, `/fusion` (eliminado).

## 5. Track D — Programa de tokens (medición primero)

| ID | Entrega |
|---|---|
| D1 | Baseline en tu máquina: `npx ccusage@latest` (Codex/OpenCode/Claude según logs disponibles) durante 3–7 días; anotar tokens/sesión por modelo |
| D2 | `npm i -g context-mode && context-mode setup` (OpenCode/Hermes); medir 1 semana; esperar −20…−98% **en contexto**, no necesariamente en factura |
| D3 | `rtk` (proxy CLI) para logs ruidosos (git/tests/kubectl); 0–90% según comando |
| D4 | (Opcional) `caveman` si tolerás salida terso (−38% output según medición independiente) |
| D5 | Script semanal (tu vault `04-Plantillas/`): suma `tokens:` del frontmatter por semana y top-5 sesiones; sin dependencias nuevas |
| D6 | nicotine: nada nuevo ahora (los caps existen: 32 KiB vault_read, 512 KiB búsqueda, 50 hits); revisar en H4/H5 los demás tools |

**Regla:** instalar uno, medir, después el siguiente. Nada entra al repo de nicotine sin pasar por decisión explícita.

## 6. Track E — Vault y Drive (tu Windows)

- E1: correr `hermes-restructure.ps1 -Apply` (mueve Sesiones Hermes/Bitácora a `02-Sesiones/`).
- E2: borrar `vault_dump_completo.md` (9,8 MB redundante) o excluirlo del zip de Drive; regenerar el zip de respaldo.
- E3: decidir el `sk-…` filtrado (rotar o ignorarlo — tu decisión explícita; este repo y sus tools ya lo bloquean).
- E4: revisar que `extraer-sesiones-hermes.py` (en `04-Plantillas/`) siga apuntando a `02-Sesiones/` tras E1 (el script ya fue actualizado en la copia reestructurada).

## 7. Orden de ejecución recomendado

| Semana | Bloques |
|---|---|
| 1 | **A** (push, docs coherentes, README, LICENSE, CHANGELOG) + **D1/D2** (medición en paralelo, no bloquea código) |
| 2 | **H0 → H1 → H5** (threat model, higiene, redacción) |
| 3 | **H3 → H4** (política, readonly, sandbox/límites) |
| 4 | **H2 → H6 → H7** (SBOM, deps, fuzzing) |
| 5 | **H8 → H9 → H10** (audit, publicación, informe) |
| 6 | **Track C** (C2 → C3 → C5 → C6) según decisiones §8 |

Dependencias duras: A1 antes de cualquier release/etiquetado; H5 antes de H8; H2 antes de H9; H0 antes de H3 (la política se diseña desde las amenazas).

## 8. Decisiones que necesito de vos

- **D1 (push):** ¿autorizo el push de `c714a2d` + `4e627b4` con gh, o lo hacés vos?
- **D2 (licencia):** ¿MIT / Apache-2.0 / sin LICENSE («all rights reserved»)?
- **D3 (arranque):** ¿arranco Track A y H0 ahora mismo en esta sesión?
- **D4 (Track C):** ¿qué ítems querés? (C2 refusal-failover / C3 action stream / C5 discovery / C6 solo-bash — cada uno con opt-in y tests)
- **D5 (publicación):** ¿confirmás «código público, sin binarios ni releases firmados» y SHA256SUMS/SBOM in-repo como únicas salidas?

## 9. Criterios de salida globales

1. `git clone` limpio + `bun install --frozen-lockfile` + `bun test` → verde (344+ tests, con los nuevos de H0/H3/H5/H7/C*).
2. `nic doctor --security` detecta fixtures y no imprime secretos; exit codes honestos.
3. `--readonly` y deny-wins verificados por tests adversariales.
4. README + LICENSE + CHANGELOG presentes; `parity.md`/`informe-fases.md` reflejan el estado real.
5. Cero credenciales en repo y en artefactos generados (H0/H5/H2).
6. Nada de esta superficie se distribuye como binario.
