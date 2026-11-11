# Linaje e investigación: de la spec «Shchiy» a nicotine

> Notas de investigación condensadas. Documenta **por qué** nicotine está diseñado
> como está: de dónde salieron las ideas, qué CLIs/harnesses se evaluaron, qué se
> decidió robar de cada uno y qué llegó a implementarse.
>
> **Fuentes (octubre–noviembre 2026):** conversaciones propias con un asistente IA
> (2026-10-02: crítica a la spec; 2026-10-14 → 2026-10-18: investigación de CLIs) y
> docs/repos públicos citados en [`parity.md`](./parity.md). Los enlaces privados a
> esos chats no se publican; hay copias en el vault personal del autor (fuera de este
> repo). Precios, rankings y "permitido/censurado" de modelos son **datos
> auto-reportados de octubre 2026, sin verificar**; ver «Advertencias».

## 1. El linaje en tres pasos

1. **Spec Maestra V2** (visión de app de escritorio universal de agentes; archivos
   separados, fuera de este repo). Nunca cerró su «gate» v0. **Aparcada.**
2. **Crítica externa a la spec (2026-10-02).** Los hallazgos que forzaron el pivote:
   - Scope de **5–15 personas-año** para un solo desarrollador; sin *vertical slice*
     mínimo (qué se tira si aprieta el tiempo).
   - **Sin usuario objetivo**: el documento sugiere dev y usuario final a la vez.
   - Orden del *Capability Resolver* arbitrario y hardcodeado; debía basarse en
     scoring (trust, coste, latencia, privacidad, preferencia) con overrides.
   - **IR a medio diseñar**: sin versionado, sin round-trip fidelity, sin semántica
     de ejecución → eso es un TODO, no un diseño.
   - **Self-modification sin barreras**: el «watchdog externo» es la parte crítica y
     estaba sin diseñar (sin firma criptográfica, sin TOTP/hardware key). Conclusión:
     no construir self-update/self-extension hasta que exista esa barrera.
   - "Environment sanitized" mencionado una sola vez: un capítulo entero (PATH,
     `LD_PRELOAD`, `NODE_OPTIONS`, `PYTHONPATH`, `SSH_AUTH_SOCK`, `AWS_*`).
   - Contradicciones internas (§41 «ejecuta cualquier CLI» vs §62 «no construyas una
     terminal»; observabilidad «interna» sin opt-in).
   - Regla aceptada: **fail-closed, permisos antes que autonomía, nada de promesas
     que el código no cumpla**.
3. **Pivote (2026-10-14 → 2026-10-18): no construir desde cero — moldear un harness
   existente.** Se evaluaron gptme, Pydantic Deep Agents, OpenHands+Canvas,
   yk-y/`y`, agent-sdk-cli-template, clawdcode, convertible-cli/TAUI, frameworks de
   CLI (Nabat, @reliverse/rempts, Triad, mem-cli) y shells (Luna, softshell,
   nyagos, Flyshell). Ganó **Pi** (`earendil-works/pi`, MIT, TypeScript, core mínimo:
   read/write/edit/bash, TUI (`pi-tui`), extensiones in-process, ~300 tokens de
   prompt base). De ahí nació la implementación propia ("lit" = Pi + extensiones) y,
   reimplementada sin fork y con cero dependencias en el núcleo, **nicotine**.

## 2. Panorama de CLIs evaluadas (octubre 2026, sin verificar)

Tabla tal como se investigó (columnas: lenguaje / tamaño / auto-extensible / notas /
«qué robar»). Los benchmarks citados son auto-publicados; ver «Advertencias».

| Proyecto | Lang. | Auto-ext. | Qué robar |
|---|---|---|---|
| markov | Bash (1 archivo) | no | Filosofía minimalista |
| mangopi-cli | Python (1 archivo) | no | Cero dependencias |
| prism32 | Python (1 archivo) | **sí** | Auto-generación de plugins |
| kittycode | Python (~2K LOC) | no | Código legible end-to-end |
| mini-swe-agent | Python (~100 LOC) | no | Restricción a bash puro; >74% SWE-bench (auto-reportado) |
| Wizard | Rust (1 binario) | **sí** | Auto-extensión verificada |
| koi | TypeScript | **sí** | Arquitectura ECS; agent discovery |
| openmax-cli | Rust | **sí** | Loop de ejecución enfocado |
| infinite cli | Node | **sí** | Herramientas desechables (registrar/desregistrar) |
| **Pi** | TypeScript | **extensiones** | Core mínimo, `pi-tui` redibujable |
| cray-code | TypeScript | plugins | Lifecycle hooks |
| cipher-harness | Python (~3K) | plugins | Pipeline legible de punta a punta |
| trustee | Rust | **sí** | Plugins WASM con lifecycle |
| latent | Rust | sub-agents | MCP + tool calls paralelos, sandbox |
| cognis-code | Python | no | Un endpoint → todos los editores |
| UnleashedLLM | Python | no | Gestor de modelos |
| HacxGPT-CLI | Node | no | Config «sin rechazos» por defecto |
| svarogai | Python | no | **Refusal-failover** (reintento con otro modelo ante rechazo) |
| OmegaCode CLI | Node | no | Alternativa directa a Claude Code |
| opend-ai | Node | no | Streaming de razonamiento visible |
| clai | Node (~25 providers) | no | Multi-proveedor + free tier |
| agentd | TypeScript | multi-agente | Orquestador de agentes |
| omnion | Python | extensible | Computer use |
| OpenPaw | TypeScript (Bun) | skills | Personal assistant |
| kit | Go | sistema de ext. | 22 temas, TUI rica |
| nagents / simple-agent-go / harness-cli | Python/Go | varios | Frameworks ligeros |
| aichat | Rust | config + roles | Multi-proveedor |
| ShellGPT | Python | config | Comandos de shell directos |
| **gptme** | Python | plugins, skills, hooks | **Cross-harness memory** |
| **aider** | Python | config | **Architect/Editor split**, repo map, watch mode |
| **Fabric** | Go | patterns | **Semantic action stream** («Analizando» en vez de `cargo build`) |

Otros mencionados sin evaluación profunda: clai, Baize, LynxHub, multi-model-term-ai,
Tailor, be-code-redux.

**«Proyectos que NO existen» (descubierto en la investigación):** «Shannon 7B» (es un
agente de pentesting, no un modelo local), «Jev-Base 3B» (modelo de decisión
estructurada vía API de pago, no análisis visual), «Mythos-qwen … heretic»
(identificador no verificado).

## 3. Steal list y su estado en nicotine

| Idea | Origen | Estado en nicotine |
|---|---|---|
| Hook de confirmación / permisos | gptme | **hecho** — motor allow/ask/deny, deny-wins, fail-closed (fases 1+); endurecimiento en `plan-hardening.md` |
| Cross-harness memory | gptme | **hecho** — `.nicotine/memory.md` (fase 8) + memoria persistente en vault Obsidian, `vault_*` (fase 11) |
| Architect/Editor | aider, gptme | **parcial** — agentes `architect` (deniega edición) y `editor`; split de modelos por turno **no** implementado |
| Tool-call fallback en texto | (lit-shim) | **hecho** — `<tool_call>`, XML, `<invoke>`, MLF, fences, JSON desnudo; stats anonimizadas (fases 8 y 11b) |
| Ediciones mínimas guiadas | aider | **hecho** — edit con «fragmento más parecido» (fase 8) |
| Failover por error HTTP / claves | spec | **hecho** — rotación de claves (401/403/429/5xx) + fallback de modelos `fallbackModels` / `NICOTINE_MODEL_FALLBACKS` (fases 8/9); en motor «vercel-ai» (fase 10) |
| Refusal-failover (rechazo de contenido) | svarogai, spec | **falta** — no hay detección/reintento semántico ante rechazo (distinto del failover por error HTTP) |
| Semantic action stream (TUI «Analizando → Ejecutando») | Fabric | **falta** |
| Lifecycle hooks extensibles | cray-code | **parcial** — eventos tipados del loop; sin plugins ejecutables (por diseño) |
| Repo map para contexto | aider | **falta** |
| Watch mode (instrucciones en comentarios) | aider | **falta** |
| Agent discovery (descubrir CLIs en PATH) | koi | **falta** |
| Disposable tools (registrar/desregistrar al vuelo) | infinite cli | **falta** |
| Single-file / bash-only mode | markov, mini-swe-agent | **falta** (el perfil «explore» se aproxima) |
| WASM agent profiles | trustee | **falta** (descartado por ahora) |
| Compresión de contexto de largo alcance | aider, kittycode | **parcial** — compactación de dos pasos (poda sin LLM → resumen; fase 8) |
| Clasificación de modelos (tools/censura) | research | **hecho** — `nic models`, badges, overrides manuales (fase 11c) |
| Self-extension verificada | Wizard, koi | **descartado** — barrera criptográfica sin diseñar (ver §4 del plan-hardening) |

## 4. Modelos evaluados (octubre 2026, sin verificar)

- **Locales (ASUS VivoBook, RAM justa):** qwen25-coder-3b-codex/local (3,4 GB),
  qwen-vl-q4 (visión, 3,5 GB), huihui-qwen3-1.7b (1,3 GB), qwen25-1.5b (1,2 GB).
- **Recomendados y no instalados:** NEXUS-Coder (1 GB), DeepHat-V1-7B (4,7 GB),
  WhiteRabbitNeo (4,5 GB), Qwen3.8-27B (16,8 GB), MaralGPT-9B (5,3 GB).
- **Veredicto del asistente sobre «Qwen3.8-27B Heretic ARA IQ3_M»** (jacokon/
  qwen3.8-27b-heretic-ara, ~13 GB): VLM optimizado «vision + coding agent", Heretic
  v1.2 con Arbitrary-Rank Ablation, cuantización IQ3_M (I-matrix + MTP), recomendado
  para 16 GB de VRAM, licencia Apache-2.0. **Caveats propios:** cuantización 3-bit
  agresiva; modelo «heretic» (fusión decensorada) sin benchmark independiente; los
  heretics pequeños resultaron «lobotomizados» en evaluación previa. Decisión: medir
  en hardware real (tok/s propios, calidad en tareas propias) antes de adoptar.
- **Hardware externo:** Kaggle 2×T4 (sesiones de 9–12 h, límite práctico) y Oracle
  Always Free (2 OCPU / 12 GB) como salidas para URLs estables (vs. Cloudflare
  Quick Tunnel y ngrok free). `llama-swap` como proxy LRU de modelos locales.

## 5. Advertencias (del propio research)

- Coincidencia entre IAs ≠ evidencia; benchmarks auto-publicados engañan.
- «Heretic» pequeños ≈ calidad degradada; los benchmarks no lo reflejan.
- OneDrive + git → cuelgues; Kaggle pausado → procesos congelados; Cloudflare rota
  URLs cada pocas horas (ngrok estático u Oracle lo resuelven).
- La investigación precede a la implementación: **el código es la verdad** (ver
  `parity.md` e `informe-fases.md`). Si este doc y el código discrepan, gana el código.

## 6. Qué NO se construyó (y por qué)

`/fusion` (eliminado por decisión explícita, 2026-11-11), sub-agentes anidados,
WASM agent profiles, self-extension, self-update con watchdog, marketplace, ACP,
MCP nativo completo, `execute` de OpenCode v2. Ver «Fuera de alcance» en
`plan-hardening.md` y `parity.md`.
