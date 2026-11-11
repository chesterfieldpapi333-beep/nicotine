> **Estado: histórico.** La cola Q1–Q4 de Qwen se cerró y fusionó 2026-11-11 (PR #2/#3). Este archivo se conserva como contrato de referencia; no hay tareas activas.

# Handoff para Qwen Coder (agente de navegador) — nicotine

**Fecha:** 2026-11-11 · **Repo:** `github.com/chesterfieldpapi333-beep/nicotine` (público, código fuente, SIN binarios ni releases firmados).

## Qué es nicotine

CLI de agente de código *lite* (TypeScript sobre Bun, **cero deps de runtime** salvo `@opentui/core` opcional para la TUI). Compatible con `opencode.json(c)`; lee skills/MCP/plugins de Claude Code, Codex, Gemini CLI, OpenCode y Pi. Español en UI/docs/commits. Deny-wins y fail-closed en permisos. `serve` apagado por defecto. Sin telemetría. `/fusion` ELIMINADO del alcance (nunca se implementa).

## Reglas sin excepción (violarlas = rechazar el trabajo)

1. Español en UI, mensajes de commit y docs. **Sin atribución/co-authoría de IA** en commits.
2. `bun test` (384 verdes) y `bun x tsc --noEmit` y `bun scripts/check-style.ts` deben quedar verdes. Nunca commitees con tests rojos.
3. **Cero dependencias nuevas** (runtime o dev) sin decisión explícita del mantenedor. Pinning exacto + `bun.lock`.
4. Deny-wins y fail-closed; **no ampliar permisos** ni relajar reglas; no auto-aprobar asks.
5. NUNCA tocar: `src/core/permissions.ts`, `src/core/policy.ts`, `src/core/redact.ts`, `src/core/audit.ts`, `src/compat/obsidian-vault.ts`, `src/core/auth.ts`, `src/compat/mcp/oauth.ts`, `~/.config/gh/*`, `.git/config`, nada del vault Obsidian, credenciales, tokens, ni archivos del usuario.
6. Sin telemetría ni llamadas de red salientes en código nuevo (tests con mocks, fetch falso).
7. No releases, no tags, no pushes a `master`, no `git push --force`. Trabajás en ramas `qwen/<tarea>` y abrís PR (o dejás commits en la rama) para revisión del mantenedor. Ningún paso que requiera credenciales tuyas en repo.
8. Cambios defensivos sí; cambios de comportamiento fuera de tu tarea, no. Ante duda: **parar y preguntar** en el PR (no inventar decisiones de producto).
9. Paridad honesta: si el código no cumple lo que dice un doc, se corrige el doc, no se finge que se cumple.
10. Secretos NUNCA en el chat con vos (ni reales ni pegar auth.json/oauth.json/.env). El repo es público: asumí que todo lo que pegues lo lee cualquiera.

## Setup en tu máquina

```bash
git clone https://github.com/chesterfieldpapi333-beep/nicotine.git
cd nicotine
bun install --frozen-lockfile
bun test                     # esperado: 384 tests, 0 fail, 1 skip
bun x tsc --noEmit
bun scripts/check-style.ts
git checkout -b qwen/<tarea>
```

## Estado actual (para orientarte)

- Fases 0–11 publicadas (`387ade4`). H0–H8, H1, H2, H5, H6, H7 implementados y pusheados; C2 (refusal-failover) hecho.
- Pendiente mantener: `docs/plan-implementacion.md`, `docs/parity.md`, `CHANGELOG.md`, `docs/informe-fases.md`.
- [Cerrado el mismo día] C3 (`5094bf1`), C6 (`f141fbe`), H9 (release in-repo, tag `v0.2.1`), H10 (`docs/verification-10f.md`) — todos construidos y fusionados; Qwen quedó sin pendientes (Q1–Q4 ✅). Sigue pendiente de la máquina del usuario: Track D/E.
- Regla de la casa: cada cambio lleva sus docs y tests juntos; un commit por tarea (español, imperativo corto).

## Tareas asignadas (en orden)

### Q1 — C5 Agent discovery (tu primera tarea; cerrar con PR)
Herramienta **solo informativa** para `nic doctor`:
- Nuevo módulo `src/compat/discovery.ts`: escanea `PATH` y detecta si existen en disco: `git gh codex claude gemini opencode pi aider bun node python3 rg jq curl docker ollama`. **No ejecuta nada** al escanear (solo `existsSync`/acceso +x).
- `nic doctor` gana una sección «CLIs en PATH»: lista encontradas con su ruta. **Sin flag `--versions` no se ejecuta nada.**
- Con `nic doctor --versions`: ejecuta `--version` con timeout 2 s, captura solo la primera línea (máx 120 chars, sin secretos), muestra versión; si falla, «versión no disponible».
- Tests `tests/discovery.test.ts` (tmpdir como PATH falsa; incluye un falso CLI shell script con `--version`; caso no encontrado; timeout con un script que duerme 5 s).
- Aceptación: `bun test` verde, `tsc` limpio, doctor muestra la sección, `--versions` funciona.

### Q2 — Consistencia documental (tras Q1)
- `CHANGELOG.md`: mover lo de «[Sin publicar]» bajo una entrada coherente `## [0.2.0] — 2026-11-11` (añadiendo higiene/redacción/política/auditoría/fuzzing/etc. ya mergeados).
- `docs/parity.md`: actualizar estados de filas endurecidas (H0-H8, C2) con hashes de commit.
- `docs/informe-fases.md`: sección «Hardening» con las métricas antes/después (tests por fase: 344 → 384).
- Solo docs; cero src. PR independiente.

### Q3 — Tests de áreas flacas (tras Q2; proponer alcance en el PR)
Candidatos (uno por PR): `src/core/undo.ts`, `src/compat/mdns.ts`, `src/core/compact.ts`. Estilo existente de `tests/`. Sin tocar `src/` (si encontrás un bug real: describirlo en el PR, no arreglarlo silenciosamente).

## Fuera de alcance (mantenedor o usuario)
C3, C6, H9, H10, todo `src/core/permissions.ts|policy.ts|redact.ts|audit.ts`, vault, auth, releases/tags/pushes a master, Track D (medición tokens) y E (vault Windows).

## Flujo con el mantenedor
Rama desde `master` actualizado → PR con resumen (qué/por qué/cómo verificaste) → el mantenedor revisa, corre `bun test` y mergea. Si Qwen tiene duda de producto: preguntar en el PR. Si rompe algo: revertir tu rama y empezar de nuevo.
