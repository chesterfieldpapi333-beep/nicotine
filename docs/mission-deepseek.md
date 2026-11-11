# Misión DeepSeek (2026-11-11) — adaptada y en curso

Brief original: «implementar el núcleo de seguridad (H0)» con 4 tareas. Adaptación honesta:
contrasta con lo YA hecho (ver `docs/plan-implementacion.md`, `docs/threat-model.md`).

| # | Tarea del brief | Estado real |
|---|---|---|
| H0 | «núcleo de seguridad» | ✅ ya hecho (2026-11-11, commit `d72c7eb`): `docs/threat-model.md`, `nic doctor --security`. SBOM y serve ya existen (el brief pedía NO hacerlos: ya están) |
| 1 | `getCanonicalPath` + `isPathBlocked` hardcoded | ✅ `src/security/paths.ts` (2026-11-11, `cdf4a34`): realpath/nearest-existing, symlink colgante → fail-closed, `~/.ssh|aws|gnupg` y cualquier `.git` bloqueados sin importar permisos. Integrado en `src/core/loop.ts` (pre-check de toda tool de ruta) |
| 2 | `sanitizeForTUI` (ANSI) | ✅ `src/security/sanitize.ts` (Q4): conserva SGR básico; elimina movimiento de cursor, borrado, OSC (incl. 52), DCS/SOS/PM/APC y controles C0/C1. Cableado en `src/ui/flat.ts`, `src/modes/tui.ts`, `src/ui/app.ts` y `src/ui/components.ts` |
| 3 | `analyzeBashCommand` + ask forzado | ✅ `src/tools/bash-parser.ts` (`cdf4a34`): destructivos directos (rm/dd/mkfs/chmod/chown/shred/fdisk/… con unwrap de sudo/env/nice), `curl|wget | sh|bash` (pipe), sustitución de red en shells (`bash -c "$(curl…)"`), redirecciones a rutas sensibles. ask forzado que **ignora allow**; «always» degrada a «once»; non-TTY rechaza |
| 4 | Wrapper bash + truncado + sanitize | Truncado en **50 KiB configurable** (`NICOTINE_MAX_TOOL_OUTPUT_BYTES`, máx. 4 MiB) — el brief pedía 100 KB rígidos: se mantuvo el configurable (mejor). Logs temporales en 0600. Sanitize ANSI: hecho en Q4 (`sanitizeForTUI`) |

**Limitaciones declaradas (honestidad):** heurística de primer nivel (no parser POSIX);
`cat script | sh` y `curl -o x && bash x` NO se detectan (local/secuencial, no pipe);
`rm`/`chmod` etc. fuerzan ask siempre (falso positivo esperado, es la spec); `--auto`
aprueba una vez (loud), nunca persiste; en non-TTY se rechaza solo.

**Reparto:** mantenedor hizo 1, 3 y la mitad de 4; Qwen hace 2+sanitize de 4 (Q4 en
`docs/qwen-tasks.md`). Nada de lo nuevo amplía permisos; deny-wins intacto.
