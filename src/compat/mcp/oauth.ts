// OAuth 2.1 para servidores MCP REMOTOS (HTTP). Spec: MCP 2025-11-25/2026-07-28
//   - RFC 9728 Protected Resource Metadata (descubrimiento del AS)
//   - RFC 8414 Authorization Server Metadata (+ OIDC openid-configuration fallback)
//   - RFC 7591 Dynamic Client Registration (CIMD requiere hosting público → fuera, v1)
//   - RFC 8707 resource indicators (obligatorio en /authorize y /token)
//   - PKCE S256 obligatorio (OAuth 2.1) · RFC 9207 iss verificado si el AS lo anuncia
//
// Seguridad:
//   - tokens en $XDG_DATA_HOME/nicotine/oauth.json (0600), clave: NOMBRE del servidor
//   - NUNCA se loguean tokens ni códigos; solo marcas de tiempo e ids
//   - loopback redirect (127.0.0.1, puerto efímero); state aleatorio; timeout
//   - refresh single-flight por proceso; si falla → error accionable («nicotine mcp auth <n>»)
//   - headers explícitos del usuario ganan sobre el token guardado

import { createServer, type Server } from "node:http";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, chmodSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { dataHome } from "../../core/session.js";
import type { McpServerDef } from "./types.js";

// ---------- almacenamiento ----------

export interface OAuthTokenEntry {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  /** epoch ms; 0 = sin expiración conocida */
  expires_at: number;
  scope?: string;
  client_id: string;
  client_secret?: string;
  /** issuer del authorization server (para refresh y RFC 9207) */
  issuer: string;
  /** resource canónico (RFC 8707) — la URL del servidor MCP */
  resource: string;
  updated_at: string;
}

interface OAuthStoreFile { servers: Record<string, OAuthTokenEntry> }

export function oauthPath(): string { return join(dataHome(), "oauth.json"); }

export function readOauthStore(): Record<string, OAuthTokenEntry> {
  try {
    if (!existsSync(oauthPath())) return {};
    const j = JSON.parse(readFileSync(oauthPath(), "utf8")) as OAuthStoreFile;
    return j?.servers && typeof j.servers === "object" ? j.servers : {};
  } catch { return {}; }
}

export function writeOauthEntry(name: string, entry: OAuthTokenEntry): void {
  mkdirSync(dataHome(), { recursive: true });
  const cur = readOauthStore();
  cur[name] = entry;
  const tmp = oauthPath() + ".tmp";
  writeFileSync(tmp, JSON.stringify({ servers: cur }, null, 2), "utf8");
  chmodSync(tmp, 0o600); // antes de renombrar: nunca existe con permisos amplios
  renameSync(tmp, oauthPath());
}

export function deleteOauthEntry(name: string): boolean {
  const cur = readOauthStore();
  if (!(name in cur)) return false;
  delete cur[name];
  mkdirSync(dataHome(), { recursive: true });
  const tmp = oauthPath() + ".tmp";
  writeFileSync(tmp, JSON.stringify({ servers: cur }, null, 2), "utf8");
  chmodSync(tmp, 0o600);
  renameSync(tmp, oauthPath());
  return true;
}

// ---------- discovery (RFC 9728 + RFC 8414 + OIDC) ----------

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
}

export interface AuthServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
}

async function fetchJson(url: string, timeoutMs: number, fetchImpl: typeof fetch, init?: RequestInit): Promise<{ status: number; json: Record<string, unknown> | null; text: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: ctrl.signal, redirect: "follow" });
    const text = await res.text();
    let json: Record<string, unknown> | null = null;
    try { json = text ? (JSON.parse(text) as Record<string, unknown>) : null; } catch { /* no-JSON */ }
    return { status: res.status, json, text };
  } finally { clearTimeout(timer); }
}

/** Candidatos RFC 9728: well-known en la raíz + con el path del recurso. */
export function protectedResourceMetadataUrls(resource: string): string[] {
  const u = new URL(resource);
  const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
  return [
    `${u.origin}/.well-known/oauth-protected-resource${path}`,
    `${u.origin}/.well-known/oauth-protected-resource`,
  ];
}

/** Candidatos RFC 8414 / OIDC para un issuer (con path si lo tiene). */
export function authServerMetadataUrls(issuer: string): string[] {
  const u = new URL(issuer);
  const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
  return [
    `${u.origin}/.well-known/oauth-authorization-server${path}`,
    `${u.origin}/.well-known/openid-configuration${path}`,
    `${u.origin}/.well-known/oauth-authorization-server`,
    `${u.origin}/.well-known/openid-configuration`,
  ];
}

export async function discoverProtectedResource(resource: string, fetchImpl: typeof fetch = fetch, timeoutMs = 10000): Promise<ProtectedResourceMetadata> {
  let lastErr = "sin respuesta";
  for (const url of protectedResourceMetadataUrls(resource)) {
    try {
      const { status, json } = await fetchJson(url, timeoutMs, fetchImpl);
      if (status !== 200 || !json) { lastErr = `HTTP ${status} en ${url}`; continue; }
      const authServers = json["authorization_servers"];
      if (!Array.isArray(authServers) || !authServers.length) { lastErr = `PRM sin «authorization_servers» en ${url}`; continue; }
      return {
        resource: String(json["resource"] ?? resource),
        authorization_servers: authServers.map(String).filter(Boolean),
        scopes_supported: Array.isArray(json["scopes_supported"]) ? json["scopes_supported"].map(String) : undefined,
      };
    } catch (err) { lastErr = `${(err as Error).message} (${url})`; }
  }
  throw new Error(`No se pudo descubrir el authorization server del recurso (RFC 9728): ${lastErr}`);
}

export async function discoverAuthServer(issuer: string, fetchImpl: typeof fetch = fetch, timeoutMs = 10000): Promise<AuthServerMetadata> {
  let lastErr = "sin respuesta";
  for (const url of authServerMetadataUrls(issuer)) {
    try {
      const { status, json } = await fetchJson(url, timeoutMs, fetchImpl);
      if (status !== 200 || !json) { lastErr = `HTTP ${status} en ${url}`; continue; }
      const authorization_endpoint = typeof json["authorization_endpoint"] === "string" ? json["authorization_endpoint"] : "";
      const token_endpoint = typeof json["token_endpoint"] === "string" ? json["token_endpoint"] : "";
      if (!authorization_endpoint || !token_endpoint) { lastErr = `metadata incompleta en ${url} (faltan authorization_endpoint/token_endpoint)`; continue; }
      return {
        issuer: String(json["issuer"] ?? issuer),
        authorization_endpoint,
        token_endpoint,
        registration_endpoint: typeof json["registration_endpoint"] === "string" ? json["registration_endpoint"] : undefined,
        scopes_supported: Array.isArray(json["scopes_supported"]) ? json["scopes_supported"].map(String) : undefined,
        code_challenge_methods_supported: Array.isArray(json["code_challenge_methods_supported"]) ? json["code_challenge_methods_supported"].map(String) : undefined,
      };
    } catch (err) { lastErr = `${(err as Error).message} (${url})`; }
  }
  throw new Error(`No se pudo descubrir la metadata del authorization server (RFC 8414): ${lastErr}`);
}

// ---------- PKCE y utilidades ----------

const b64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export const randomState = () => b64url(randomBytes(24));

export interface AuthorizationUrlParams {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  resource: string;   // RFC 8707
  scope?: string;
  state: string;
  codeChallenge: string;
}

export function buildAuthorizationUrl(p: AuthorizationUrlParams): string {
  const u = new URL(p.authorizationEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", p.clientId);
  u.searchParams.set("redirect_uri", p.redirectUri);
  u.searchParams.set("state", p.state);
  u.searchParams.set("code_challenge", p.codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("resource", p.resource);
  if (p.scope) u.searchParams.set("scope", p.scope);
  return u.toString();
}

// ---------- registro (RFC 7591 DCR; client_id por config gana) ----------

export async function registerClient(asm: AuthServerMetadata, redirectUri: string, fetchImpl: typeof fetch = fetch, timeoutMs = 15000): Promise<{ client_id: string; client_secret?: string }> {
  if (!asm.registration_endpoint) {
    throw new Error(`El authorization server no ofrece registration_endpoint. Configura «oauth.clientId» (y «oauth.clientSecret» si aplica) en la entrada del servidor MCP.`);
  }
  const { status, json, text } = await fetchJson(asm.registration_endpoint, timeoutMs, fetchImpl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "nicotine",
      client_uri: "https://github.com/chesterfieldpapi333-beep/nicotine",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
    }),
  });
  if (status < 200 || status >= 300 || !json || typeof json["client_id"] !== "string" || !json["client_id"]) {
    throw new Error(`registro dinámico rechazado (HTTP ${status}): ${text.slice(0, 200)}`);
  }
  return { client_id: String(json["client_id"]), client_secret: typeof json["client_secret"] === "string" ? json["client_secret"] : undefined };
}

// ---------- intercambio de tokens ----------

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_at: number;
  scope?: string;
}

function parseTokenResponse(json: Record<string, unknown> | null, text: string, status: number): TokenResponse {
  if (status < 200 || status >= 300 || !json || typeof json["access_token"] !== "string" || !json["access_token"]) {
    throw new Error(`el authorization server rechazó el intercambio (HTTP ${status}): ${text.slice(0, 200)}`);
  }
  const expiresIn = Number(json["expires_in"]);
  return {
    access_token: String(json["access_token"]),
    refresh_token: typeof json["refresh_token"] === "string" ? json["refresh_token"] : undefined,
    token_type: String(json["token_type"] ?? "Bearer"),
    expires_at: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0,
    scope: typeof json["scope"] === "string" ? json["scope"] : undefined,
  };
}

const formEnc = (fields: Record<string, string>) => Object.entries(fields).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");

export async function exchangeCode(asm: AuthServerMetadata, p: { code: string; redirectUri: string; clientId: string; clientSecret?: string; codeVerifier: string; resource: string }, fetchImpl: typeof fetch = fetch, timeoutMs = 15000): Promise<TokenResponse> {
  const { status, json, text } = await fetchJson(asm.token_endpoint, timeoutMs, fetchImpl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: formEnc({
      grant_type: "authorization_code",
      code: p.code,
      redirect_uri: p.redirectUri,
      client_id: p.clientId,
      ...(p.clientSecret ? { client_secret: p.clientSecret } : {}),
      code_verifier: p.codeVerifier,
      resource: p.resource, // RFC 8707
    }),
  });
  return parseTokenResponse(json, text, status);
}

const refreshInflight = new Map<string, Promise<OAuthTokenEntry>>();

export async function refreshAccessToken(name: string, entry: OAuthTokenEntry, fetchImpl: typeof fetch = fetch, timeoutMs = 15000): Promise<OAuthTokenEntry> {
  const key = name;
  const inflight = refreshInflight.get(key);
  if (inflight) return inflight;
  const promise = (async (): Promise<OAuthTokenEntry> => {
    if (!entry.refresh_token) throw new Error(`el token de «${name}» caducó y el servidor no emitió refresh_token; ejecuta «nicotine mcp auth ${name}»`);
    const asm = await discoverAuthServer(entry.issuer, fetchImpl, timeoutMs);
    const { status, json, text } = await fetchJson(asm.token_endpoint, timeoutMs, fetchImpl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: formEnc({
        grant_type: "refresh_token",
        refresh_token: entry.refresh_token,
        client_id: entry.client_id,
        ...(entry.client_secret ? { client_secret: entry.client_secret } : {}),
        resource: entry.resource,
      }),
    });
    const refreshed = parseTokenResponse(json, text, status);
    const next: OAuthTokenEntry = {
      ...entry,
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token ?? entry.refresh_token, // muchos AS no rotan
      token_type: refreshed.token_type,
      expires_at: refreshed.expires_at,
      scope: refreshed.scope ?? entry.scope,
      updated_at: new Date().toISOString(),
    };
    writeOauthEntry(name, next);
    return next;
  })();
  refreshInflight.set(key, promise);
  try { return await promise; } finally { refreshInflight.delete(key); }
}

/** Token válido para el servidor `def` (o null → hay que autorizar de nuevo). */
export async function getValidAccessToken(def: McpServerDef, fetchImpl: typeof fetch = fetch, opts: { forceRefresh?: boolean } = {}): Promise<string | null> {
  const store = readOauthStore();
  const entry = store[def.name];
  if (!entry) return null;
  const expired = entry.expires_at !== 0 && Date.now() > entry.expires_at - 60_000;
  if (opts.forceRefresh || expired) {
    try { return (await refreshAccessToken(def.name, entry, fetchImpl)).access_token; }
    catch { return null; }
  }
  return entry.access_token;
}

// ---------- timeout + loopback callback ----------

function b64urlEq(a: string, b: string): boolean {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

interface CallbackResult { code: string; state: string; iss?: string }

/** Espera GET /callback?code&state en 127.0.0.1:puerto 0. Rechaza con error claro. */
export function waitForCallback(timeoutMs: number): { server: Server; result: Promise<CallbackResult>; port: Promise<number> } {
  let resolvePort!: (p: number) => void;
  const portP = new Promise<number>((r) => { resolvePort = r; });
  let resolveResult!: (v: CallbackResult) => void, rejectResult!: (e: Error) => void;
  const result = new Promise<CallbackResult>((res, rej) => { resolveResult = res; rejectResult = rej; });
  const html = (ok: boolean, msg: string) =>
    `<!doctype html><meta charset="utf-8"><title>nicotine</title><body style="font-family:system-ui;max-width:40em;margin:4em auto"><h1>${ok ? "✓ Autorizado" : "✗ Error"}</h1><p>${msg}</p><p>Ya puedes cerrar esta ventana.</p></body>`;
  const server = createServer((req, res) => {
    try {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      if (u.pathname !== "/callback") { res.writeHead(404); res.end("not found"); return; }
      const code = u.searchParams.get("code") ?? "";
      const state = u.searchParams.get("state") ?? "";
      const iss = u.searchParams.get("iss") ?? undefined;
      const err = u.searchParams.get("error");
      if (err) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html(false, `el authorization server devolvió «${err}»${u.searchParams.get("error_description") ? `: ${u.searchParams.get("error_description")}` : ""}`));
        rejectResult(new Error(`autorización denegada/cancelada: ${err}`));
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html(true, "nicotine recibió la sesión correctamente."));
      resolveResult({ code, state, iss });
    } catch (err) {
      res.writeHead(500); res.end();
      rejectResult(err as Error);
    }
  });
  server.listen(0, "127.0.0.1", () => resolvePort((server.address() as { port: number }).port));
  const timer = setTimeout(() => rejectResult(new Error(`timeout (${Math.round(timeoutMs / 1000)}s) esperando el callback de OAuth`)), timeoutMs);
  result.finally(() => clearTimeout(timer));
  return { server, result, port: portP };
}

async function defaultOpenUrl(url: string): Promise<boolean> {
  const candidates: [string, string[]][] =
    process.platform === "darwin" ? [["open", [url]]] :
    process.platform === "win32" ? [["cmd", ["/c", "start", "", url]]] :
    [["xdg-open", [url]], ["gio", ["open", url]]];
  for (const [cmd, args] of candidates) {
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(cmd, args, { stdio: "ignore", detached: true });
        child.on("error", reject);
        child.on("spawn", () => { child.unref(); resolve(); });
      });
      return true;
    } catch { /* siguiente candidato */ }
  }
  return false;
}

export interface FlowOptions {
  def: McpServerDef;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Inyectable en tests: abre la URL de autorización. Defecto: xdg-open/open/start. */
  openUrl?: (url: string) => Promise<unknown>;
  /** Se llama con la URL para mostrarla al usuario (aunque openUrl funcione). */
  onUrl?: (url: string) => void;
  /** oauth.* de la entrada de config del servidor (clientId/clientSecret). */
  oauthConfig?: { clientId?: string; clientSecret?: string; scope?: string };
}

/**
 * Flujo completo: discovery → registro/reúso → navegador → callback → tokens → store.
 * Devuelve el resource canonizado. Lanza Error con mensaje accionable si algo falla.
 */
export async function runAuthorizationFlow(opts: FlowOptions): Promise<{ issuer: string; resource: string }> {
  const def = opts.def;
  if (def.transport.kind !== "http") throw new Error(`«${def.name}» es stdio: los servidores stdio usan env/headers, no OAuth`);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const resource = def.transport.url.replace(/\/$/, "");
  const timeoutMs = opts.timeoutMs ?? 180_000;

  const prm = await discoverProtectedResource(resource, fetchImpl);
  let lastDiscoveryErr: Error | null = null;
  let asm: AuthServerMetadata | null = null;
  for (const issuer of prm.authorization_servers) {
    try { asm = await discoverAuthServer(issuer, fetchImpl); break; }
    catch (err) { lastDiscoveryErr = err as Error; }
  }
  if (!asm) throw lastDiscoveryErr ?? new Error("ningún authorization server anunciado respondió");
  if (asm.code_challenge_methods_supported && !asm.code_challenge_methods_supported.includes("S256")) {
    throw new Error(`el authorization server no soporta PKCE S256 (anuncia: ${asm.code_challenge_methods_supported.join(", ")})`);
  }

  // loopback callback ANTES de DCR (redirect_uri con puerto real)
  const { server, result, port: portP } = waitForCallback(timeoutMs);
  const port = await portP;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const cfg = opts.oauthConfig ?? {};
  let clientId = cfg.clientId;
  let clientSecret = cfg.clientSecret;
  if (!clientId) {
    const registered = await registerClient(asm, redirectUri, fetchImpl).catch((err) => { server.close(); throw err; });
    clientId = registered.client_id;
    clientSecret = clientSecret ?? registered.client_secret;
  }

  const { verifier, challenge } = pkcePair();
  const state = randomState();
  const scope = cfg.scope ?? prm.scopes_supported?.join(" ") ?? asm.scopes_supported?.join(" ");
  const authUrl = buildAuthorizationUrl({ authorizationEndpoint: asm.authorization_endpoint, clientId, redirectUri, resource, scope, state, codeChallenge: challenge });
  opts.onUrl?.(authUrl);
  const opener = opts.openUrl ?? defaultOpenUrl;
  await opener(authUrl).catch(() => false);

  let cb: CallbackResult;
  try {
    cb = await result;
  } finally {
    server.close();
  }
  if (!b64urlEq(cb.state, state)) throw new Error("state no coincide (posible CSRF); no se intercambió ningún código");
  // RFC 9207: si el AS anuncia issuer y la respuesta trae iss, deben coincidir
  if (cb.iss && asm.issuer && cb.iss.replace(/\/$/, "") !== asm.issuer.replace(/\/$/, "")) {
    throw new Error(`iss «${cb.iss}» no coincide con el issuer esperado «${asm.issuer}» (RFC 9207); abortado`);
  }
  if (!cb.code) throw new Error("el callback no trajo `code`");

  const tokens = await exchangeCode(asm, { code: cb.code, redirectUri, clientId, clientSecret, codeVerifier: verifier, resource }, fetchImpl);
  writeOauthEntry(def.name, {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_type: tokens.token_type,
    expires_at: tokens.expires_at,
    scope: tokens.scope,
    client_id: clientId,
    client_secret: clientSecret,
    issuer: asm.issuer,
    resource,
    updated_at: new Date().toISOString(),
  });
  try { unlinkSync(oauthPath() + ".tmp"); } catch { /* no quedó tmp */ }
  return { issuer: asm.issuer, resource };
}
