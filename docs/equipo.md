> **Nota de honesto naming (2026-11-11):** «Claude» en estos docs es el **nombre del rol del mantenedor** (el asistente que estructura y revisa), no una afirmación sobre qué modelo corre detrás en un momento dado — Arena.ai Agent Mode usa varios modelos (entre ellos familias Claude, ChatGPT, Gemini, Grok, Qwen y Kimi). La función es lo que importa: dirección, specs, revisión y release. Cuando quieras fijar un modelo en particular, se nombra el modelo explícitamente en la spec.

# Equipo — Claude + DeepSeek (nicotine)

Aprobado 2026-11-11 (dueño): **Claude estructura · DeepSeek implementa · Qwen ya cerró su cola · sin GLM ni Gemini**. El dueño supervisa; su palabra gana siempre.

| Rol | Modelo | Función | Mergea | Permisos/auth/vault |
|---|---|---|---|---|
| Dueño | humano | producto, releases, última palabra | — | es su repo |
| Mantenedor | Claude | dirección, diseño+specs, seguridad, revisión, merges, release | sí | sí (es su lane) |
| Implementador | DeepSeek | implementación según spec exacta + tests + resiliencia | no | no |

Detalle por capas: [`docs/equipo-capas.md`](./equipo-capas.md).

## Reglas que valen para DeepSeek (y para Qwen, históricamente)

1. Español en UI, commits y docs. Cero atribución/mención de IA. Commits imperativos cortos.
2. **El repo es la única memoria**: releé `docs/equipo.md`, `docs/equipo-capas.md`,
   `docs/mission-deepseek.md` y `docs/threat-model.md` al empezar.
3. `bun test` + `bun x tsc --noEmit` + `bun scripts/check-style.ts` verdes, o el PR no existe.
4. Jamás ampliar permisos, relajar `ask`, auto-aprobar, añadir dependencias, ni tocar
   `src/core/permissions.ts|policy.ts|redact.ts|audit.ts|auth.ts`, `src/security/*`,
   `src/tools/bash-parser.ts`, `src/core/loop.ts`, vault, credenciales, `.git/config`,
   releases, tags, push a master. Su rama: `worker/deepseek-<id>`.
5. Un PR por pieza. Ante ambigüedad o spec faltante: **parar y preguntar en el PR**.
6. Sin APIs inventadas: `grep`/`ls` verifican después de buscar, nunca antes de afirmar.
7. Sin secretos en el chat ni el repo. Nada de `auth.json`/`oauth.json`/`.env`/tokens.
8. Sin telemetría, sin red saliente en tests (mocks), sin `eval`.
9. Invariantes innegociables: deny-wins y fail-closed. Todo desconocido → ask/deny.
10. Reporte obligatorio en el PR (formato abajo).

## Formato de reporte (obligatorio en todo PR)

```
Tarea: <id> — <una línea>
Tocado: <archivos>
NO tocado: <archivos explícitamente fuera>
Verificación: bun test (<passed> pass / <fail> fail, <n> skip) · tsc OK|FAIL · check-style OK|FAIL
Dudas/riesgos: <lista o «ninguno»>
```

**«Hecho»** = tests verdes + tsc limpio + check-style OK + reporte. Claude re-corre la suite
antes de mergear.

## Estado de la cola de Qwen (histórico, cerrada 2026-11-11)

Q1–Q4 mergeados (PR #2 `93ba8ce` + PR #3 `2ab5ba8`): discovery en `nic doctor`,
coherencia documental, tests de áreas flacas, `sanitizeForTUI` (`d31c05e`). Marcados ✅
en `docs/qwen-tasks.md`. Qwen ya no está en el equipo activo.
