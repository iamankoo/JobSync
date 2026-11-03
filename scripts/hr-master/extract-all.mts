/**
 * Stage 1+2: read all five sources, extract every record, deduplicate by normalised e-mail.
 * Writes data/hr-master/work/{raw-records,deduped}.json. Read-only on Mail-Data. No network.
 *
 *   python -I scripts/hr-master/binary-to-json.py     (once, for the xlsx + pdf)
 *   node --experimental-strip-types --no-warnings scripts/hr-master/extract-all.mts
 */
import fs from "node:fs";
import path from "node:path";
import { dedupe } from "../../src/lib/hr-master/dedupe.ts";
import { extractCompaniesMd, extractDataJson, extractPdfPages, extractUnifiedCsv, extractXlsxRows } from "../../src/lib/hr-master/extract.ts";
import type { ExtractionResult } from "../../src/lib/hr-master/types.ts";
import { MAIL_DATA, WORK_DIR } from "./paths.mts";

const read = (f: string) => fs.readFileSync(path.join(MAIL_DATA, f), "utf8");
const readWork = (f: string) => JSON.parse(fs.readFileSync(path.join(WORK_DIR, f), "utf8"));

fs.mkdirSync(WORK_DIR, { recursive: true });
const xlsx: Record<string, string[][]> = readWork("xlsx-rows.json");
const pdfPages: string[] = readWork("pdf-pages.json");

const results: ExtractionResult[] = [
  extractPdfPages(pdfPages),
  ...Object.entries(xlsx).map(([sheet, rows]) => extractXlsxRows(rows, sheet)),
  extractCompaniesMd(read("companies.md")),
  extractUnifiedCsv(read("unified_emails.csv")),
  extractDataJson(read("data.json")),
];

const records = results.flatMap((r) => r.records);
const result = dedupe(records);

fs.writeFileSync(path.join(WORK_DIR, "raw-records.json"), JSON.stringify(records));
fs.writeFileSync(path.join(WORK_DIR, "deduped.json"), JSON.stringify(result));
for (const r of results) console.log(`${r.sourceFile}: ${r.records.length} raw records`);
console.log(JSON.stringify(result.stats, null, 2));
