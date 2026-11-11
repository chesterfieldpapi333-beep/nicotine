# Checklist del mantenedor — revisión del PR/rama de D1

Se aplica cuando la sesión combinada (prompt Claude+DeepSeek) entregue la rama `worker/deepseek-d1` o equivalente (o push directo a `master` — ver «Riesgo de colisión» abajo).

## A. Antes de mirar el diff
1. `git fetch origin --prune` y `git log --oneline master..<rama>` — qué commiteó y con qué mensaje(s). ¿Español, imperativo corto, sin atribución de IA?
2. `git diff --stat origin/master...<rama>` — los archivos tocados. **D1 exige: `tests/bash-parser-adversarial.test.ts` nuevo + `CHANGELOG` opcional + nada más.** Cualquier toque a `src/`, `release/`, `docs/design/` o la máquina de permisos = **rechazo inmediato**.

## B. Verificación ejecutada por el mantenedor (no vale el reporte del worker)
1. `bun install --frozen-lockfile`
2. `bun test` completo — ต้องo 471+ pass, 0 fail (D1 suma casos).
3. `bun x tsc --noEmit` limpio.
4. `bun scripts/check-style.ts`.
5. `git status --porcelain release/` vacío contra las sumas **del commit mergeado** (si el worker regeneró sums, contrastarlas; si no lo hizo y cambió archivos trackeados, regenerarlas yo mismo con `./scripts/verify-release.sh` y commitearlas en el merge).

## C. Conformidad con la spec (`docs/design/d1-bash-parser-tests.md`)
- [ ] Archivo nuevo `tests/bash-parser-adversarial.test.ts`; el archivo existente `tests/bash-parser.test.ts` sin reescribir.
- [ ] Casos caracterizados como «congelar ≠ bendecir» llevan el comentario de una línea.
- [ ] Ningún veredicto contradice la spec sin haber sido **verificado ejecutando el analizador** (si diverge: preguntar/reportar, no parchear).
- [ ] El reporte del PR dice qué casos verifican y cuáles caracterizan huecos conocidos (heredocs, `find -delete`, `git clean -fdx`, `.git/hooks`, `exec`).

## D. Merge
1. Si A/B/C pasan: merge fast-forward o squash según acuerde el dueño; re-correr la suite en el merge commit.
2. Si algo falla: feedback concreto en el PR (archivo, línea, comportamiento esperado) — el worker itera en la MISMA rama; nunca `push --force`.
3. Post-merge: `git push`, y si hubo archivos trackeados cambiados, `./scripts/verify-release.sh` + commit de sumas junto (o inmediatamente).
4. Actualizar `docs/qwen-tasks.md`?? No — D1 no es de Qwen; solo actualizar `docs/design/d1-bash-parser-tests.md` marcando «✅ fusionado (<hash>)» y CHANGELOG («D1 fusionado»).

## Riesgo de colisión (importante)
Si la sesión combinada **commitea directo a master**, yo no puedo regenerárselo en paralelo: trabajá SIEMPRE sobre su rama y avisame para que revise y mergee. Si pushea a master encima desde otra sesión, el árbol puede divergir: yo haré `fetch + reset --hard origin/master` tras tu OK antes de commitear nada aquí, y las sumas podrían quedar a mi cargo.
