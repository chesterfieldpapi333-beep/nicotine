// mDNS/DNS-SD (Zeroconf) para `nicotine serve` — CERO dependencias (node:dgram).
//
// Diseño propio y *best-effort*: anuncia nicotine como servicio DNS-SD
// `_nicotine._tcp.<dominio>` (por defecto `nicotine.local`). NO es un resolver ni un
// stack mDNS completo: sin caché, no responde por otros dominios, no hace goodbye
// en caídas duras (solo en cierre limpio con stop()). Si 5353 está ocupado, la
// máquina no tiene multicast o el sandbox lo bloquea → aviso y serve sigue
// SIN anuncio (nunca rompe el arranque).
//
// Registros (PTR/SRV/TXT/A):
//   _services._dns-sd._udp.local. PTR → <service>.<domain>.
//   <service>.<domain>.           PTR → <instancia>.<service>.<domain>.
//   <instancia>.<service>.<domain>. SRV → puerto HTTP, target <host>.<domain>.
//   <instancia>.<service>.<domain>. TXT → path=... · version=... · api=nicotine-serve-1
//   <host>.<domain>.              A   → IPv4 no-loopback (127.0.0.1 si no hay)
// Al cerrar: goodbye (mismos registros con TTL 0, RFC 6762 §10.1).

import dgram from "node:dgram";
import os from "node:os";

const TYPE = { A: 1, PTR: 12, TXT: 16, SRV: 33, ANY: 255 } as const;
const CLASS_IN = 1;
const QU_BIT = 0x8000;
const CACHE_FLUSH = 0x8000;
const MDNS_ADDR = "224.0.0.251";
const MDNS_PORT = 5353;

export interface MdnsOptions {
  /** Puerto mDNS (defecto 5353; los tests usan puertos efímeros). */
  port?: number;
  /** false = sin multicast (tests: solo unicast en bindAddress). Defecto true. */
  multicast?: boolean;
  bindAddress?: string;
  /** Tipo DNS-SD, con guion bajo inicial. Defecto "_nicotine._tcp". */
  serviceType?: string;
  /** Dominio. Defecto "nicotine.local". Se valida (etiquetas ≤ 63 bytes). */
  domain?: string;
  /** Etiqueta de la instancia; por defecto el hostname saneado. */
  instanceLabel?: string;
  hostLabel?: string;
  /** IPv4 para el registro A (defecto: primera no-loopback; 127.0.0.1 si no hay). */
  hostIPv4?: string;
  /** Puerto HTTP del servicio (SRV). Obligatorio. */
  httpPort: number;
  path?: string;
  ttl?: number;
  logger?: (msg: string) => void;
}

export interface DnsQuestion { name: string; type: number; class: number; qu: boolean; raw: Buffer }

const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n & 0xffff); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };

export function encodeName(name: string): Buffer {
  const chunks: Buffer[] = [];
  for (const label of name.replace(/\.$/, "").split(".")) {
    const b = Buffer.from(label, "utf8");
    if (b.length === 0) throw new Error(`etiqueta DNS vacía en «${name}»`);
    if (b.length > 63) throw new Error(`etiqueta DNS demasiado larga en «${name}»: ${label}`);
    chunks.push(Buffer.from([b.length]), b);
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

export function decodeName(buf: Buffer, offset: number): { name: string; offset: number } {
  const labels: string[] = [];
  let o = offset, end = offset, jumped = false, guard = 0;
  for (;;) {
    if (++guard > 128) throw new Error("nombre DNS demasiado profundo");
    if (o >= buf.length) throw new Error("nombre DNS truncado");
    const len = buf[o];
    if (len === 0) { o += 1; if (!jumped) end = o; break; }
    if ((len & 0xc0) === 0xc0) {
      if (o + 1 >= buf.length) throw new Error("puntero DNS truncado");
      const ptr = ((len & 0x3f) << 8) | buf[o + 1];
      if (!jumped) end = o + 2;
      o = ptr; jumped = true; continue;
    }
    if (o + 1 + len > buf.length) throw new Error("etiqueta DNS truncada");
    labels.push(buf.toString("utf8", o + 1, o + 1 + len));
    o += 1 + len;
  }
  return { name: labels.join(".") + ".", offset: jumped ? end : o };
}

/** Parsea un mensaje DNS de entrada (solo preguntas; las respuestas se ignoran). */
export function parseDnsMessage(buf: Buffer): { id: number; flags: number; questions: DnsQuestion[] } {
  if (buf.length < 12) throw new Error("mensaje DNS truncado");
  const id = buf.readUInt16BE(0), flags = buf.readUInt16BE(2), qd = buf.readUInt16BE(4);
  const questions: DnsQuestion[] = [];
  let o = 12;
  for (let i = 0; i < qd; i++) {
    const start = o;
    const { name, offset } = decodeName(buf, o);
    o = offset;
    if (o + 4 > buf.length) throw new Error("pregunta DNS truncada");
    const type = buf.readUInt16BE(o), clsRaw = buf.readUInt16BE(o + 2);
    o += 4;
    questions.push({ name, type, class: clsRaw & 0x7fff, qu: (clsRaw & QU_BIT) !== 0, raw: buf.subarray(start, o) });
  }
  return { id, flags, questions };
}

interface Rr {
  name: string; type: number; cacheFlush: boolean; ttl: number; rdata: Buffer;
}
const rr = (r: Rr): Buffer => Buffer.concat([
  encodeName(r.name), u16(r.type), u16(r.cacheFlush ? CLASS_IN | CACHE_FLUSH : CLASS_IN), u32(r.ttl), u16(r.rdata.length), r.rdata,
]);

function txtRdata(entries: Record<string, string>): Buffer {
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(entries)) {
    const b = Buffer.from(`${k}=${v}`, "utf8");
    if (b.length > 255) throw new Error(`entrada TXT demasiado larga: ${k}`);
    chunks.push(Buffer.from([b.length]), b);
  }
  return Buffer.concat(chunks);
}

function srvRdata(port: number, target: string): Buffer {
  return Buffer.concat([u16(0), u16(0), u16(port), encodeName(target)]);
}

export interface MdnsNames {
  serviceFqdn: string;
  instanceFqdn: string;
  targetFqdn: string;
}

export function sanitizeLabel(raw: string, fallback: string, max = 48): string {
  const clean = raw.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, max);
  return clean || fallback;
}

export function validateDomain(domain: string): string {
  const d = domain.replace(/\.$/, "");
  if (!d || d.length > 253) throw new Error(`dominio mDNS inválido: «${domain}»`);
  for (const label of d.split(".")) {
    if (!label || label.length > 63 || !/^[a-zA-Z0-9-]+$/.test(label) || label.startsWith("-") || label.endsWith("-")) {
      throw new Error(`dominio mDNS inválido: etiqueta «${label}» — usa letras, dígitos y guiones (≤ 63 bytes)`);
    }
  }
  return d;
}

export class MdnsAnnouncer {
  private socket: dgram.Socket | null = null;
  private readonly o: {
    multicast: boolean;
    bindAddress?: string;
    port?: number;
    serviceType: string;
    domain: string;
    httpPort: number;
    path: string;
    ttl: number;
  };
  readonly names: MdnsNames;
  private readonly log: (msg: string) => void;
  private readonly hostIPv4: string;

  constructor(opts: MdnsOptions) {
    const domain = validateDomain(opts.domain ?? "nicotine.local");
    const serviceType = (opts.serviceType ?? "_nicotine._tcp").replace(/\.$/, "");
    if (!/^_[a-zA-Z0-9-]+(\._(tcp|udp))$/.test(serviceType)) throw new Error(`serviceType mDNS inválido: «${serviceType}» (esperado _nombre._tcp | _nombre._udp)`);
    const hostLabel = sanitizeLabel(opts.hostLabel ?? os.hostname(), "nicotine", 40);
    const instanceLabel = sanitizeLabel(opts.instanceLabel ?? `nicotine-${hostLabel}`, "nicotine", 40);
    const hostIPv4 = opts.hostIPv4 ?? firstPublicIPv4() ?? "127.0.0.1";
    this.o = {
      multicast: opts.multicast ?? true,
      bindAddress: opts.bindAddress,
      port: opts.port,
      serviceType,
      domain,
      httpPort: opts.httpPort,
      path: opts.path ?? "/",
      ttl: opts.ttl ?? 120,
    };
    this.log = opts.logger ?? ((m) => process.stderr.write(`[mdns] ${m}\n`));
    this.hostIPv4 = hostIPv4;
    this.names = {
      serviceFqdn: `${serviceType}.${domain}.`,
      instanceFqdn: `${instanceLabel}.${serviceType}.${domain}.`,
      targetFqdn: `${hostLabel}.${domain}.`,
    };
  }

  private txtRecord(ttl: number): Rr {
    return { name: this.names.instanceFqdn, type: TYPE.TXT, cacheFlush: true, ttl, rdata: txtRdata({ path: this.o.path ?? "/", api: "nicotine-serve-1", version: "0.2.0" }) };
  }
  private srvRecord(ttl: number): Rr {
    return { name: this.names.instanceFqdn, type: TYPE.SRV, cacheFlush: true, ttl, rdata: srvRdata(this.o.httpPort, this.names.targetFqdn) };
  }
  private aRecord(ttl: number): Rr {
    const ip = this.hostIPv4.split(".").map((n) => Number.parseInt(n, 10));
    return { name: this.names.targetFqdn, type: TYPE.A, cacheFlush: true, ttl, rdata: Buffer.from(ip.length === 4 && ip.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? ip : [127, 0, 0, 1]) };
  }
  private ptrEnumRecord(ttl: number): Rr {
    return { name: "_services._dns-sd._udp.local.", type: TYPE.PTR, cacheFlush: false, ttl, rdata: encodeName(this.names.serviceFqdn) };
  }
  private ptrRecord(ttl: number): Rr {
    return { name: this.names.serviceFqdn, type: TYPE.PTR, cacheFlush: false, ttl, rdata: encodeName(this.names.instanceFqdn) };
  }

  private records(ttl: number): Rr[] {
    return [this.ptrEnumRecord(ttl), this.ptrRecord(ttl), this.srvRecord(ttl), this.txtRecord(ttl), this.aRecord(ttl)];
  }

  /** Construye la respuesta para un mensaje de consulta (null = nada que responder). */
  buildResponseFor(msg: Buffer): Buffer | null {
    let id = 0, qdcount = 0;
    let questions: DnsQuestion[];
    try {
      const parsed = parseDnsMessage(msg);
      if (parsed.flags & 0x8000) return null; // es una respuesta, no una pregunta
      questions = parsed.questions.filter((q) => q.class === CLASS_IN || q.class === 255);
      id = parsed.id;
      qdcount = questions.length;
    } catch { return null; }
    if (!qdcount) return null;

    const ttl = this.o.ttl;
    const answers = new Map<string, Rr>();
    const add = (r: Rr) => answers.set(`${r.name}|${r.type}|${r.rdata.toString("hex")}`, r);
    for (const q of questions) {
      const qn = q.name.toLowerCase(), st = this.names.serviceFqdn.toLowerCase(), inst = this.names.instanceFqdn.toLowerCase(), tgt = this.names.targetFqdn.toLowerCase();
      const wants = (t: number) => q.type === TYPE.ANY || q.type === t;
      if (wants(TYPE.PTR)) {
        if (qn === "_services._dns-sd._udp.local.") { add(this.ptrEnumRecord(ttl)); add(this.ptrRecord(ttl)); }
        else if (qn === st) add(this.ptrRecord(ttl));
      }
      if (wants(TYPE.SRV) && qn === inst) add(this.srvRecord(ttl));
      if (wants(TYPE.TXT) && qn === inst) add(this.txtRecord(ttl));
      if (wants(TYPE.A) && qn === tgt) add(this.aRecord(ttl));
    }
    if (!answers.size) return null;
    // additionals: SRV/TXT/A acompañando al PTR (descubrimiento en un solo paso)
    const list = [...answers.values()];
    const hasPtr = list.some((r) => r.type === TYPE.PTR);
    const additionals: Rr[] = [];
    if (hasPtr) {
      for (const r of [this.srvRecord(ttl), this.txtRecord(ttl), this.aRecord(ttl)]) {
        if (!answers.has(`${r.name}|${r.type}|${r.rdata.toString("hex")}`)) additionals.push(r);
      }
    }
    const header = Buffer.concat([u16(0), u16(0x8400), u16(qdcount), u16(list.length), u16(0), u16(additionals.length)]);
    return Buffer.concat([header, ...questions.map((q) => q.raw), ...list.map(rr), ...additionals.map(rr)]);
  }

  /** Arranca el socket y envía el anuncio inicial (×2). false si no se pudo. */
  start(): Promise<boolean> {
    return new Promise((resolve) => {
      const port = this.o.port ?? MDNS_PORT;
      const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
      const fail = (msg: string) => { this.log(`mDNS no disponible (${msg}); serve sigue sin anuncio`); try { socket.close(); } catch { /* noop */ } this.socket = null; resolve(false); };
      socket.on("error", (err) => { this.log(`error de socket mDNS: ${err.message}`); });
      socket.bind(port, this.o.multicast ? undefined : (this.o.bindAddress ?? "127.0.0.1"), () => {
        try {
          if (this.o.multicast) {
            socket.addMembership(MDNS_ADDR);
            socket.setMulticastTTL(255);
          }
        } catch (err) {
          fail((err as Error).message);
          return;
        }
        socket.on("message", (msg, rinfo) => this.onQuery(msg, rinfo));
        this.socket = socket;
        this.announce();
        setTimeout(() => this.announce(), 250).unref();
        this.log(`anunciando ${this.names.instanceFqdn} → ${this.names.targetFqdn}:${this.o.httpPort}`);
        resolve(true);
      });
    });
  }

  private announce(goodbye = false): void {
    const socket = this.socket;
    if (!socket) return;
    const ttl = goodbye ? 0 : this.o.ttl;
    const answers = this.records(ttl);
    const packet = Buffer.concat([
      Buffer.concat([u16(0), u16(0x8400), u16(0), u16(answers.length), u16(0), u16(0)]),
      ...answers.map(rr),
    ]);
    const dest = this.o.multicast ? { port: MDNS_PORT, addr: MDNS_ADDR } : { port: this.o.port ?? MDNS_PORT, addr: this.o.bindAddress ?? "127.0.0.1" };
    try { socket.send(packet, dest.port, dest.addr, (err) => { if (err) this.log(`anuncio mDNS no enviado: ${err.message}`); }); } catch (err) { this.log(`anuncio mDNS falló: ${(err as Error).message}`); }
  }

  private onQuery(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    // Nunca procesamos paquetes que no sean queries IN (evita bucles: nuestros
    // propios anuncios son respuestas con QR=1 y flags 0x8400).
    const response = this.buildResponseFor(msg);
    if (!response) return;
    const unicast = this.o.multicast === false || (() => { try { return parseDnsMessage(msg).questions.some((q) => q.qu); } catch { return false; } })();
    try {
      if (unicast) { this.socket?.send(response, rinfo.port, rinfo.address); return; }
      this.socket?.send(response, MDNS_PORT, MDNS_ADDR);
    } catch (err) { this.log(`respuesta mDNS falló: ${(err as Error).message}`); }
  }

  /** Puerto efectivo del socket (tests) o null si no arrancó. */
  port(): number | null {
    try { const a = this.socket?.address(); return a && typeof a === "object" ? a.port : null; } catch { return null; }
  }

  /** Goodbye (TTL 0) y cierre. Nunca lanza. */
  async stop(): Promise<void> {
    const socket = this.socket;
    if (!socket) return;
    try { this.announce(true); } catch { /* goodbye es best-effort */ }
    await new Promise<void>((resolve) => { try { socket.close(() => resolve()); } catch { resolve(); } });
    this.socket = null;
  }
}

function firstPublicIPv4(): string | undefined {
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list ?? []) {
        if (ni.family === "IPv4" && !ni.internal) return ni.address;
      }
    }
  } catch { /* sin interfaces legibles */ }
  return undefined;
}
