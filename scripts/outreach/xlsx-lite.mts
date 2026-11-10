/**
 * A minimal READ-ONLY .xlsx reader (a zip of XML; Node built-ins only), enough for a one-sheet contact list. Returns the cell text of the first sheet as
 * rows. It never writes anything and works on the bytes of the file it is given.
 */
import fs from "node:fs";
import zlib from "node:zlib";

const decode = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, "&");
const textOf = (xml: string) => [...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1])).join("");
const colIndex = (ref: string) => [...ref.replace(/\d+/g, "")].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

export function readFirstSheet(file: string): string[][] {
  const buf = fs.readFileSync(file);
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a zip / .xlsx file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const parts = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen);
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const raw = buf.subarray(start, start + csize);
    parts.set(name, method === 8 ? zlib.inflateRawSync(raw) : raw);
    p += 46 + nlen + elen + clen;
  }
  const shared = parts.has("xl/sharedStrings.xml") ? [...parts.get("xl/sharedStrings.xml")!.toString("utf8").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1])) : [];
  const wb = parts.get("xl/workbook.xml")!.toString("utf8");
  const first = /<sheet [^>]*r:id="([^"]*)"/.exec(wb)?.[1];
  const rels = parts.get("xl/_rels/workbook.xml.rels")!.toString("utf8");
  const target = new RegExp(`<Relationship [^>]*Id="${first}"[^>]*Target="([^"]*)"|<Relationship [^>]*Target="([^"]*)"[^>]*Id="${first}"`).exec(rels);
  const path = (target?.[1] ?? target?.[2] ?? "worksheets/sheet1.xml").replace(/^\//, "");
  const xml = parts.get(path.startsWith("xl/") ? path : "xl/" + path)!.toString("utf8");
  const rows: string[][] = [];
  for (const rm of xml.matchAll(/<row [^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const cells: string[] = [];
    for (const cm of (rm[1] ?? "").matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? "";
      const type = /t="([^"]*)"/.exec(attrs)?.[1] ?? "";
      const inner = cm[2] ?? "";
      cells[colIndex(ref)] = type === "s" ? (shared[Number(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? -1)] ?? "") : type === "inlineStr" ? textOf(inner) : decode(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "");
    }
    rows.push(Array.from(cells, (c) => c ?? ""));
  }
  return rows;
}
