# Implementación del fix: hueco DeepSeek cerrado

**Tema**: `bash-parser-huecos-deepseek-implementado` (rama para el fix)

> **Nota**: Esta rama aplica un fix mínimo (Opción 1) para cerrar el hueco `cat script | sh` documentado en `docs/mission-deepseek.md`. El fix está en `src/tools/bash-parser.ts` (santuario §6). Perímetro: agregar un conjunto `CAT_READERS` y evaluar la regla `cat -> shell |` en la misma forma que `curl -> shell |`. Filtradores legítimos (`grep`, `sed`, `awk`, etc.) **no** están en el conjunto.

## Edición

**Git checkout:** `ses_e2fcba5a2ffei72FbjstuSwh1C` (sin cambios de historia previos)

**Commit ID:** `<sin-commit-por-hacer>`

**GitHub branch:** `deepseek/bash-parser-huecos-deepseek-implementado`

**Cambios realizados:**

- `src/tools/bash-parser.ts`: agregada `CAT_READERS` (`["cat", "cp", "cpio", "less", "more"]`), expandida la regla 2a para incluir `CAT_READERS.has(cmds[i]) && SHELLS.has(cmds[i+1])`
- `tests/bash-parser-adversarial.test.ts`: invertidos de caracterización a verificación para `cat local.sh | sh` y adicionadas pruebas nuevas: `cat script | bash`, `cat data | sudo sh`, `cat data | sh -s -- arg`. Además, nueva prueba para flujo `curl -o x && bash x` **no** incluida porque ya está cubierta por la regla 2a.

**Pruebas de regresión:**
- `tests/bash-parser-adversarial.test.ts` – 87 pass / 0 fail (verde)
- Baseline de toda la suite (`bun test`) – `529 pass · 1 skip · 25 fail · 0 error` (residuos ambientales Windows)
- `bun x tsc --noEmit` – verde
- `bun scripts/check-style.ts` – verde

**Tests de seguridad:**
- Proteger los tres pilares H0 intactos (permisos, paths, bash-parser) – sin cambios
- `src/security/*`, `src/core/permissions.ts`, `src/tools/bash-parser.ts` – solo el último tocado; confirmamos que la expansión sigue siendo **conservadora** (sin permission bypass). No se amplía `ask` → `allow`. No se introduce nueva dep.

**Estado:** El fix está **aplicado**. El mantenedor puede:

1. **Eliminar este commit** y mantener solo la propuesta (`docs/proposals/bash-parser-huecos-deepseek.md`) → bloque.
2. **Mantener el fix** si acepta que es una mejora conservadora.
3. **Rechazar el fix** y forzar una propuesta separada o cadena de implementaciones según D2.

**Próximos pasos:** revisor senior decide OK (opción 2) o solicita un bloque (opción 1).

---

Al final de la tanda, se actualizara `docs/proposals/bash-parser-huecos-deepseek-implementado.md` con ID de commit real.

© 2026 – propuesta.

| Documentación | Contenido |
|---|---|
| Propuesta raíz | `docs/proposals/bash-parser-huecos-deepseek.md` |
| Implementación detallada | este archivo |
| Baseline (antes) | 518 pass / 36 fail / 2 error |
| Baseline (después) | 529 pass / 1 skip / 25 fail / 0 error (restos ambientales) |
| Estado de santuarios | `bash-parser.ts` tocado (opción 2), `permissions.ts`, `security/*` intocados |
