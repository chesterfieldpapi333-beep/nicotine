// OAuth 2.1 (PKCE S256 + RFC 8707 + RFC 9728/8414/7591) contra un AS+RS SIMULADO
// en 127.0.0.1 — ni un byte a la red real. Cobertura:
//   discovery PRM/ASM · flujo completo (DCR → navegador simulado → callback → tokens 0600)
//   · refresh automático al caducar · inyección de Bearer en el cliente MCP
//   · 401 → refresh → reintento (una vez)
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverProtectedResource, discoverAuthServer, runAuthorizationFlow, readOauthStore, getValidAccessToken, deleteOauthEntry, oauthPath } from "../src/compat/mcp/oauth.js";
import { McpClient } from "../src/compat/mcp/client.js";
import type { McpServerDef } from "../src/compat/mcp/types.js";

interface MockState {
  clients: Map<string, string>;
  codes: Map<string, { challenge: string; clientId: string; resource: string }>;
  acceptedBearers: Set<string>;
  counter: number;
  refreshGrants: number;
  authorizeCalls: number;
  tokenCalls: number;
  mcpCalls: { auth: string | undefined }[];
}

function startMock(): Promise<{ server: Server; url: string; state: MockState; close: () => Promise<void> }> {
  const state: MockState = { clients: new Map(), codes: new Map(), acceptedBearers: new Set(), counter: 0, refreshGrants: 0, authorizeCalls: 0, tokenCalls: 0, mcpCalls: [] };
  const issuerHolder: { issuer: string | null } = { issuer: null };
  const json = (res: any, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const readForm = (req: any) => new Promise<string>((resolve) => { let b = ""; req.on("data", (c: Buffer) => (b += c)); req.on("end", () => resolve(b)); });
  const readJson = (req: any) => new Promise<any>((resolve) => { let b = ""; req.on("data", (c: Buffer) => (b += c)); req.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve({}); } }); });

  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = u.pathname;
    // ---- Protected Resource Metadata (RFC 9728) ----
    if (path === "/.well-known/oauth-protected-resource/mcp" || path === "/.well-known/oauth-protected-resource") {
      return json(res, 200, { resource: `${issuerHolder.issuer}/mcp`, authorization_servers: [issuerHolder.issuer], scopes_supported: ["mcp"] });
    }
    // ---- Authorization Server Metadata (RFC 8414) ----
    if (path === "/.well-known/oauth-authorization-server") {
      return json(res, 200, {
        issuer: issuerHolder.issuer,
        authorization_endpoint: `${issuerHolder.issuer}/authorize`,
        token_endpoint: `${issuerHolder.issuer}/token`,
        registration_endpoint: `${issuerHolder.issuer}/register`,
        scopes_supported: ["mcp"],
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "refresh_token"],
      });
    }
    // ---- DCR (RFC 7591) ----
    if (path === "/register" && req.method === "POST") {
      const body = await readJson(req);
      const id = `client-${++state.counter}`;
      state.clients.set(id, JSON.stringify(body));
      return json(res, 201, { client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000), redirect_uris: body.redirect_uris, token_endpoint_auth_method: "none" });
    }
    // ---- /authorize → 302 con code (simula consentimiento) ----
    if (path === "/authorize") {
      state.authorizeCalls++;
      const redirect = u.searchParams.get("redirect_uri");
      const stateParam = u.searchParams.get("state");
      const challenge = u.searchParams.get("code_challenge");
      const resource = u.searchParams.get("resource");
      const clientId = u.searchParams.get("client_id") ?? "";
      if (u.searchParams.get("code_challenge_method") !== "S256" || !challenge || !redirect || !stateParam || !clientId || !resource) return json(res, 400, { error: "bad_request" });
      const code = `code-${++state.counter}`;
      state.codes.set(code, { challenge, clientId, resource });
      const loc = `${redirect}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(stateParam)}&iss=${encodeURIComponent(issuerHolder.issuer!)}`;
      res.writeHead(302, { location: loc });
      return res.end();
    }
    // ---- /token ----
    if (path === "/token" && req.method === "POST") {
      state.tokenCalls++;
      const form = new URLSearchParams(await readForm(req));
      if (form.get("grant_type") === "authorization_code") {
        const rec = state.codes.get(form.get("code") ?? "");
        if (!rec) return json(res, 400, { error: "invalid_grant" });
        const { createHash } = await import("node:crypto");
        const digest = createHash("sha256").update(form.get("code_verifier") ?? "").digest().toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        if (digest !== rec.challenge) return json(res, 400, { error: "invalid_grant", error_description: "pkce mismatch" });
        if (form.get("resource") !== rec.resource) return json(res, 400, { error: "invalid_target" });
        const at = `at-${++state.counter}`, rt = `rt-${state.counter}`;
        state.acceptedBearers.add(at);
        return json(res, 200, { access_token: at, refresh_token: rt, token_type: "Bearer", expires_in: 3600, scope: "mcp" });
      }
      if (form.get("grant_type") === "refresh_token") {
        state.refreshGrants++;
        const at = `at-refreshed-${++state.counter}`;
        state.acceptedBearers.add(at);
        return json(res, 200, { access_token: at, token_type: "Bearer", expires_in: 3600, scope: "mcp" });
      }
      return json(res, 400, { error: "unsupported_grant_type" });
    }
    // ---- el «servidor MCP» (resource server) ----
    if (path === "/mcp" && req.method === "POST") {
      const auth = req.headers.authorization as string | undefined;
      state.mcpCalls.push({ auth });
      const token = auth?.replace(/^Bearer /, "");
      if (!token || !state.acceptedBearers.has(token)) {
        res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${issuerHolder.issuer}/.well-known/oauth-protected-resource"`, "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "invalid_token" }));
      }
      const body = (await readJson(req)) as { id?: number; method?: string };
      const rpc = (result: unknown) => json(res, 200, { jsonrpc: "2.0", id: body.id ?? null, result });
      if (body.method === "initialize") return rpc({ protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "mock", version: "1.0.0" } });
      if (body.method === "notifications/initialized") { res.writeHead(202); return res.end(); }
      if (body.method === "tools/list") return rpc({ tools: [{ name: "ping", description: "ping", inputSchema: { type: "object", properties: {} } }] });
      if (body.method === "tools/call") return rpc({ content: [{ type: "text", text: "pong" }] });
      return json(res, 200, { jsonrpc: "2.0", id: body.id ?? null, error: { code: -32601, message: "método desconocido" } });
    }
    return json(res, 404, { error: "not_found" });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      issuerHolder.issuer = `http://127.0.0.1:${port}`;
      resolve({ server, url: issuerHolder.issuer, state, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

let mock: Awaited<ReturnType<typeof startMock>>;
let tmp: string;
let savedXDG: string | undefined;
let def: McpServerDef;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "vireo-oauth-"));
  savedXDG = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = join(tmp, "data");
  mock = await startMock();
  def = { name: "mock-remote", origin: "global", transport: { kind: "http", url: `${mock.url}/mcp`, headers: {} }, protocol: "legacy", startupTimeoutMs: 5000, catalogTimeoutMs: 5000, executionTimeoutMs: 5000, enabled: true };
});

afterEach(async () => {
  await mock.close();
  if (savedXDG === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = savedXDG;
});

describe("discovery (RFC 9728 + RFC 8414)", () => {
  test("PRM → AS; ASM → endpoints completos", async () => {
    const prm = await discoverProtectedResource(`${mock.url}/mcp`);
    expect(prm.authorization_servers).toEqual([mock.url]);
    expect(prm.scopes_supported).toEqual(["mcp"]);
    const asm = await discoverAuthServer(mock.url);
    expect(asm.issuer).toBe(mock.url);
    expect(asm.authorization_endpoint).toBe(`${mock.url}/authorize`);
    expect(asm.token_endpoint).toBe(`${mock.url}/token`);
    expect(asm.registration_endpoint).toBe(`${mock.url}/register`);
  });
});

describe("flujo completo (DCR → navegador simulado → callback → store)", () => {
  test("emite token, persiste en oauth.json 0600 y encadena resource RFC 8707", async () => {
    const issued = await runAuthorizationFlow({
      def,
      openUrl: async (url) => { await fetch(url, { redirect: "follow" }); }, // «navegador»: sigue al 302 de /authorize hasta el callback loopback
      timeoutMs: 8000,
    });
    expect(issued.resource).toBe(`${mock.url}/mcp`);
    expect(mock.state.authorizeCalls).toBe(1);
    expect(mock.state.tokenCalls).toBe(1);
    const store = readOauthStore();
    expect(store["mock-remote"]).toBeDefined();
    expect(store["mock-remote"].access_token).toMatch(/^at-/);
    expect(store["mock-remote"].refresh_token).toMatch(/^rt-/);
    expect(store["mock-remote"].resource).toBe(`${mock.url}/mcp`);
    expect(statSync(oauthPath()).mode & 0o777).toBe(0o600);
  });
});

describe("getValidAccessToken (refresh al caducar)", () => {
  test("token caducado → refresh_token grant → nuevo access_token y store actualizado", async () => {
    await runAuthorizationFlow({ def, openUrl: async (url) => { await fetch(url, { redirect: "follow" }); }, timeoutMs: 8000 });
    // forzar caducidad
    const store = readOauthStore();
    const entry = store["mock-remote"];
    entry.expires_at = Date.now() - 1000;
    writeFileSync(oauthPath(), JSON.stringify({ servers: { "mock-remote": entry } }), "utf8");
    const token = await getValidAccessToken(def);
    expect(token).toMatch(/^at-refreshed-/);
    expect(mock.state.refreshGrants).toBe(1);
    expect(readOauthStore()["mock-remote"].access_token).toBe(token as string);
  });
});

describe("McpClient: inyección Bearer + 401 → refresh → reintento único", () => {
  test("token stale → 401 → refresh → reintento 200; initialize y tools/call funcionan", async () => {
    await runAuthorizationFlow({ def, openUrl: async (url) => { await fetch(url, { redirect: "follow" }); }, timeoutMs: 8000 });
    // envenenar el access_token guardado (no está en acceptedBearers)
    const store = readOauthStore();
    const entry = store["mock-remote"];
    entry.access_token = "at-stale";
    entry.expires_at = 0; // sin caducidad → sin refresh previo; el 401 fuerza refresh
    writeFileSync(oauthPath(), JSON.stringify({ servers: { "mock-remote": entry } }), "utf8");

    const client = new McpClient(def);
    const negotiated = await client.connect();
    expect(negotiated).toBe("legacy");
    const res = await client.callTool("ping", {});
    expect(res.text).toBe("pong");
    expect(mock.state.refreshGrants).toBe(1);
    // todas las llamadas llevaron bearer; alguna fue el at-stale (la primera) y el resto el nuevo
    const auths = mock.state.mcpCalls.map((c) => c.auth);
    expect(auths.some((a) => a === "Bearer at-stale")).toBe(true);
    expect(auths.filter((a) => a === "Bearer at-stale").length).toBe(1); // solo la primera
    await client.close();
  });

  test("sin token guardado y sin refresh posible → error accionable con «vireo mcp auth»", async () => {
    deleteOauthEntry("mock-remote");
    const client = new McpClient(def);
    await expect(client.connect()).rejects.toThrow(/vireo mcp auth mock-remote/);
    await client.close().catch(() => {});
  });
});
