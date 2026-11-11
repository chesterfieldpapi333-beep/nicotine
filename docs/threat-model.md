# Threat model — nicotine

**Fecha:** 2026-11-11 · **Alcance:** H0 del plan de endurecimiento · **Honestidad obligada:**
nicotine NO es un sandbox de kernel ni un antivirus. Este documento enumera activos,
amenazas, controles y — sobre todo — **límites**: lo que nicotine no protege.

## 1. Activos

| Activo | Dónde vive | Criticidad |
|---|---|---|
| API keys de proveedores | env (`OPENAI_API_KEY`, …), `auth.json` (0600), `opencode.json(c)`, `oauth.json` (0600, MCP) | alta |
| Tokens OAuth MCP | `$XDG_DATA_HOME/nicotine/oauth.json` | alta |
| Conversaciones / sesiones | `$XDG_DATA_HOME/nicotine/sessions/*.jsonl` (pueden contener código y secretos pegados) | alta |
| Código y datos del usuario | cwd y `external_directory` (reglas deny-wins) | alta |
| Config del usuario (proyecto/global) | `opencode.json(c)`, `.nicotine/*` | media |
| Credenciales laterales en el vault | `~/.obsidian*`, vaults Obsidian (nicotine solo lo lee con deny-wins + filtros) | alta |
| Integridad del proceso hijo (bash tool) | procesos emparejados por la tool | media |
| Contexto enviado al proveedor | todo lo que entra al prompt (system, archivos, salidas de tools) | alta |

## 2. Modelo de adversarios

1. **Modelo (LLM) cooperativo pero falible**: alucina tool-calls, intenta acciones destructivas
   por instrucciones hostiles en contenido leído (prompt injection indirecta). NO se asume
   malicioso en sentido estricto; se asume **manipulable por el entorno**.
2. **Contenido hostil**: README, issue, página web, salida de MCP, comentario en código —
   puede traer instrucciones que buscan exfiltrar secretos o ejecutar `rm -rf`.
3. **Config de proyecto hostil**: repositorio clonado con `opencode.jsonc` que apunta a
   MCP/extensiones arbitrarias. Control: capas de proyecto piden confirmación y quedan
   listadas (nunca ejecutadas en `doctor`).
4. **Servidor MCP/extensiones comprometidos** (terceros). Control: nunca se importan
   desde `doctor`; arranque con confirmación; deny-wins sobre sus herramientas.
5. **Máquina comprometida**: fuera de alcance (un atacante con tu usuario lee todo, incluido
   `auth.json` aunque sea 0600).

## 3. Amenazas y controles

| # | Amenaza | Control existente / previsto | Límite |
|---|---|---|---|
| T1 | Exfiltración de secreto pegado en sesión hacia el proveedor | Redacción de secretos en salidas y logs (H5); filtros del vault; `read` de `.env` → `ask` | El usuario puede pegar claves en el chat; no se puede impedir, solo advertir y no propagarlas a archivos/logs |
| T2 | Tool hostil: `bash` arbitrario | Permisos deny-wins; `--readonly` (H3); allowlist de env en hijos (H4); salidas truncadas (H4) | La tool `bash` con permiso `allow` **ejecuta cualquier cosa**: nicotine no analiza semánticamente el comando |
| T3 | Secreto en `sessions/*.jsonl` / logs | Scan en `nic doctor --security` (H0); redact (H5); auditoría sin secretos (H8) | Si el secreto ya está persistido en disco antes de H5, el scan lo detecta pero no lo borra |
| T4 | Plugin/extensión maliciosa | Sólo datos en `doctor`; import/ejecución solo tras confirmación del usuario; deny-wins | Un plugin aprobado por el usuario ejecuta JS con tu UID: sin sandbox |
| T5 | Config hostil de proyecto | Confirmación de MCP/extensiones de proyecto; capas listadas; deny-wins | `opencode.jsonc` con `instructions` maliciosas entra al prompt: mitigación parcial (permisos) |
| T6 | `serve` expuesto sin auth | `serve` apagado por defecto; **obligatorio** `NICOTINE_SERVER_PASSWORD` u `OPENCODE_SERVER_PASSWORD`; basic-auth en todos los endpoints | Sin TLS propio: poner detrás de un reverse proxy si se expone |
| T7 | Parser roto / entrada patológica (JSONC, regex, tool-calls en texto) | Parsers acotados, sin `eval`; fuzzing lite (H7); límite de bytes por salida de tool (H4) | Bugs en parsers siempre son posibles: H7 reduce, no elimina |
| T8 | Secreto en historial git local / `.git/config` | Scan en `doctor --security` (URLs con credenciales en `.git/config`) | No reescribe historia: usar `git filter-repo` si se detecta |
| T9 | Fuga vía MCP remoto (datos → servidor tercero) | MCP remotos listados; origin de proyecto pide confirmación; deny-wins sobre sus tools | Todo lo que el agente envíe a su provider queda bajo política del provider (retención, training): nicotine no puede cambiar eso |
| T10 | Cadena de suministro (dependencias) | `bun.lock` pinado; `verify-release.sh` con sumas in-repo (H2); SBOM (H2); revisión manual (H6) | Sin firmas de terceros; `@opentui/core` opcional es dependencia confiada, no auditada |

## 4. Controles transversales y verificación

- **deny-wins**: si cualquier regla aplica `deny`, el efecto es deny (probe sintética en tests).
- **fail-closed donde importa**: deny gana siempre (incl. vs allows guardados); `ask` en non-TTY → rechazo; vault bloquea lectura/escritura con credenciales; `serve` sin password → no arranca; `--readonly` → escritura deny global; sin regla aplicable gana la última regla (defaults: allow, con ask en `*.env` y `external_directory`).
- **mínimo privilegio**: `doctor` no ejecuta nada (ni MCP, ni plugins, ni extensiones); sólo lista.
- **observabilidad sin secretos**: stats de tool-calls en texto anonimizadas; auditoría (H8) sin cuerpos ni claves; nada sale de la máquina (sin telemetría).

## 5. Qué NO protege nicotine (explícito)

1. Máquina del usuario comprometida (malware, otro proceso con tu UID).
2. Modelo malicioso/prompt injection en sentido fuerte: solo mitigación parcial (permisos, redacción, `--readonly`).
3. Red: no hay pinning de certificados ni verificación de proveedor; HTTPS estándar.
4. Datos ya exfiltrados o persistidos fuera del árbol de nicotine (p. ej. en el proveedor).
5. Borrado seguro de disco (sesiones borradas pueden quedar en SSD/journaling).
6. Contenido del vault: nicotine respeta zonas y filtros, pero el vault es del usuario.

## 6. Verificación continua

- `nic doctor --security` → exit 0/1 (con `--json`); correr antes de abrir un proyecto nuevo.
- Suite de tests con XDG aislado; ningún test usa credenciales reales.
- Cada release de código (tag) regenera `SHA256SUMS`/`SBOM` in-repo desde un clon limpio (H2/H9).
