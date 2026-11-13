# nicotine — análisis de referencias y hoja de ruta «de verde a maduro» (2026-11)

**Rama**: `docs/roadmap-2026-11` (solo docs; nada a master sin OK).
**Origen**: pedido del dueño tras probar v0.2.6 — «muy verde, muy limitado, muy básico, bastantes bugs». Este documento convierte esa sensación en un plan ejecutable por capas.
**Referencias clonadas bajo licencia abierta** (shallow, solo lectura, en `/home/user/refs/` de la máquina de trabajo; no se vendoriza nada):

| Proyecto | Repo | Licencia | Qué es |
|---|---|---|---|
| OpenCode | `anomalyco/opencode` (== `sst/opencode`) | MIT | Agente de código OSS; evolución de sst |
| Codex CLI | `openai/codex` | Apache-2.0 | Agente de OpenAI, Rust + wrapper TS, Bazel |
| Hermes Agent | `NousResearch/hermes-agent` | MIT | Agente personal de Nous Research; core único multi-UI |
| DeepSeek Harness | `deepseek-ai/deepseek-harness` | MIT | «Everything is a plugin» sobre Cordis; developer preview |

**Claude Code queda fuera como referencia de código**: es propietario; se usa únicamente su
UX pública (docs, blog, comportamiento observable) para decisiones de diseño propias.
Del resto, se leen ideas y arquitectura — jamás se copia código verbatim ni estructura
protegida; nicotine permanece MIT y autoescrito.

---

## 1) Qué hacen las referencias (arquitectura real, verificada en el clon)

### OpenCode (MIT, TS + Bun, monorepo `packages/*` + turbo)
- **Capas estrictas**: `Schema → Core/Protocol → Server → Client`; `sdk` compone Client+Core+Server. Client jamás depende de Core/Server (regla del repo, en `AGENTS.md`).
- **Persistencia**: `drizzle-sqlite` + Effect (`effect-drizzle-sqlite`); `core` con `drizzle.config.ts`.
- **TUI**: «feature-plugins» + **TUI stories** (storybook-like) con fixtures — `packages/tui/.../storybook`, se corre con `OPENCODE_STORY=<id> bun run dev:live`, probando anchos estrechos/anchos.
- **Desktop**: app nativa (electron/similar) + `app`, `gui-plugins`, `desktop`.
- **Clase heredada**: el permiso allow/ask/deny con patrones — formato `opencode.json` que nicotine ya lee en capa de compatibilidad.
- **Testing**: unit + stories/fixtures de TUI; `dev:live` contra el server background con credencial local privada.
- **Conclusión útil para nicotine**: (a) arquitectura por etapas con contratos, (b) storybook de componentes de TUI, (c) Sqlite local para sesiones si algún día crece.

### Codex CLI (Apache-2.0, Rust `codex-rs` + wrapper `codex-cli` TS, Bazel + pnpm)
- **Workspace gigante** (`codex-rs/`): `agent-identity`, `agent-graph-store`, `agent-message-board-*`, `agent-roles`, `apply-patch`, `bwrap` (sandbox bubblewrap), `chatgpt`, `cloud-client`, `app-server`, `core`, `exec`, `sandboxing`, `tui`...
- **Sandbox a nivel de SO**: bubblewrap (Linux), Seatbelt (macOS) — no solo «ask»: contención real de la ejecución.
- **execpolicy**: política de ejecución con allowlist de comandos (docs/execpolicy.md); CLA; auth vía ChatGPT.
- **Conclusión útil para nicotine**: el deny-wins + ask forzado nuestro es más simple pero más débil que un sandbox; una mejora honesta a futuro: documentar integración opcional con bubblewrap/sandbox-exec (capa, no urgente).

### Hermes Agent (MIT, Python; CLI/TUI/Electron/Web/ACP + gateway 25+ plataformas)
- **Un core, muchas superficies**: el mismo agente corre en CLI, TUI, Electron, web dashboard, editores ACP y mensajería (25+ plugins de plataformas).
- **Plugins y skills, no core creciente**: toda extensión vía `plugins` y `skills`.
- **«Per-conversation prompt caching is sacred»**: no mutar el contexto estable; la única excepción es la compresión — doctrina de costo real en producción.
- **`SOUL.md`**: identidad/persona del agente como archivo; `AGENTS.md` como hub por capas (cada área carga su guía automáticamente).
- **Conclusión útil para nicotine**: (a) no crecer el core — crecer skills/commands/agentes; (b) proteger el prefijo de prompt (caché) — nuestros costos; (c) `AGENTS.md` por directorio ya lo hacemos (compatible), reforzar en docs.

### DeepSeek Harness (MIT, TS; Cordis; developer preview 2026-08)
- **«Everything is a plugin»**: modelo, tools, loop, sesiones, storage, UI — todo plugins intercambiables sobre **Cordis** (composabilidad espacio-temporal).
- **Apps**: `apps/cli`, `apps/web`, `apps/desktop`, `apps/plugin-market-generator`.
- **Benchmarks serverios** (`benchmarks/session-corpus`, `conversation-fold`, `long-session-browser`, `terminal-io`) — métricas de calidad de agente.
- **SAFETY.md ejemplar**: se declara a sí mismo NO seguro, describe límites de sandbox y abuso. Postura honesta que nicotine comparte en espíritu.
- **Conclusión útil para nicotine**: nada que copiar; sí: (a) buena idea de modos/presets (standard/safe/plan), (b) benchmarks de conversación, (c) guía de publicación de plugins (más adelante, si llega a plugins).

---

## 2) Diagnóstico honesto de nicotine v0.2.6

**Fortalezas reales** (verificar con `nic doctor`, los tests, los doctor-security):
deny-wins + fail-closed; paths/permissions de rutas duras; redacción de secretos; redact git backups; serve loopback+password+body-cap+fail-closed; ask-solo para lo novedoso (nunca deny nuevo); tests adversariales del parser bash; CI con 5 gates; SHA256SUMS/SBOM in-repo verificables; español nativo; compat lectura con Claude/Codex/Gemini/OpenCode/Pi.

**Debilidades reales** (el «verde» del dueño):
- **TUI básica**: sin stories/fixtures de componentes, sin temas hilados al final, sin rich status/progreso, sin keybindings documentados en-app, opentui cargado con `import()` dinámico opcional (correcto) pero poco explotado.
- **Sin sandbox de SO**: nicho de Codex; nicotine solo tiene ask/deny — suficiente hoy (CLI personal), no para CI consciente de secretos (roadmap, opt-in).
- **Sesiones efímeras en JSON**: bastan para el uso y jamás SBOM/headless; pero no hay compresión de contexto ni memoria auto (solo vault opt-in) ni métricas de sesión persistentes.
- **Providers**: fallback de modelo opt-in (`compat.refusal_failover`); sin tool-use estricto garantizado en todos los modelos; sin razonamiento visible estructurado.
- **Docs/onboarding**: `nic` asume Bun y git; Windows oficialmente WSL; tutoriales de primeros 5 minutos cortos; el `--help` es denso.
- **Testing**: 561 tests, 0 pruebas E2E de TUI ni de *smoke install*; nada valida la experiencia del primer `git clone && nic`.
- **Empacado**: sin self-extracting binary — correcto por política, pero el ritual de «verificación por clon» debería ser `docs/release.md` con un video/gif o `install.sh` que lo automatice (no publicar binarios).

---

## 3) Brechas priorizadas (esfuerzo en días; «capa» = orden de ejecución)

| # | Área | nicotine hoy | referencia | brecha | esfuerzo | capa |
|---|---|---|---|---|---|---|
| 1 | Sesión de prueba guiada y registro de bugs reales | ninguno (561 tests unit) | todas | faltan repros del dueño | 0.5–1 d | **T0** |
| 2 | TUI: estados/progreso/streaming, keybinds, modo compacto | opentui básico | opencode TUI stories | alta | 2–4 d | **T1** |
| 3 | Docs de instalación multi-plataforma + `install.sh` (no binarios) | README | codex docs/install | media | 0.5–1 d | **T1** |
| 4 | Compresión de contexto + ruta «resumen de sesión» | no | hermes, dsh benchmarks | media | 2 d | **T2** |
| 5 | Memoria auto opcional (digest al inicio) | vault opt-in manual | hermes memory providers | media | 2 d | **T2** |
| 6 | E2E smoke del flujo `clone → verify → install → nic doctor` | no | codex docs | media | 1 d | **T2** |
| 7 | Métricas de tool-call persistentes (no solo stats en ramas) | opt-in en sesión | hermes | baja | 1 d | **T2** |
| 8 | Sandbox opt-in bubblewrap/seatbelt (Linux/macOS; Windows N/A) | no | codex | alta | 3–5 d | **T3** |
| 9 | MCP: robustez OAuth/reconexión; errores UX | básico | opencode server | media | 1–2 d | **T3** |
| 10 | TUI stories/fixtures de componentes (herramienta propia, cero deps) | no | opencode stories | alta | 3–5 d | **T3** |
| 11 | Plugins/catálogo commands/skills firmado (sólo advertencias, sin ejecución) | parcial | dsh plugin-market | alta | 5+ d | **T4** |
| 12 | CI matrix: Windows runner + badge en README | solo ubuntu + 1.4.4 | opencode/hermes | baja | 0.5 d | **T0** |
| 13 | Issues + Epic en GitHub; tracker en Drive (carpeta proyecto) | no | — | — | 0.2 d | **T0** |

**T0 (esta semana)** 1, 12, 13. **T1** 2, 3. **T2** 4–7. **T3** 8–10. **T4** 11.

---

## 4) Reglas de gobierno de la tanda

- Rama por tema (`feat/*`, `fix/*`, `docs/*`, `deepseek/*`), 4 gates en clon limpio, PR, **OK humano antes de master**. Nada a master directo.
- **Branch protection en master**: pendiente del dueño (único que puede activarla); mientras tanto disciplina + revisión humana.
- **deny-wins intacto**: nada de `ask→allow`, nada de `deny` ampliados sin spec; solo `ask` forzado para lo novedoso.
- **Cero deps de runtime** en el núcleo (sólo `@opentui/core` opcional). TS estricto. Español.
- **Claude Code solo como UX pública** — nunca se lee ni descompila su código.
- Referencias abiertas citadas con licencia; atribución si se toma algo; nunca verbatim.
- Cada bug encontrado entra **con repro**; si no hay repro, es «limitación conocida» documentada, no un fix.

## 5) Trackers

- **GitHub Issues**: al recibir el OK del dueño, se crean ~12 issues (T0–T2) con checklists; se enlazan en el PR de cada capa.
- **Drive «Nicotine — Proyecto 2026-11»**: este doc + bitácora por capa + informe de cada release de tanda.
- **Métricas**: #tests (561 → objetivo 650+), #issues bugs, time-to-verify (clon limpio < 10 min), % de la lista «verde» del dueño cerrado.

## 6) Riesgos y límites honestos

- **«Hacer todo» = meses**: se ejecuta por capas con cortes verificables, no en una sola tanda.
- Windows + 25 fails ambientales: el arreglo real es WSL o un runner Windows en CI; el sandbox no los «arregla» a mano.
- Re-leer las referencias trae costos (>1 GB clonado): son referencia, no dependencia. El workspace donde viven no persiste entre sesiones — re-clonable en minutos.

## 7) Próximos pasos (en orden)

1. (este doc) Revisar/mergear la rama `docs/roadmap-2026-11` — decisión del dueño.
2. OK del dueño → crear los ~12 issues T0–T2 en GitHub.
3. Subida de este doc al Drive del proyecto.
4. Sesión de **T0-prueba guiada** (vos + CLI recién installada) alimentando el registro de bugs; cada bug con repro entra a su rama + gates.
5. **T1 UX/TUI** tras cerrar T0.
