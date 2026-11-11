# Plan de endurecimiento — nicotine

**Fecha:** 2026-11-11 · **Autor:** mantenedor · **Alcance aprobado:** SOLO endurecer `nic`
(sin portar `dlx`; features por decisión explícita) · **Release:** código público, sin
binarios publicados ni releases firmados (SHA-256/SBOM solo in-repo) · **Estilo:** comentarios mínimos y no cosméticos.

Este plan no promete «inexpugnable» ni «libre de errores»: ningún sistema lo es. Promete
propiedades verificables: perímetro más chico, menos privilegios, secretos que no se
fughan, comportamiento predecible ante entrada hostil y diagnósticos honestos.

## Alcance y no-objetivos

**En alcance**
- Seguridad razonable por diseño en el CLI, `serve`, tools, MCP, plugins.
- Robustez: parsers, sesiones, límites de recursos, fallos previsibles.
- Integridad del repositorio privado: build reproducible, sumas SHA-256, SBOM simple.
- Higiene humana: sin comentarios meta/generados, estilo consistente, sin telemetría.

**Fuera de alcance / backlog**
- `/fusion`: ELIMINADO del alcance (decisión explícita 2026-11-11). No se implementa.
- Memoria Obsidian (`vault_*`) + digest: IMPLEMENTADO (fase 11).
- Shim de tool-calling por texto (formatos múltiples + stats): IMPLEMENTADO (fase 11).
- Catálogo de modelos (`nic models`, badges, overrides): IMPLEMENTADO (fase 11). TUI `/models` muestra badges.
- Piezas de `dlx` portadas (descarga robusta, análisis estático): IMPLEMENTADO (fase 11d).
- Publicación de binarios firmados; publicación a npm/winget.

## Reglas de ejecución

1. Un commit por fase (o uno por ítem dentro de la fase si es grande); español en mensajes.
2. `bun x tsc --noEmit` + `bun test` verdes antes de cualquier commit.
3. Sin telemetría ni métricas fuera de la máquina. Sin credenciales reales en tests (mock).
4. Si una fase requiere decisión de producto, se para y se decide (nunca inventar).
5. Auditoría: nada de promesas en docs que el código no cumpla (paridad honesta).

## Fase H0 — Inventario y threat model (½ día)

Entregables
- `docs/threat-model.md`: activos (API keys, sesiones, código del usuario, procesos hijo,
  contexto del modelo), amenazas (escape de tool, secreto en `sessions/*.jsonl`, plugin
  malicioso, config hostile, `serve` expuesto, parser roto), controles y límites.
- `nic doctor --security` (subrutina de doctor): permisos 0600 de `auth.json`/`oauth.json`,
  presencia de secreto en archivos de datos (scan por patrones `sk-`, `gho_`, `ghp_`,
  `BEGIN ... PRIVATE KEY`, `AIza`), `umask`, `.git/config` sin credenciales, config de
  permisos cargada (deny-wins), `NICOTINE_SERVER_PASSWORD` establecida si serve habilitado.
  Exit 0 = limpio; exit 1 = hallazgos; salida JSON con `--json`.
- Tests: doctor --security con fixture aislada (XDG tmp): detecta permiso abierto, detecta
  secreto ficticio, falla limpio; no imprime el secreto (redactado `sk-***`).

Criterio de salida: documento + subcomando funcional + tests verdes.

## Fase H1 — Higiene de código (½–1 día)

Entregables
- Recorte de comentarios en `src/**` y `scripts/**`: se queda lo que expresa un invariante
  no derivable del código (p. ej. «deny siempre gana», razones de seguridad) o una
  migración con fecha/fase; se elimina todo lo demás (narrativa, encabezados obvios,
  duplicación de lo que dice el nombre).
- Encabezado mínimo por archivo: una línea de propósito si el módulo no es obvio; nada de
  firmas, tooling-generators ni comentarios «AI assistant».
- Estilo: `.editorconfig` + check en CI local (`scripts/check-style.ts`): líneas sin
  `TODO|XXX|FIXME|HACK|@generated|ChatGPT|Claude|Copilot|As an AI`. Salida ≠ 0 si hay
  violaciones.
- No se tocan cadenas traducibles visibles al usuario salvo correcciones claras.

Criterio de salida: repo pasa el checker; `rg` limpio; tests verdes.
Tensión aceptada: «cero comentarios» haría el security review imposible; se conserva un
puñado de invariantes (objetivo ≤ 2 por archivo donde aplique).

## Fase H2 — Integridad y build verificable (privado) (½ día)

Entregables
- `scripts/release.ts`: `bun install --frozen-lockfile`, typecheck, tests, `bun build
  --compile` (si viable) o empaquetado de fuentes, y escritura de `dist/SHA256SUMS`.
- SBOM simple generado desde `bun.lock`: `docs/sbom.md` o `dist/sbom.json` con nombre,
  versión, licencia, tipo (runtime/dev), sin dependencias transitivas no declaradas.
- Tag `v0.2.0` anotado con checksums referenciados; `git push --tags`.
- `.gitattributes` con `text eol=lf` para evitar churn por plataforma.
- Documento `docs/release.md`: cómo reproducir, cómo verificar los checksums.

Criterio de salida: repo =
- Nada publicado fuera; solo tags privados.

## Fase H3 — Política y modo solo-lectura (1 día)

Entregables
- Flag global `--readonly`: bloquea tools de escritura (write/edit/apply_patch), `bash`
  con efectos según heurística conservadora (>deny a menos en allowlist), y todo `serve`
  que ofrezca PATCH/DELETE; permite lectura, grep/glob, webfetch si la red está habilitada.
- `nic policy export|import <archivo.json>`: exporta reglas efectivas (capa fusionada,
  deny-wins) e importa sobrescribiendo capa `--config-dir`. Validación estricta; esquema
  documentado; ante conflicto, deny gana.
- `nic policy explain <ruta|comando>`: por qué se permite/deniega (traza best-effort).
- Tests: readonly bloquea write; allow no puede anular deny global; export→import idempotente.

## Fase H4 — Sandbox de tools y límites (1–2 días)

Entregables
- Entorno hijo limpio por defecto: `env -i`-equivalente para `bash` tool (allowlist
  `PATH`, `HOME`, `LANG`, locales; sin `*_KEY`, `*_TOKEN`, `*_SECRET` salvo que el usuario
  las permita explícitamente por config `tools.bash.envAllow`).
- `TMPDIR` aislado por sesión bajo `$XDG_RUNTIME_DIR` o `mkdtemp`, con límites:
  timeout duro ya existente; añadir tamaño máximo de salida (p. ej. 1 MiB, configurable),
  memoria opcional (`ulimit -v` best-effort en Linux/macOS).
- `webfetch`/`websearch`: sin proxies no solicitados; TLS verificado (rechaza `rejectUnauthorized:false`);
  timeouts y tamaños ya cubiertos — fijar valores por defecto documentados.
- Tests: env hijo no contiene `OPENAI_API_KEY` por defecto; salida > límite se corta con aviso;
  timeout mata el proceso.

## Fase H5 — Secretos (redacción y higiene) (1 día)

Entregables
- Módulo `src/core/redact.ts`: reemplaza por `***` (o `sk-***` con prefijo corto) patrones
  de clave conocida (`sk-`, `gho_`, `ghp_`, `github_pat_`, `AIza`, `Bearer `, `PRIVATE KEY`)
  y heurística de alta entropía para tokens ≥ 20 chars en logs, contexto de tools y
  salidas de `doctor --security`.
- Garantía: nada sensible se escribe en `sessions/*.jsonl` (test con fixture que intenta
  loguear una clave); `auth.json`, `oauth.json`, `approvals/` perms 0600 comprobados en doctor.
- `nic doctor` reporta `.config/nicotine` permisos (700) y avisa si abiertas.

## Fase H6 — Supply chain (½ día)

Entregables
- Presupuesto de dependencias: 1 runtime (`@opentui/core`, opt-out vía `--ui ansi`),
  `bun-types`/`typescript` dev-only; `bun.lock` con `--frozen-lockfile` obligatorio en tests.
- `scripts/check-supply.ts`: verifica `bun.lock` (no registry http, no git URLs no-pineadas,
  sin postinstall inesperados fuera de allowlist), flag si drift de deps nuevas.
- Documentación `docs/supply-chain.md`: política «deps cero preferidas», cómo agregar una
  (tests + revisión manual), rollback de emergencia (última buena tag).

## Fase H7 — Confiabilidad y fuzz mínimo (1 día)

Entregables
- Fuzz semilla de args: 10k entradas pseudoaleatorias contra parser (longitud acotada): no
  lanza excepciones no controladas; salida siempre exit 1/2 con uso de `nic --help`.
- Fuzz de JSONC/config: strings aleatorias + truncadas; loader nunca crashea (errores
  legibles, exit 2), incorporado a `bun test` con semilla fija.
- Sesión corrupta: líneas truncadas/ilegibles → recuperación con aviso (ya existe esquema;
  añadir tests y contador `--doctor`).
- Tool contracts: cada tool rechaza args fuera de esquema con mensaje accionable (auditoría
  dirigida de `bash`, `webfetch`, `websearch`, `write`, `edit`, `apply_patch`).

## Fase H8 — Audit log exportable (½ día)

Entregables
- `nic audit export <archivo>`: JSONL de eventos de autorización (allow-once/always/deny),
  permisos denegados, cambios de modelo, `serve` (sin contenido del prompt ni secretos),
  más metadatos (ts, cwd hasheado opcional con `--no-hash-cwd` apagado por defecto? →
  decidir en implementación: hash por defecto, `--plain` para lectura humana).
- Rotación en disco: `$XDG_STATE_HOME/nicotine/audit.jsonl` (o bajo data-home si no hay
  STATE), límite de tamaño configurable, append-only.

## Fase H9 — Publicación de código (repo abierto, sin binarios) (½ día)

Entregables
- `docs/release.md` cerrado con guía de verificación desde el clone (sums SHA-256
  in-repo generadas por H2); tag `v0.2.0` en el repo; **sin** binarios, **sin** releases
  firmados, **sin** npm/winget; la publicación es el código fuente.
- `docs/parity.md` actualizado con sección «Endurecimiento (H0–H10)» y tabla de estados.
- `docs/informe-fases.md` con métricas antes/después (tests, deps, líneas de src).
- Checklist de verificación en README ausente: crear README mínimo si se decide (preguntar).

## Fase H10 — Verificación final y evidencia (½ día)

Entregables
- Suite completa + typecheck + doctor --security + smoke `nic --version`, `nic doctor`,
  `nic policy export|explain`, readonly en una fixture, redact en un fixture con clave.
- Informe `docs/verification-10f.md` (o equivalente) con: qué se verificó, qué queda sin
  verificar (mDNS real, Vercel live), límites conocidos.

## Orden sugerido y dependencias

H0 → H1 → H5 (redacción) → H3 (política) → H4 (sandbox) → H6 (supply) → H7 (fuzz) →
H2 (integridad) → H8 (audit) → H9 (release) → H10 (verificación).

Estimación gruesa: **6–8 jornadas de trabajo enfocado** si H4 resulta simple; si entra
`ulimit` portable o keyring, suma ½–1 jornadas cada uno.

## Preguntas que quedarán abiertas (decidir, no inventar)

- ¿`README.md` de raíz? (no existe hoy)
- ¿Punto de integración de SBOM si se prefiere formato SPDX/CycloneDX frente al propio?
- ¿`XDG_STATE_HOME` para audit log o bajo data-home?
- ¿Firma real (minisign/cosign) o solo SHA-256 para release privado?
