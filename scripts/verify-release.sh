#!/usr/bin/env bash
# Verificación de release desde un clon limpio: instala con lockfile congelado,
# typechecks, tests y genera release/SHA256SUMS + release/SBOM.json (in-repo;
# sin publicar, sin binarios, sin releases firmados).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

echo "== bun install --frozen-lockfile"
bun install --frozen-lockfile

echo "== tsc --noEmit"
bun x tsc --noEmit

echo "== bun test"
bun test

echo "== release/SHA256SUMS (árbol trackeado, sin release/)"
mkdir -p release
git ls-files -z -- . ':!release' | LC_ALL=C sort -z | xargs -0 sha256sum > release/SHA256SUMS

echo "== release/SBOM.json (desde bun.lock, sin red)"
bun scripts/sbom.ts > release/SBOM.json

echo ""
echo "OK: release/SHA256SUMS ($(wc -l < release/SHA256SUMS) archivos) y release/SBOM.json ($(bun -e 'const s=JSON.parse(require("fs").readFileSync("release/SBOM.json","utf8"));console.log(s.packages.length)') paquetes)."
echo "Sin binarios, sin firmas, sin publicación: la verificación la rehace quien clona (docs/release.md)."
