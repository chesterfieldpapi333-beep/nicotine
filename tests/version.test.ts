import { describe, test, expect } from "bun:test";
import { VERSION } from "../src/util/version.js";
import pkg from "../package.json" with { type: "json" };

describe("VERSION — derivada de package.json (nunca hardcodeada)", () => {
  test("no está vacía ni es 0.0.0-unknown en el repo", () => {
    expect(VERSION).not.toBe("0.0.0-unknown");
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
  test("coincide exactamente con package.json", () => {
    expect(VERSION).toBe((pkg as { version: string }).version);
  });
});
