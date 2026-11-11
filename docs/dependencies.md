# Dependencias — nicotine

**Política:** el núcleo (`src/core`, tools, compat) **no añade dependencias de runtime**.
Cualquier excepción requiere discusión explícita en un issue/commit. Las versiones se
pinan exactas y el lockfile es la fuente de verdad (`bun.lock`, `bun install --frozen-lockfile`).

**Estado al 0.2.0 (2026-11-11):** 3 deps directas, 16 paquetes instalados, **0 scripts
lifecycle** (`bun pm untrusted` = 0), SBOM en `release/SBOM.json` (generado por
`scripts/verify-release.sh`).

| Paquete | Versión | Tipo | Para qué | Riesgo / notas |
|---|---|---|---|---|
| `@opentui/core` | 0.8.3 | runtime (opcional de facto) | Backend TUI por defecto; sin él la TUI cae a ANSI de respaldo | Paquete único de runtime; binarios nativos opcionales por plataforma (darwin/linux/win × x64/arm64, glibc y musl). Mantener al día |
| `bun-types` | 1.4.4 | dev | Tipos de Bun para `tsc --noEmit` | Sin runtime |
| `typescript` | 7.0.2 | dev | typecheck (`tsc --noEmit`) | Sin runtime |

**Transitivas relevantes de `@opentui/core`:** `bun-ffi-structs` (FFI), `diff` (9.0.0),
`marked` (17.0.1, markdown), `string-width` (7.2.0). `web-tree-sitter` es peer **opcional**
(no instalado). Todas pinadas en el lockfile con integridad sha512.

## Cómo re-auditar

```bash
bun pm untrusted            # scripts lifecycle (esperado: 0)
bun install --frozen-lockfile
bash scripts/verify-release.sh   # tsc + tests + SBOM + sumas in-repo
```

**Cobertura:** sin escáner de CVEs (sin telemetría y sin servicios externos por decisión
del proyecto); la defensa es perímetro mínimo + pinning + lockfile + revisión manual al
subir versiones. Si se adopta un escáner, debe poder correrse offline/localmente.
