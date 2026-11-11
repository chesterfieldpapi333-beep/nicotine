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
