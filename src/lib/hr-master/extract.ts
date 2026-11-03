/**
 * Source extractors for the five Mail-Data files. Each is a pure function over already-read text / row arrays, so tests can
 * feed small fixtures and the runner script feeds the real files. Binary formats (xlsx, pdf) are converted to plain row
 * arrays / page text by scripts/hr-master/binary-to-json.py first. Nothing is dropped here: validation happens later.
 */
import { parseCsv } from "./csv.ts";
import type { ExtractionResult, RawRecord } from "./types.ts";

const EMAIL_IN_TEXT = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

function blank(sourceFile: string, sourceLocation: string): RawRecord {
  return { sourceFile, sourceLocation, original: {}, email: "", name: "", designation: "", company: "", domainHint: "", context: {}, uncertainties: [] };
}

const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

function headerIndex(header: string[]): Record<string, number> {
  const idx: Record<string, number> = {};
  header.forEach((h, i) => {
    const k = h.replace(/^\uFEFF/, "").trim().toLowerCase();
    if (k && !(k in idx)) idx[k] = i;
  });
  return idx;
}

function fromTable(sourceFile: string, header: string[], rows: string[][], firstRowNumber: number, pick: (cell: (name: string) => string, rec: RawRecord) => void): RawRecord[] {
  const idx = headerIndex(header);
  const out: RawRecord[] = [];
  rows.forEach((cells, i) => {
    if (cells.every((c) => !c.trim())) return;
    const rec = blank(sourceFile, `row ${firstRowNumber + i}`);
    const cell = (name: string) => str(cells[idx[name.toLowerCase()]] ?? "");
    header.forEach((h, c) => {
      if (str(cells[c]) !== "") rec.original[h.replace(/^\uFEFF/, "")] = str(cells[c]);
    });
    pick(cell, rec);
    if (cells.length > header.length) rec.uncertainties.push(`row has ${cells.length} cells but header has ${header.length}`);
    out.push(rec);
  });
  return out;
}

/** unified_emails.csv: Company,Email,Person,Title,Location,Source,Notes. */
export function extractUnifiedCsv(text: string, sourceFile = "unified_emails.csv"): ExtractionResult {
  const [header = [], ...rows] = parseCsv(text);
  const records = fromTable(sourceFile, header, rows, 2, (cell, rec) => {
    rec.email = cell("Email");
    rec.name = cell("Person");
    rec.designation = cell("Title");
    rec.company = cell("Company");
    for (const k of ["Location", "Source", "Notes"]) if (cell(k)) rec.context[k.toLowerCase()] = cell(k);
    if (/\uFFFD/.test(Object.values(rec.original).join(""))) rec.uncertainties.push("source text contains U+FFFD replacement characters (original encoding already lost)");
  });
  return { sourceFile, format: "csv", records };
}

/** data.json: array of { SNo, Name, Email, Title, Company }. */
export function extractDataJson(text: string, sourceFile = "data.json"): ExtractionResult {
  const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
  if (!Array.isArray(parsed)) throw new Error(`${sourceFile}: expected a JSON array`);
  const records = parsed.map((item, i) => {
    const o = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const rec = blank(sourceFile, `record ${i + 1}${o.SNo !== undefined ? ` (SNo ${str(o.SNo)})` : ""}`);
    for (const [k, v] of Object.entries(o)) rec.original[k] = str(v);
    rec.email = str(o.Email);
    rec.name = str(o.Name);
    rec.designation = str(o.Title);
    rec.company = str(o.Company);
    if (!item || typeof item !== "object") rec.uncertainties.push("record is not an object");
    return rec;
  });
  return { sourceFile, format: "json", records };
}

/** HR_List_2026.xlsx sheet rows (first row = header): SNo, Name, Email, Title, Company. */
export function extractXlsxRows(rows: string[][], sheetName = "HR List", sourceFile = "HR_List_2026.xlsx"): ExtractionResult {
  const [header = [], ...body] = rows;
  const records = fromTable(sourceFile, header, body, 2, (cell, rec) => {
    rec.sourceLocation = `sheet "${sheetName}" ${rec.sourceLocation}`;
    rec.email = cell("Email");
    rec.name = cell("Name");
    rec.designation = cell("Title");
    rec.company = cell("Company");
  });
  return { sourceFile, format: "xlsx", records };
}

/** companies.md: a markdown table of company role mailboxes (Company | Domain | Role Email | Department / Team | ...). */
export function extractCompaniesMd(text: string, sourceFile = "companies.md"): ExtractionResult {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const records: RawRecord[] = [];
  let header: string[] | null = null;
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!t.startsWith("|")) return; // blank/prose lines do not end a table
    const cells = t.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) return; // separator row
    if (!header) {
      header = cells;
      return;
    }
    const idx = headerIndex(header);
    const get = (n: string) => cells[idx[n.toLowerCase()]] ?? "";
    const rec = blank(sourceFile, `line ${i + 1}`);
    header.forEach((h, c) => {
      if (cells[c]) rec.original[h] = cells[c];
    });
    rec.company = get("Company");
    rec.domainHint = get("Domain");
    rec.email = get("Role Email") || get("Email");
    rec.designation = get("Department / Team");
    rec.name = ""; // the file lists role mailboxes, not named people
    for (const [k, ctx] of [["Location", "location"], ["Description", "description"], ["Source URL", "sourceUrl"], ["Last Verified", "lastVerified"]] as const) {
      if (get(k)) rec.context[ctx] = get(k);
    }
    rec.uncertainties.push("role mailbox: no individual person is named in this file");
    if (cells.length !== header.length) rec.uncertainties.push(`row has ${cells.length} cells but header has ${header.length}`);
    records.push(rec);
  });
  return { sourceFile, format: "md", records };
}

const CITIES = new Set(["bangalore", "bengaluru", "hyderabad", "delhi", "new delhi", "chennai", "madras", "mumbai", "bombay", "pune", "calcutta", "kolkata", "noida", "gurgaon", "gurugram", "ahmedabad", "kochi", "cochin", "trivandrum", "coimbatore", "jaipur", "chandigarh", "mysore", "bhubaneswar", "nagpur", "indore"]);

function cleanHeading(line: string): string {
  return line.replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").replace(/[\s:\-]+$/g, "").trim();
}

/**
 * The PDF is a 1990s/2000s list laid out as "Company name" on one line followed by its e-mail address(es) and sometimes a
 * city. The company for an address is therefore INFERRED from the nearest preceding heading line; every such record carries
 * that uncertainty. `pages` is the text of each page in order.
 */
export function extractPdfPages(pages: string[], sourceFile = "famous_it_companies_hr_e-mail_id-part-1.pdf"): ExtractionResult {
  const records: RawRecord[] = [];
  let company = "";
  let lastGroup: RawRecord[] = [];
  pages.forEach((page, p) => {
    page.split(/\r?\n/).forEach((raw, l) => {
      const line = raw.replace(/\s+/g, " ").trim();
      if (!line) return;
      const emails = line.match(EMAIL_IN_TEXT);
      if (emails) {
        for (const e of emails) {
          const rec = blank(sourceFile, `page ${p + 1} line ${l + 1}`);
          rec.original = { line };
          rec.email = e;
          rec.company = company;
          rec.uncertainties.push(company ? "company inferred from the nearest preceding heading line of the PDF text layer" : "no company heading precedes this address");
          records.push(rec);
          lastGroup.push(rec);
        }
        return;
      }
      const heading = cleanHeading(line);
      if (!heading) return;
      if (CITIES.has(heading.toLowerCase())) {
        for (const r of lastGroup) r.context.location = heading;
        return;
      }
      if (/^famous it companies/i.test(heading)) return; // document title
      company = heading;
      lastGroup = [];
    });
  });
  return { sourceFile, format: "pdf", records };
}
