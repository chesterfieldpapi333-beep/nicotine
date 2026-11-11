> **Nota de honesto naming (2026-11-11):** «Claude» en estos docs es el **nombre del rol del mantenedor** (el asistente que estructura y revisa), no una afirmación sobre qué modelo corre detrás en un momento dado — Arena.ai Agent Mode usa varios modelos (entre ellos familias Claude, ChatGPT, Gemini, Grok, Qwen y Kimi). La función es lo que importa: dirección, specs, revisión y release. Cuando quieras fijar un modelo en particular, se nombra el modelo explícitamente en la spec.

# Equipo por CAPAS — Claude + DeepSeek (nicotine)

Aprobado 2026-11-11 (dueño). Equipo activo: **Claude + DeepSeek** (Qwen cerró su cola;
sin GLM ni Gemini). El repo es la única memoria de ambos.

**Idea central**: el trabajo entra por la capa alta necesaria, baja a implementación,
sube para verificación y cierra con merge. Nadie salta capas.

```
Dueño (humano) — decide todo lo irreversible
  L0 · Claude — dirección, arquitectura, seguridad, merges, releases
  L1 · Claude — diseño técnico + auto-contra-revisión (antes de código)
  L2 · DeepSeek — implementación de núcleo (parsers, IO, tipos)
  L3 · Claude — docs y consistencia (redacta o aprueba con datos verificados)
  L4 · DeepSeek — fallos, errores, resiliencia, non-TTY, degradación
  L5 · DeepSeek — tests y matriz (normales, borde, adversariales/fuzz)
  L6 · Claude — revisión adversarial con suite + threat-model (no hay analista aparte)
  L7 · Claude — release e integridad (sumas, SBOM, tags)
```

## Las capas, una por una

### L0 — Dirección y decisiones (Claude, con el dueño)
Alcance, invariantes de seguridad, permisos, auth, vault, `src/security/*`,
`bash-parser`, `loop.ts`, `checkPath`, tags, releases, merges a master.
**DeepSeek nunca toca esto.** Decisión gris → dueño.

### L1 — Diseño y coherencia (Claude)
Toda pieza no trivial empieza con spec en `docs/design/<tema>.md`: problema, no-objetivos,
interfaz, invariantes, archivos que toca/no toca, tests esperados, riesgo residual.
Contra-revisión la hace Claude contra `docs/`, amenazas T1–T11 y estados de parity
(pensar como el analista ausente): si la spec no sobrevive a la pregunta adversarial,
no sale a L2. Seed del OK: el dueño puede vetar cualquier spec antes de implementar.

### L2 — Implementación de núcleo (DeepSeek)
Parsers, IO acotado, estructuras, algoritmos correctos, TypeScript strict sin `any`,
cero deps nuevas, límites (bytes, tiempo) explícitos. No decide diseño: spec mal o
ambigua → **para y pregunta**.

### L3 — Documentación y consistencia (Claude)
README, `docs/*`, CHANGELOG, parity, verificación hash↔`git log` de master. Claude
redacta; si una pieza acotada y verificable se puede delegar a DeepSeek como task L2
específico, se hace con spec exacta y revisión posterior. Toda afirmación matchea el
código real. Nada de marketing.

### L4 — Fallos, errores y resiliencia (DeepSeek)
Caminos de error explícitos: mensaje accionable, nunca hang, nunca silencio OK.
Reglas: sin TTY pide → rechazo; non-UTF8 → error claro; red timeout → error sin
corromper estado; `AbortSignal` siempre honrado; desconocido → ask/deny, jamás allow.
Si un `catch` se traga el error sin log/audit: reportar como bug en el PR, no parchear
en silencio.

### L5 — Tests y matriz de casos (DeepSeek)
Matriz por módulo: normales, borde, adversariales (fuzz determinista), deny-wins (los
permisos nunca se rompen), integración de loop. Un test por función pública cuando la
spec lo diga. Fallos detectados → reportados en el PR, no arreglados ahí (eso va a L2
con spec).

### L6 — Revisión adversarial (Claude)
Sin analista dedicado: Claude hace la revisión con la suite, el threat-model, los
patrones de ataque conocidos (inyección, ANSI/OSC, traversado de rutas, bypass de ask)
y checklist de deny-wins. Severidad crítico|alto|medio|bajo|info anotada en el reporte
del merge (o del PR si el rechazo amerita detalle).

### L7 — Release e integridad (Claude, solo)
`scripts/verify-release.sh`, `release/SHA256SUMS` + `SBOM.json` in-repo, tags, notas,
push. Nunca delegado.

## Matriz superficie × capas

| Superficie | L0 | L1 | L2 | L3 | L4 | L5 | L6 | L7 |
|---|---|---|---|---|---|---|---|---|
| `src/core/permissions.ts`, `auth.ts`, `policy.ts`, `redact.ts`, `audit.ts` | ✏️ | review | — | — | — | tests OK | review | tag |
| `src/security/*`, `src/tools/bash-parser.ts` | ✏️ | review | — | — | bugs reportados | adversariales | review | tag |
| `src/core/loop.ts`, `shell-scan.ts` | ✏️/spec | review | spec aprobada | — | errores | integración | review | tag |
| `src/core/provider*.ts`, `config.ts` | ✏️ | spec | spec aprobada | — | red timeouts | mocks | review | tag |
| `src/tools/*` (resto), `src/compat/*` | spec | review | spec aprobada | docs | errores | matriz | review | tag |
| `src/ui/*`, `src/modes/*` | spec | review | spec aprobada | docs | non-TTY | buffer | review | tag |
| `docs/*`, `README.md` | review | lectura | — | ✏️ | — | — | — | tag |
| `release/`, tags, push | ✏️ | — | — | — | — | — | — | ✏️ |
| `docs/design`, `docs/audits` | lectura/✏️ | ✏️ | lectura | lectura | — | — | ✏️ | tag |

✏️ = edita · review = comenta/aprueba · — = no toca

## Flujo estándar de una pieza

1. Dueño/Claude abre el item (plan, cola o bug).
2. **L1**: spec en `docs/design/<tema>.md`; auto-contra-revisión adversarial; el dueño
   puede vetar.
3. **L2/L4/L5**: DeepSeek implementa en `worker/deepseek-<id>`; un PR; tests incluidos.
4. **L6**: Claude post-audita el diff con suite + threat-model.
5. **L0**: Claude re-corre la suite + check-style; lee el reporte; merge o rechazo con feedback.
6. **L7**: cuando toque release, Claude solo.

## Prompt para DeepSeek (pegar en su sesión)

```
Sos DeepSeek (L2/L4/L5) de nicotine — https://github.com/chesterfieldpapi333-beep/nicotine.
Capa: implementación de núcleo + fallos/resiliencia + tests adversariales.
MAESTRO: docs/equipo-capas.md (este archivo) — leelo ENTERO; también docs/equipo.md,
docs/mission-deepseek.md, docs/threat-model.md.

Setup: clone → cd nicotine → bun install --frozen-lockfile → bun test
→ bun x tsc --noEmit → bun scripts/check-style.ts → git checkout -b worker/deepseek-<id>.

INVARIANTES: TypeScript strict sin `any`; cero deps nuevas; superficie L0/L7 intocable
(permissions, auth, src/security, bash-parser, loop, checkPath, tags, release);
deny-wins; non-TTY pide→rechazo; errores accionables; AbortSignal siempre;
desconocido → ask/deny.

ENTREGA: un PR por pieza. Reporte obligatorio:
  Tarea: <id> — <una línea> · Tocado: <archivos> · NO tocado: <archivos>
  Verificación: bun test (<n> pass / <n> fail) · tsc OK|FAIL · check-style OK|FAIL
  Dudas/riesgos: …
Spec ambigua o faltante → PARÁ y preguntá. «Hecho» sin tests no es hecho.
Tu asignación candidata (en espera del OK del dueño): D1 — tests adversariales
bash-parser (heredocs, comillas mixtas, unicode, encadenados multisegmento);
spec completa en docs/arranque-workers.md.
```

## Escalado

- Claude propone; el dueño decide producto/scope; ante conflicto gana la invariante
  de seguridad hasta nueva orden.
- Todo lo irreversible (push master, tags, borrado de ramas ajenas, permisos) pasa
  por L0 + dueño.

> **Pipeline vigente (dueño, 2026-11-11):** el mantenedor puede implementar L2/L4/L5 directamente para piezas pequeñas spec'd (p. ej. D1); la sesión de refuerzo revisa y mejora detrás con la suite. El reparto L0–L7 no cambia en seguridad: nadie delega ni comparte L0/L6/L7.
