# Propuesta: cerrar los huecos DeepSeek de `bash-parser`

**Tema**: `bash-parser-huecos-deepseek`
**Rama objetivo**: `deepseek/bash-parser-huecos`
**Estado**: propuesta (no implementada) — `src/tools/bash-parser.ts` y `src/core/shell-scan.ts` están en §6 (santuario).

---

## Síntomas observados (verificados en `tests/bash-parser-adversarial.test.ts`)

Caso A — `cat script | sh`: `analyzeBashCommand("cat local.sh | sh")` devuelve **false** (no peligroso).
- `shellSegments` divide por `|` → `["cat local.sh", "sh"]`.
- Regla 2a solo dispara si el primer comando es `curl`/`wget`. `cat` no está en `DOWNLOADERS`.
- Resultado: falso negativo. Un script leído de disco y pipeado a un shell no se detecta.

Caso B — `curl -o x && bash x`: `analyzeBashCommand("curl -o x && bash x")` devuelve **true** (peligroso) ya.
- `shellSegments` divide por `&&` → `["curl -o x", "bash x"]`.
- `cmds = ["curl", "bash"]`, regla 2a `DOWNLOADERS + SHELLS` → **true**.
- Este caso **ya está detectado** por la regla 2a existente.

Sin embargo `docs/mission-deepseek.md` (§0, punto 14) declara como limitación honesta:
> `cat script | sh` y `curl -o x && bash x` NO se detectan (local/secuencial, no pipe).

Esa línea describe el estado antes de D1/D2. `curl -o x && bash x` ya está cubierto (pipe implícito por `&&`). Lo que queda abierto es **Caso A: `cat script | sh`** (y variantes `cat script | bash`, `cat script | sudo sh`, etc.).

---

## Hipótesis de diseño (Capa 2)

El falso negativo ocurre porque la regla 2a exige que el primer comando sea un descargador (curl/wget). No cubre el caso donde el *contenido* del shell viene de `stdin` vía `cat` de un archivo local, no de red.

**Opción 1 (mínima, recomendada):** Ampliar la regla 2a para que, además de `curl | shell` / `wget | shell`, marque como peligroso cualquier segmento `cat <archivo> | shell*` donde el primer comando sea `cat` (o `cp`, `cpio`, `less`, `more`) seguido de `| <shell>`. Justificación: si se está flusheando el contenido de un archivo a un shell interactivo, es ejecución remota de código disfrazada.

**Opción 2 (más amplia, más falsos positivos):** Cualquier `| shell` donde el comando a la izquierda no sea un filtro conocido (grep, sed, awk, head, tail, sort, uniq, wc, cut, tr) → ask. Más agresiva, más falsos positivos legítimos (p. ej. `ls | xargs rm` ya se captura por DESTRUCTIVE; `echo x | sh` nuevo).

Recomiendo **Opción 1**: menor blast radius, cubre exactamente el hueco DeepSeek sin tocar permisos ni `ask`/`allow`.

---

## Archivos candidatos (confirmar en Capa 1)

- `src/tools/bash-parser.ts` — regla 2a (líneas ~54-57). Santuario §6.
- `src/core/shell-scan.ts` — `shellSegments` (líneas ~1-120). Santuario §6 (si se toca).
- `tests/bash-parser-adversarial.test.ts` — tests de caracterización (líneas 157-159).

---

## Plan (Capa 3, ≤5 pasos)

1. En `bash-parser.ts`, añadir un nuevo `WRAPPER_LIKE` o ampliar la regla 2a: si `cmds[i]` es `cat` y `cmds[i+1] ∈ SHELLS` → peligroso, reason `«cat archivo | shell»`.
2. Añadir tests adversariales: `cat local.sh | sh` → true; `cat script | bash` → true; `cat data | sudo sh` → true; `grep foo | sh` → false (filtro legítimo).
3. Correr `bun test tests/bash-parser-adversarial.test.ts` → verde.
4. Correr `bun test` completo (sin tocar santuarios de seguridad) → baseline igual o mejor que 518 pass / 36 fail / 2 err (no peor que antes).
5. `bun x tsc --noEmit` verde.

---

## Invariantes (no negociables)

- No tocar `src/security/*` ni `src/core/permissions.ts`.
- No ampliar `allow` ni aflojar `deny`.
- Si el fix necesita tocar `shell-scan.ts` por el heredoc, se documenta como expansión de propuesta (separada).
- Rama `deepseek/bash-parser-huecos`, nunca master, sin force-push.
- Sin atribución de IA en el commit.

---

## Qué NO cambia (para el mantenedor)

- `src/security/paths.ts`, `src/core/permissions.ts`, `src/tools/bash-parser.ts` — solo se propone, no se implementa sin OK explícito.
- El resto del core (hooks, discovery, auth, export) permanece sin tocar en esta tanda.

---

## Evidencia actual (baseline, 2026-11-12)

- `bash-parser-adversarial.test.ts`: 82 pass / 0 fail (verde).
- Suite completa: 521 pass / 1 skip / 33 fail / 2 err (baseline real con Git Bash en PATH; antes 518/1/36/2 sin él).
- Los 33 fails residuales son **ambientales Windows** (`/bin/sh`, `chmod 0600`, PATH detection, symlinks NTFS, señales/hooks) — ninguno toca los 3 pilares H0 intactos (`getCanonicalPath`, `symlink colgante`, `doctor-security`).

---

Decisión requerida: ¿aprueba implementar la Opción 1 (cerrar `cat script | sh`) como propuesta, o mantiene el hueco documentado como limitación honesta?

