// mDNS/DNS-SD para `nicotine serve` (item «mDNS» de «todo»): codec DNS propio +
// anunciador best-effort. En el sandbox no hay red multicast fiable: los tests
// usan unicast 127.0.0.1 (QU bit) y verifican el wire format directamente.
import { test, expect, describe } from "bun:test";
import dgram from "node:dgram";
import { MdnsAnnouncer, parseDnsMessage, decodeName, encodeName, sanitizeLabel, validateDomain } from "../src/compat/mdns.js";

const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };

function craftQuery(name: string, qtype: number, qu = true): Buffer {
  const qclass = qu ? 0x8001 : 0x0001; // QU bit → respuesta unicast
  return Buffer.concat([u16(0), u16(0), u16(1), u16(0), u16(0), u16(0), encodeName(name), u16(qtype), u16(qclass)]);
}

function parseAnswers(buf: Buffer): { questions: { name: string; type: number }[]; answers: { name: string; type: number; ttl: number; rdata: Buffer }[]; additionals: { name: string; type: number }[] } {
  const p = parseDnsMessage(buf);
  let o = 12;
  for (let i = 0; i < p.questions.length; i++) {
    const { offset } = decodeName(buf, o);
    o = offset + 4;
  }
  const readRrs = (count: number) => {
    const out: { name: string; type: number; ttl: number; rdata: Buffer }[] = [];
    for (let i = 0; i < count; i++) {
      const { name, offset } = decodeName(buf, o);
      const type = buf.readUInt16BE(offset), cls = buf.readUInt16BE(offset + 2), ttl = buf.readUInt32BE(offset + 4), rdlen = buf.readUInt16BE(offset + 8);
      const rdataStart = offset + 10;
      out.push({ name, type, ttl, rdata: buf.subarray(rdataStart, rdataStart + rdlen) });
      o = rdataStart + rdlen;
    }
    return out;
  };
  const ancount = buf.readUInt16BE(6), arcount = buf.readUInt16BE(10);
  const answers = readRrs(ancount);
  const additionals = readRrs(arcount).map(({ name, type }) => ({ name, type }));
  return { questions: p.questions.map((q) => ({ name: q.name, type: q.type })), answers, additionals };
}

describe("mdns — codec y validación (puro)", () => {
  test("encodeName/decodeName round-trip", () => {
    const buf = encodeName("_nicotine._tcp.nicotine.local.");
    const { name } = decodeName(buf, 0);
    expect(name).toBe("_nicotine._tcp.nicotine.local.");
  });

  test("validateDomain acepta dominios correctos y rechaza basura", () => {
    expect(validateDomain("nicotine.local")).toBe("nicotine.local");
    expect(validateDomain("lan.example.com.")).toBe("lan.example.com");
    expect(() => validateDomain("bad domain!")).toThrow();
    expect(() => validateDomain("-bad.local")).toThrow();
    expect(() => validateDomain("a.".repeat(90) + ".local")).toThrow();
  });

  test("sanitizeLabel normaliza hostnames a etiquetas DNS", () => {
    expect(sanitizeLabel("Mi Servidor!.local", "x")).toBe("mi-servidor-local");
    expect(sanitizeLabel("", "fallback")).toBe("fallback");
    expect(sanitizeLabel("a".repeat(100), "x", 48).length).toBe(48);
  });

  test("constructor rechaza serviceType inválido", () => {
    expect(() => new MdnsAnnouncer({ httpPort: 4096, serviceType: "nicotine" })).toThrow(/serviceType/);
  });
});

describe("mdns — anunciador sobre unicast (puerto efímero)", () => {
  const queryAndCollect = (ann: MdnsAnnouncer, name: string, qtype: number) => new Promise<Buffer>((resolve, reject) => {
    const client = dgram.createSocket("udp4");
    const timer = setTimeout(() => { client.close(); reject(new Error("timeout esperando respuesta mDNS")); }, 3000);
    client.on("message", (msg) => { clearTimeout(timer); client.close(); resolve(msg); });
    client.on("error", (e) => { clearTimeout(timer); client.close(); reject(e); });
    client.send(craftQuery(name, qtype, true), ann.port()!, "127.0.0.1");
  });

  test("PTR por _nicotine._tcp → instancia; additionals SRV/TXT/A", async () => {
    const logs: string[] = [];
    const ann = new MdnsAnnouncer({ httpPort: 4096, port: 0, multicast: false, bindAddress: "127.0.0.1", hostIPv4: "127.0.0.1", instanceLabel: "nicotine-test", hostLabel: "teshost", logger: (m) => logs.push(m) });
    expect(await ann.start()).toBe(true);
    try {
      const resp = await queryAndCollect(ann, "_nicotine._tcp.nicotine.local.", 12);
      const p = parseDnsMessage(resp);
      expect(p.questions[0].name).toBe("_nicotine._tcp.nicotine.local.");
      const { answers, additionals } = parseAnswers(resp);
      const ptr = answers.find((a) => a.type === 12);
      expect(ptr).toBeDefined();
      expect(decodeName(ptr!.rdata, 0).name).toBe("nicotine-test._nicotine._tcp.nicotine.local.");
      expect(ptr!.ttl).toBe(120);
      const srv = additionals.find((a) => a.type === 33);
      const txt = additionals.find((a) => a.type === 16);
      const a = additionals.find((x) => x.type === 1);
      expect(srv?.name).toBe("nicotine-test._nicotine._tcp.nicotine.local.");
      expect(txt?.name).toBe("nicotine-test._nicotine._tcp.nicotine.local.");
      expect(a?.name).toBe("teshost.nicotine.local.");
    } finally {
      await ann.stop();
    }
    expect(ann.port()).toBeNull();
  });

  test("PTR _services._dns-sd._udp.local → enumera _nicotine._tcp", async () => {
    const ann = new MdnsAnnouncer({ httpPort: 4199, port: 0, multicast: false, bindAddress: "127.0.0.1", hostIPv4: "127.0.0.1", instanceLabel: "nicotine-enum", hostLabel: "enumhost", logger: () => {} });
    expect(await ann.start()).toBe(true);
    try {
      const resp = await queryAndCollect(ann, "_services._dns-sd._udp.local.", 12);
      const { answers } = parseAnswers(resp);
      const names = answers.filter((a) => a.type === 12).map((a) => decodeName(a.rdata, 0).name);
      expect(names).toContain("_nicotine._tcp.nicotine.local.");
    } finally { await ann.stop(); }
  });

  test("SRV por la instancia → puerto y target correctos", async () => {
    const ann = new MdnsAnnouncer({ httpPort: 4321, port: 0, multicast: false, bindAddress: "127.0.0.1", hostIPv4: "127.0.0.1", instanceLabel: "nicotine-srv", hostLabel: "srvhost", logger: () => {} });
    expect(await ann.start()).toBe(true);
    try {
      const resp = await queryAndCollect(ann, "nicotine-srv._nicotine._tcp.nicotine.local.", 33);
      const { answers } = parseAnswers(resp);
      const srv = answers.find((a) => a.type === 33)!;
      expect(srv.rdata.readUInt16BE(4)).toBe(4321);
      expect(decodeName(srv.rdata, 6).name).toBe("srvhost.nicotine.local.");
    } finally { await ann.stop(); }
  });

  test("query por otro dominio → sin respuesta (timeout corto en el cliente)", async () => {
    const ann = new MdnsAnnouncer({ httpPort: 4096, port: 0, multicast: false, bindAddress: "127.0.0.1", hostIPv4: "127.0.0.1", logger: () => {} });
    expect(await ann.start()).toBe(true);
    try {
      await expect(queryAndCollect(ann, "_otro._tcp.nicotine.local.", 12)).rejects.toThrow(/timeout/);
    } finally { await ann.stop(); }
  }, 5000);

  test("stop() con goodbye no lanza y cierra el socket", async () => {
    const ann = new MdnsAnnouncer({ httpPort: 4096, port: 0, multicast: false, bindAddress: "127.0.0.1", logger: () => {} });
    await ann.start();
    await expect(ann.stop()).resolves.toBeUndefined();
    await expect(ann.stop()).resolves.toBeUndefined(); // stop idempotente
  });
});

describe("mdns — codec: errores esperados (Q3)", () => {
  test("encodeName rechaza etiqueta vacía y etiqueta de más de 63 bytes", () => {
    expect(() => encodeName("a..b")).toThrow(/vacía/);
    expect(() => encodeName(`${"x".repeat(64)}.local`)).toThrow(/demasiado larga/);
  });

  test("decodeName sigue punteros de compresión y deja el offset al final del puntero", () => {
    const head = encodeName("local.");
    const buf = Buffer.concat([head, Buffer.from([1, 0x61, 0xc0, 0x00])]);
    const { name, offset } = decodeName(buf, head.length);
    expect(name).toBe("a.local.");
    expect(offset).toBe(buf.length);
  });

  test("decodeName: puntero circular, puntero truncado y etiqueta truncada no cuelgan", () => {
    expect(() => decodeName(Buffer.from([0xc0, 0x00]), 0)).toThrow(/profundo/);
    expect(() => decodeName(Buffer.from([0xc0]), 0)).toThrow(/puntero DNS truncado/);
    expect(() => decodeName(Buffer.from([5, 0x61, 0x62]), 0)).toThrow(/etiqueta DNS truncada/);
  });

  test("parseDnsMessage: mensaje corto o pregunta truncada", () => {
    expect(() => parseDnsMessage(Buffer.alloc(4))).toThrow(/truncado/);
    const q = craftQuery("x.local.", 12);
    expect(() => parseDnsMessage(q.subarray(0, q.length - 2))).toThrow(/truncada/);
  });
});

describe("mdns — buildResponseFor sin red (Q3)", () => {
  const ann = (extra: Record<string, unknown> = {}) =>
    new MdnsAnnouncer({ httpPort: 4096, multicast: false, bindAddress: "127.0.0.1", hostIPv4: "10.1.2.3", instanceLabel: "inst", hostLabel: "host", logger: () => {}, ...extra });

  test("ignora respuestas (QR=1), mensajes sin preguntas y paquetes basura", () => {
    const a = ann();
    const header = (flags: number, qd: number) => Buffer.concat([u16(0), u16(flags), u16(qd), u16(0), u16(0), u16(0)]);
    expect(a.buildResponseFor(header(0x8400, 0))).toBeNull();
    expect(a.buildResponseFor(header(0, 0))).toBeNull();
    expect(a.buildResponseFor(Buffer.alloc(3))).toBeNull();
  });

  test("ignora preguntas de clase no-IN", () => {
    const a = ann();
    const q = Buffer.concat([u16(0), u16(0), u16(1), u16(0), u16(0), u16(0), encodeName("_services._dns-sd._udp.local."), u16(12), u16(3)]);
    expect(a.buildResponseFor(q)).toBeNull();
  });

  test("consulta ANY por la instancia → SRV con el puerto y TXT con path/api", () => {
    const a = ann({ httpPort: 4321, path: "/salud" });
    const resp = a.buildResponseFor(craftQuery(a.names.instanceFqdn, 255));
    expect(resp).not.toBeNull();
    const { answers } = parseAnswers(resp!);
    expect(answers.map((x) => x.type).sort()).toEqual([16, 33]);
    expect(answers.find((x) => x.type === 33)!.rdata.readUInt16BE(4)).toBe(4321);
    const txt = answers.find((x) => x.type === 16)!.rdata.toString("utf8");
    expect(txt).toContain("path=/salud");
    expect(txt).toContain("api=nicotine-serve-1");
  });

  test("consulta PTR por el servicio → PTR + additionals SRV/TXT/A", () => {
    const a = ann();
    const { answers, additionals } = parseAnswers(a.buildResponseFor(craftQuery(a.names.serviceFqdn, 12))!);
    expect(answers.map((x) => x.type)).toEqual([12]);
    expect(additionals.map((x) => x.type).sort()).toEqual([1, 16, 33]);
  });

  test("el registro A usa hostIPv4 y cae a 127.0.0.1 si es inválido", () => {
    const ok = ann();
    const a1 = parseAnswers(ok.buildResponseFor(craftQuery(ok.names.targetFqdn, 1))!).answers.find((x) => x.type === 1)!;
    expect([...a1.rdata]).toEqual([10, 1, 2, 3]);
    const bad = ann({ hostIPv4: "no-es-una-ip" });
    const a2 = parseAnswers(bad.buildResponseFor(craftQuery(bad.names.targetFqdn, 1))!).answers.find((x) => x.type === 1)!;
    expect([...a2.rdata]).toEqual([127, 0, 0, 1]);
  });

  test("ttl configurable se refleja en la respuesta", () => {
    const a = ann({ ttl: 30 });
    const { answers } = parseAnswers(a.buildResponseFor(craftQuery(a.names.serviceFqdn, 12))!);
    expect(answers[0].ttl).toBe(30);
  });

  test("dominio y serviceType con punto final se normalizan en los nombres", () => {
    const a = ann({ domain: "lan.local.", serviceType: "_nicotine._udp." });
    expect(a.names.serviceFqdn).toBe("_nicotine._udp.lan.local.");
    expect(a.names.instanceFqdn).toBe("inst._nicotine._udp.lan.local.");
    expect(a.names.targetFqdn).toBe("host.lan.local.");
  });
});
