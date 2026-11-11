# Equipo multi-modelo — quién hace qué en nicotine

> **Versión por capas:** para el reparto por responsabilidades (L0–L7: dirección → diseño → implementación → fallos → tests → adversarial → release) ver [`docs/equipo-capas.md`](./equipo-capas.md).

Pipeline aprobado 2026-11-11 (dueño): **Claude estructura · DeepSeek y GLM programan ·
Gemini analiza · Qwen implementa su cola**. El dueño supervisa; la palabra final del dueño
gana siempre. El repo es la **única memoria compartida** de todos los modelos.

| Rol | Modelo | Función | Puede mergear | Puede tocar permisos/auth/vault |
|---|---|---|---|---|
| Dueño | humano | Decisiones de producto, release, última palabra | — | — (es su repo) |
| Mantenedor | Claude (asistente) | Arquitectura, specs, seguridad (YN), revisión de PRs, merge/rechazo, integridad del repo | sí | sí (es su lane) |
| Implementador | DeepSeek | Código según spec exacta + tests | no | no |
| Implementador | GLM | Código/docs/tests según spec exacta | no | no |
| Implementador | Qwen Coder | Cola Q1→Q4 (`docs/qwen-tasks.md`) | no | no |
| Analista | Gemini | Reviews, auditorías, amenaza/código cruzado; **reporta, no cambia** | no | no; solo lectura y docs/audits |

## Reglas que valen para TODOS los modelos (leer antes de actuar)

1. Español en UI, commits y docs. Cero atribución/mención de IA. Commits imperativos cortos.
2. **El repo es tu única memoria**: releé `docs/handoff-qwen.md`, `docs/equipo.md`,
   `docs/plan-implementacion.md`, `docs/mission-deepseek.md` y `docs/threat-model.md` al empezar.
3. `bun test` + `bun x tsc --noEmit` + `bun scripts/check-style.ts` verdes, o el PR no existe.
4. **Jamás** ampliar permisos, relajar `ask`, auto-aprobar, añadir dependencias, tocar
   `src/core/permissions.ts|policy.ts|redact.ts|audit.ts|auth.ts`, `src/security/*`,
   `src/tools/bash-parser.ts`, vault, credenciales, `.git/config`, releases, tags, pushes a master.
   (Menos: Gemini y los programadores trabajan en ramas `worker/<modelo>-<id>`; solo el mantenedor mergea.)
5. **Un PR por tarea.** Alcance exacto de la spec. Ante ambigüedad: **parar y preguntar en el PR**.
6. Sin APIs inventadas: verificás con `grep`/`ls`; nada de memoria de entrenamiento como fuente de verdad del código.
7. Nada de secretos en el chat ni en el repo (aunque el repo es público). Nunca se pega `auth.json`,
   `oauth.json`, `.env`, tokens, URLs con credenciales ni contenido del vault.
8. Sin telemetría, sin red saliente en código de tests (mocks/fetch falso), sin `eval`.
9. Deny-wins y fail-closed son invariantes: cualquier cambio que los debilite se rechaza.
10. Formato de reporte obligatorio en el PR (abajo).

## Formato de reporte (obligatorio en todo PR)

```
Tarea: <id> — <una línea>
Tocado: <archivos>
NO tocado: <archivos explícitamente fuera>
Verificación: bun test (<passed> pass / <fail> fail) · tsc OK|FAIL · check-style OK|FAIL
Dudas/riesgos: <lista o «ninguno»>
```

**«Hecho»** = tests verdes + tsc limpio + check-style OK + reporte del PR. El mantenedor
re-corre la suite antes de mergear; «me parece que funciona» no es hecho.

## Cola de tareas por modelo (2026-11-11)

### DeepSeek — implementador
- **D1 (propuesta, pendiente aprobación del dueño)**: ampliar `tests/bash-parser.test.ts`
  con casos adversariales: heredocs, comillas anidadas mixtas, unicode/emoji en comandos,
  `rm -rf` con `--no-preserve-root`, encadenados con `&&`/`;`/`||` multisegmento, tabs.
  Solo tests; NO tocar `src/tools/bash-parser.ts` (si un caso falla → reportar en el PR, no arreglar).
- En espera hasta que aterricen los PRs de Qwen (Q1–Q4) para integrar sin conflictos.

### GLM — implementador
- **G1 (propuesta)**: ampliar `README.md` con una sección «Instalación verificada (paso a
  paso)» y una FAQ breve para usuarios nuevos (permisos y `ask`, `--readonly`, `--solo-bash`,
  por qué no hay binarios). Solo toca `README.md` + `docs/`; nada de `src/`.

### Gemini — analista (solo lectura + `docs/audits/`)
- **A1 (aprobada para análisis)**: revisión cruzada threat-model → código (`docs/threat-model.md`
  T1–T11 vs implementación real): cada mitigación listada, ¿existe y dónde? ¿hay gap doc↔código?
  Entrega: `docs/audits/gemini-threat-model.md` con severidad (crítico/alto/medio/bajo/info),
  evidencia (path:line) y recomendación. NO toca `src/`.
- **A2 (tras que aterrice el PR de Qwen Q4)**: revisar `src/security/sanitize.ts` y los
  puntos de impresión (`flat.ts`, `tui.ts`): ¿queda algún camino de print sin sanitizar?
  Entrega: `docs/audits/gemini-sanitize.md`.

## Cómo se arbitra un conflicto entre modelos

El mantenedor (Claude) propone; Gemini señala; el dueño decide. Si un worker y un análisis
chocan, gana el invariante de seguridad (deny-wins/fail-closed) hasta que el dueño diga lo contrario.

## Notas de coordinación con la cola de Qwen

Qwen mantiene su cola en `docs/qwen-tasks.md` (Q1→Q4). DeepSeek y GLM **no** toman esas
tareas ni las "ayudan" con PRs paralelos. Si DeepSeek/GLM detectan un bug en lo que
Qwen está implementando: reporte en su propio PR, sin tocar los archivos de Qwen.
