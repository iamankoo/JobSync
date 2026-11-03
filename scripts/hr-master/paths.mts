import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "../..");
export const MAIL_DATA = path.join(ROOT, "Mail-Data");
export const OUT_DIR = path.join(ROOT, "data", "hr-master");
export const WORK_DIR = path.join(OUT_DIR, "work");
