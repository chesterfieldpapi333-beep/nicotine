// Chequeo de estilo local (H1): LF, sin CRLF, sin trailing whitespace,
// newline final, sin tabs en src/tests/scripts. Sin dependencias.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const ROOTS = ["src", "tests", "scripts", "docs", "examples"];
const EXTS = new Set([".ts", ".js", ".json", ".jsonc", ".md", ".sh", ".yml", ".yaml", ".txt"]);
const SKIP = new Set(["node_modules", ".git"]);

let failures = 0;
const fail = (f: string, why: string) => { failures++; console.error(`✗ ${f}: ${why}`); };

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (EXTS.has(extname(p))) yield p;
  }
}

for (const root of ROOTS) {
  let entries: Generator<string>;
  try { entries = walk(root); } catch { continue; }
  for (const file of entries) {
    const buf = readFileSync(file);
    const text = buf.toString("utf8");
    if (text.includes("\r\n") || text.includes("\r")) fail(file, "CRLF/CR (se espera LF)");
    if (!text.endsWith("\n")) fail(file, "sin newline final");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (/[ \t]+$/.test(lines[i])) fail(file, `trailing whitespace en línea ${i + 1}`);
      if (/\t/.test(lines[i]) && !file.endsWith(".md")) fail(file, `tab en línea ${i + 1}`);
    }
  }
}

if (failures > 0) { console.error(`\n${failures} problema(s) de estilo`); process.exit(1); }
console.log("✓ estilo OK (LF, sin trailing, newline final, sin tabs)");
