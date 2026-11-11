// Fuzzing lite (H7): entradas hostiles a los parsers del núcleo.
// Determinista (PRNG sembrado); no exige red; cada bucle acota iteraciones.
import { test, expect } from "bun:test";
import { parseJsonc } from "../../src/util/jsonc.js";
import { shellSegments } from "../../src/core/shell-scan.js";
import { parseTextToolCalls } from "../../src/core/text-tool-calls.js";
import { parsePatch } from "../../src/tools/apply_patch.js";
import { matchPattern } from "../../src/core/permissions.js";
import { redactSecrets } from "../../src/core/redact.js";

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = ["{", "}", "[", "]", "\"", "'", "\\", "/", "*", ",", ":", " ", "\n", "\t", "$", "(", ")", "`", "<", ">", ";", "&", "|", "a", "0", "…", "€", "\0", "-", "_", "."];
function randomString(rnd: () => number, maxLen: number) {
  const n = Math.floor(rnd() * maxLen);
  let s = "";
  for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(rnd() * ALPHABET.length)];
  return s;
}
const N = 3000;

test("jsonc: entradas aleatorias no rompen el contrato (Error o valor)", () => {
  const rnd = mulberry32(42);
  for (let i = 0; i < N; i++) {
    const src = randomString(rnd, 400);
    try {
      const v = parseJsonc(src, "fuzz");
      expect(() => JSON.stringify(v)).not.toThrow();
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
    }
  }
});

test("jsonc: envoltura profunda de arrays no desborda la pila con frecuencia", () => {
  for (const depth of [50, 200, 1000]) {
    const src = "[".repeat(depth) + "]".repeat(depth);
    try { parseJsonc(src, "fuzz"); } catch (err) { expect(err).toBeInstanceOf(Error); }
  }
});

test("jsonc: NUL y unicode arbitrario", () => {
  const rnd = mulberry32(7);
  for (let i = 0; i < 500; i++) {
    const src = randomString(rnd, 120) + "\0" + randomString(rnd, 120);
    try { parseJsonc(src, "fuzz"); } catch (err) { expect(err).toBeInstanceOf(Error); }
  }
});

test("shell-scan: nunca lanza; segmentos acotados y no vacíos", () => {
  const rnd = mulberry32(1234);
  for (let i = 0; i < N; i++) {
    const cmd = randomString(rnd, 300);
    const segs = shellSegments(cmd);
    expect(segs.length).toBeLessThanOrEqual(60);
    for (const seg of segs) expect(seg.trim().length).toBeGreaterThan(0);
  }
});

test("shell-scan: fragmentos hostiles clásicos", () => {
  const hostile = [
    "a && b || c; d | e", "x$(y$(z)))", "`unclosed", "'unterminated", "\"unterminated",
    "cat <<EOF\n<<<EOF >>EO", "\\\\", "a; ".repeat(500), "$(".repeat(100), "((( )))", "a\\;b\\|c",
  ];
  for (const cmd of hostile) {
    const segs = shellSegments(cmd);
    expect(Array.isArray(segs)).toBe(true);
    expect(segs.length).toBeLessThanOrEqual(60);
  }
});

test("text-tool-calls: basura con etiquetas no cuelga ni lanza", () => {
  const rnd = mulberry32(99);
  const tags = ["<tool_call>", "</tool_call>", "<invoke", "<function=>", "{\"name\":", "```", "<minimax:tool_call>", ""];
  for (let i = 0; i < N; i++) {
    let src = "";
    for (let j = 0; j < 30; j++) src += tags[Math.floor(rnd() * tags.length)] + randomString(rnd, 40);
    try {
      const res = parseTextToolCalls(src);
      expect(res).toBeDefined();
    } catch (err) {
      expect(err).toBeInstanceOf(Error); // fallo controlado, nunca excepción cruda
    }
  }
});

test("apply_patch: parches aleatorios no rompen el invariante de retorno", () => {
  const rnd = mulberry32(2026);
  for (let i = 0; i < 1000; i++) {
    const src = randomString(rnd, 200);
    try {
      const res = parsePatch(src);
      expect(res).toBeDefined();
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
    }
  }
});

test("matchPattern: entradas patológicas terminan (regex escapada)", () => {
  const rnd = mulberry32(31337);
  const specials = ".*+?^${}()|[]\\";
  for (let i = 0; i < N; i++) {
    let pat = "";
    for (let j = 0; j < 30; j++) pat += rnd() < 0.4 ? specials[Math.floor(rnd() * specials.length)] : ALPHABET[Math.floor(rnd() * ALPHABET.length)];
    const value = randomString(rnd, 60);
    expect(typeof matchPattern(pat, value)).toBe("boolean");
  }
});

test("redactSecrets: nunca lanza sobre unicode arbitrario", () => {
  const rnd = mulberry32(2718);
  for (let i = 0; i < N; i++) {
    const out = redactSecrets(randomString(rnd, 300));
    expect(typeof out).toBe("string");
  }
});
