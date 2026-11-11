# Cola de tareas para Qwen Coder

Mantenedor y dueño agregan aquí las tareas. Qwen toma **una** (la primera `libre`),
marca `en-curso (qwen/<rama>)` en su PR y la mantenedora actualiza a `✅ (merge <hash>)` al mergear.
Formato: ID · estado · spec breve · criterio de hecho. Detalle vivo en `docs/plan-implementacion.md`.

| ID | Estado | Tarea | Criterio de hecho |
|----|--------|-------|-------------------|
| Q1 | libre | **C5 Agent discovery** — `src/compat/discovery.ts` (scan PATH sin ejecutar; `nic doctor` sección «CLIs en PATH»; `--versions` opt-in con timeout 2s); tests con PATH falsa + falso CLI | `bun test` verde; sin ejecución por defecto |
| Q2 | libre | **Consistencia documental** — CHANGELOG bajo `## [0.2.0] — 2026-11-11`; `docs/parity.md` estados H0-H8/C2; `docs/informe-fases.md` métricas antes/después | solo docs; hashes reales de master |
| Q3 | libre | **Tests áreas flacas** — propuesta de alcance en PR (`src/core/undo.ts`, `src/compat/mdns.ts`, `src/core/compact.ts`); sin tocar src/ | tests verdes; bugs solo se reportan, no se arreglan |
| Q4+ | — | El mantenedor agrega chips aquí según avance (p. ej. más cobertura, notas de release) | — |

**Orden:** Q1 → Q2 → Q3. Un PR por tarea. Nada de mezclar tareas en un PR.
