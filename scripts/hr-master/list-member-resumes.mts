/** READ-ONLY: lists each member's uploaded resume metadata (names/types/sizes, never bytes) from the MemberFiles tab. */
import path from "node:path";
import { createRequire } from "node:module";
import { ROOT } from "./paths.mts";
const require = createRequire(import.meta.url);
const { loadEnvConfig } = require(path.join(ROOT, "node_modules/@next/env"));
const { auth, sheets } = require(path.join(ROOT, "node_modules/@googleapis/sheets"));
loadEnvConfig(ROOT, true);
let key = (process.env.GOOGLE_PRIVATE_KEY ?? "").trim();
if (/^["'].*["']$/s.test(key)) key = key.slice(1, -1);
const jwt = new auth.JWT({ email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim(), key: key.replace(/\n/g, "\n"), scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
const api = sheets({ version: "v4", auth: jwt });
const r = await api.spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID!.trim(), range: "MemberFiles!A:H" });
const rows: string[][] = r.data.values ?? [];
for (const [rec, member, kind, , name, mime, size, at] of rows.slice(1)) if (kind === "resume") console.log([member, name, mime, size, at, rec.slice(0, 6)].join(" | "));
