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

- `bash-parser-adversarial.test.ts`: 87 pass / 0 fail (verde).
- Suite completa: 534 pass / 1 skip / 25 fail / 0 error (baseline real con Git Bash en PATH).
- Los 25 fails residuales son **ambientales Windows** (`/bin/sh`, `chmod 0600`, PATH detection, symlinks NTFS, señales/hooks) — ninguno toca los 3 pilares H0 intactos (`getCanonicalPath`, `symlink colgante`, `doctor-security`).

### Lista nominal de 25 fails ambientales Windows
1. `NICOTINE_MAX_TOOL_OUTPUT_BYTES` trunca la cola y deja log 0600
2. `tools.bash.envAllow` limpia el entorno del hijo (solo allowlist + básicos)
3. `loadConfig` (capas proyecto) > el más cercano gana; los escalares se conservan si no conflictúan
4. `auth store` (/connect) > `writeAuthEntry` crea `auth.json` 0600, hace roundtrip y reemplaza entradas
5. `/export` > la sesión se exporta a Markdown con roles y sin system; archivo con permisos 0600
6. `discoverClis` — solo disco > encuentra ejecutables en varias entradas de PATH y respeta el orden
7. `discoverClis` — solo disco > ignora archivos sin bit de ejecución y directorios con el mismo nombre
8. `discoverClis` — solo disco > `isExecutableFile`: distingue archivo ejecutable, no ejecutable e inexistente
9. `probeCliVersion` — opt-in, acotado y sin colgarse > captura solo la primera línea de `--version`
10. `probeCliVersion` — opt-in, acotado y sin colgarse > acota a 120 caracteres y quita caracteres de control
11. `doctor` — sin ejecución por defecto (P1) > el sondeo de ripgrep es por disco: no ejecuta `rg`
12. entorno limpio: exit 0, sin hallazgos, deny-wins OK
13. `editInExternalEditor` > roundtrip: el contenido editado vuelve al llamador; `suspend` se ejecuta
14. `PermissionEngine` > `external_directory` allow + read dentro permite
15. `checkPath` — deny-wins entre `external_directory` y la acción > `external_directory` deny gana sobre allow de la acción fuera del proyecto
16. `discoverPlugins` — datos multi-CLI > claude plugin global: manifest, comandos namespaced, agentes, skills, hooks
17. `hooks` — ejecución > `PreToolUse` no bloquea en read; `PostToolUse` fire-and-forget
18. `vault Obsidian` (fase 11a) > `vault_read` bloquea notas con credenciales (fail-closed) sin filtrar el secreto
19. `memoria por proyecto` (.nicotine/memory.md, solo cwd) > se carga con kind `memory` y la nota para el agente
20. `connectMcpServers` — stdio > startup timeout: servidor mudo → failed, no cuelga
21. flujo completo (DCR → navegador simulado → callback → store) > emite token, persiste en `oauth.json` 0600 y encadena resource RFC 8707
22. failover de modelos (`NICOTINE_MODEL_FALLBACKS` / `provider.fallbackModels`) > todas las claves 429 en modelo A → salta a modelo B y tiene éxito
23. failover de modelos (`NICOTINE_MODEL_FALLBACKS` / `provider.fallbackModels`) > 400 NO rota ni salta al fallback
24. failover de modelos (`NICOTINE_MODEL_FALLBACKS` / `provider.fallbackModels`) > cadena agotada → `ProviderError` con el último status
25. failover de claves (401/403/429/5xx) > `resolveProvider` construye el pool: config `apiKeys` + env `OPENAI_API_KEYS`, dedup

Nota: Causas comunes — permisos NTFS (`chmod 0600`), PATH detection en Windows, `HOME` path, symlinks, señales/hooks, Git Bash vs Windows paths.

---

Decisión requerida: ¿aprueba implementar la Opción 1 (cerrar `cat script | sh`) como propuesta, o mantiene el hueco documentado como limitación honesta?

