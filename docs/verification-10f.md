# Verificación final — hardening H0–H10 (nicotine v0.2.0)

Fecha: 2026-11-11 · Commit verificado: `a30fd7e` (master) · Tag: `v0.2.0` = `2c377d7`

## Qué se verificó (con evidencia)

| Ítem | Comando / criterio | Resultado |
|---|---|---|
| Suite completa | `bun test` | 408 pass / 0 fail / 1 skip · 47 archivos · ~36 814 expects |
| Typecheck | `bun x tsc --noEmit` | limpio |
| Estilo | `bun scripts/check-style.ts` | OK (LF, sin trailing, newline final) |
| Smoke versión | `./bin/nic --version` | `nicotine 0.2.0` |
| Doctor | `./bin/nic doctor` | OK (config defaults; serve apagado; auth 0 proveedores) |
| Doctor seguridad | `./bin/nic doctor --security` | exit 0 · 0 hallazgos (umask 0022; sin secretos en sesiones/config; deny-wins sonda OK) |
| Policy export | `./bin/nic policy export` | 8 reglas + sources; serialización JSON correcta |
| Policy explain readonly | `./bin/nic policy explain bash "rm -rf …" --readonly` | **deny** por `cli:--readonly` |
| Fixture readonly fuera del proyecto | `./bin/nic policy explain edit /tmp/… --readonly` (cwd=nicotine) | **deny** por `edit *` [cli:--readonly] — ver «Hallazgo corregido» |
| Sumas in-repo | `sha256sum -c release/SHA256SUMS` | 183/183 OK (a30fd7e) |
| SBOM | `release/SBOM.json` desde bun.lock | 42 paquetes fijados |
| Reproducibilidad | `./scripts/verify-release.sh` (clone limpio) | verde; regenera sums/SBOM in-repo |
| Rutas sensibles | `tests/security-paths.test.ts` | `~/.ssh`, `.git` bloqueados hard, fail-closed |
| Bash destructivo | `tests/bash-parser.test.ts` | rm/dd/mkfs/chmod/chown/shred/{curl\|wget}\|sh, sustitución → ask forzado |
| Redacción | `tests/redact.test.ts` | sesiones JSONL sin secretos persistidos |
| Audit log | `tests/audit.test.ts` | JSONL rotado; `nic audit export` |

## Hallazgo corregido en la verificación (H10 sirvió)

`--readonly` + objetivo **fuera del proyecto** caía en `external_directory → ask` en vez de
`edit * → deny`: `checkPath` short-circuiteaba la compuerta externa y nunca miraba la
regla de la acción. Corregido en `a30fd7e`: deny gana entre ambas compuertas
(`external_directory` y acción); tests agregados (4 casos). **Resuelto:** dueño optó por (b):
`v0.2.1` (`0c9408c`) lleva el fix; `v0.2.0` se conserva como historia.

## Qué queda sin verificar (explícito)

> [Addendum 2026-11-11, mismo día] Los PRs de Qwen aterrizaron en `master` durante esta
> verificación (PR #2 `93ba8ce`, PR #3 `2ab5ba8`; suite 408 → 471 pass, 1 skip): discovery
> de CLIs, docs de coherencia, tests de áreas flacas y `sanitizeForTUI`. Los ítems que el
> informe original marcaba como pendientes por Qwen ya no lo son; las demás secciones
> se conservan como registro histórico.

- **mDNS / serve en vivo**: no se anunció ningún servicio real en esta máquina; solo paths de código y tests.
- **Vercel / proveedores reales**: refusal-failover (C2) solo con mocks; sin tráfico a openai/anthropic reales.
- **`curl -o x && bash x`**, `cat s | sh`: fuera del alcance del analizador bash (heurística de primer nivel, documentado en `docs/mission-deepseek.md`).
- **`bun pm audit`**: no existe en bun 1.4.4 — sin auditoría de CVE automática.
- **Firma de tags/commits**: ninguna; autenticidad = HTTPS a GitHub + SHA256SUMS + revisión de diff.
- **doctor --security** es heurística (umask, patrones, perms): reduce superficie, no certifica.
- **H10 no cubre Track D/E** (máquina del dueño: ccusage, context-mode, rtk, caveman).

## Límites conocidos consolidados

1. bash-parser: falso positivo esperado en `rm/chmod/chown` (fuerza ask siempre); falso negativo en pipe-a-shell local y encadenados no-red.
2. sanitizeForTUI (Q4): durante la verificación original estaba pendiente; mergeó el mismo día en `d31c05e`. Residual: `--json` no sanitiza (intencional). Ver addendum arriba.
3. Bloqueo de rutas: prefijos `~/.ssh|~/.aws|~/.gnupg` + cualquier `.git`; otras rutas por permisos normales.
4. `--auto` aprueba cualquier ask **una vez** (nunca persiste; deny intacto); en non-TTY, ask = reject.
5. `vba`/truncado: 50 KiB configurable (`NICOTINE_MAX_TOOL_OUTPUT_BYTES`, máx 4 MiB).

## Próximos pasos recomendados (no ejecutados)

- Tag `v0.2.1` desde `a30fd7e` (decisión del dueño; sustituye a v0.2.0 o lo acompaña).
- Track D/E (medición en tu máquina) y review de PRs de Qwen cuando lleguen.
- C3 estabilizado; C5 = Q1 (Qwen), C6 hecho.
