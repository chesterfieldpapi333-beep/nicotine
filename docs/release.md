# Release v0.2.0 — verificación sin binarios

> **Nota 2026-11-11:** el tag `v0.2.0` apunta a `2c377d7`. Tras cortarlo, la verificación
> H10 encontró un bug (`--readonly` + ruta fuera del proyecto caía en `ask` en vez de
> `deny`); está corregido en `a30fd7e` y master quedó en `bd7ee01` con sumas regeneradas.
> **Resuelto:** `v0.2.1` (2026-11-11) apunta al master con el fix; `v0.2.0` se mantiene como
> historia (pre-fix). Este doc describe el procedimiento para cualquiera de las dos.

**Qué es:** la publicación es el **código fuente**. No hay binarios, ni firmas, ni
releases en npm/winget, ni checksums publicados fuera del repo. Quien clona, verifica.

## Verificar desde el clone (recomendado: clone limpio, sin dependencias previas)

```bash
git clone https://github.com/chesterfieldpapi333-beep/nicotine.git
cd nicotine
git checkout v0.2.0
./scripts/verify-release.sh
```

El script hace, en orden: `bun install --frozen-lockfile` (cero red más allá del registry
implícito de bun), `tsc --noEmit`, `bun test` (405 tests), y **regenera**
`release/SHA256SUMS` + `release/SBOM.json`. Al terminar:

```bash
git status --porcelain release/   # esperado: vacío
```

Si aparece salida, el árbol no coincide con las sumas verificadas en el tag: **no usés
ese código**; abrí issue con el diff.

## Sumas SHA-256 in-repo (`release/SHA256SUMS`)

Cubre el árbol trackeado (182 archivos en el momento del tag; no incluye `release/` ni
artefactos de build). Para regenerar o contrastar:

```bash
git ls-files -z -- . ':!release' | LC_ALL=C sort -z | xargs -0 sha256sum > /tmp/SHA256SUMS.mine
diff <(cut -d' ' -f1 release/SHA256SUMS) <(cut -d' ' -f1 /tmp/SHA256SUMS.mine)   # esperado: vacío
sha256sum -c release/SHA256SUMS | grep -v ': OK$'                                 # esperado: nada
```

Orden determinista (`LC_ALL=C sort`), sin rutas absolutas, portable a GNU coreutils y
msys2/Git Bash.

## SBOM (`release/SBOM.json`)

Generada desde `bun.lock` **sin red** (`bun scripts/sbom.ts`). 42 paquetes con versión
fijada. Es inventario de dependencias, no attest‑ation: no afirma origen ni autenticidad.
Para inspección manual:

```bash
bun -e 'const s=JSON.parse(require("fs").readFileSync("release/SBOM.json","utf8"));console.log(s.packages.map(p=>p.name+"@"+p.version).join("\n"))'
```

## Qué NO hace esta release (honesto)

- No hay firma del tag ni de los commits (no hay clave establecida): autenticidad por
  HTTPS a GitHub + revisión de diff, nada más.
- No se auditan las dependencias con `bun pm audit` (no disponible en bun 1.4.4).
- `release/` es referencia in-repo: si el tag y las sumas no coinciden, prevalece el tag
  verificado por `git` (nadie lo mueve), no el archivo.

## Checklist de verificación rápida (trate como NOTAS de auditoría, no procedimentales)

1. `git rev-parse HEAD` == `git rev-parse v0.2.0`.
2. `./scripts/verify-release.sh` termina con `OK: release/SHA256SUMS ... SBOM.json ...`.
3. `git status --porcelain release/` vacío.
4. `git fsck --no-dangling` sin errores de conectividad.
