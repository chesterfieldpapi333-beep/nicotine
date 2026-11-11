// C6: perfil «minimal» --solo-bash — solo bash + solo-lectura (read/glob/grep/webfetch).
import { test, expect } from "bun:test";
import { ALL_TOOLS, SOLO_BASH_TOOL_NAMES, filterSoloBash } from "../src/tools/index.js";

test("filterSoloBash deja exactamente bash, read, glob, grep, webfetch", () => {
  const names = filterSoloBash(ALL_TOOLS).map((t) => t.name).sort();
  expect(names).toEqual([...SOLO_BASH_TOOL_NAMES].sort());
});

test("filterSoloBash excluye escritura y poder ilimitado (write/edit/apply_patch/task/plan/skill/websearch/vault)", () => {
  const names = new Set(filterSoloBash(ALL_TOOLS).map((t) => t.name));
  for (const forbidden of ["write", "edit", "apply_patch", "task", "plan-enter", "plan-exit", "skill", "websearch", "todowrite", "question", "list"]) {
    expect(names.has(forbidden)).toBe(false);
  }
});

test("los nombres de SOLO_BASH_TOOL_NAMES existen todos en ALL_TOOLS", () => {
  const all = new Set(ALL_TOOLS.map((t) => t.name));
  for (const n of SOLO_BASH_TOOL_NAMES) expect(all.has(n)).toBe(true);
});
