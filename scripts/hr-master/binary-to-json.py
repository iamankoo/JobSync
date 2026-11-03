"""
Converts the two binary Mail-Data sources into plain JSON the TypeScript extractors read.

  python -I scripts/hr-master/binary-to-json.py [--libs <dir with openpyxl + pypdf>]

Writes data/hr-master/work/xlsx-rows.json  ({sheetName: [[cell, ...], ...]})
   and data/hr-master/work/pdf-pages.json  ([pageText, ...])

Needs `pip install openpyxl pypdf` (build-time only; neither is a project dependency). Read-only on Mail-Data.
"""
import json
import os
import sys

root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
args = sys.argv[1:]
if "--libs" in args:
    sys.path.insert(0, args[args.index("--libs") + 1])

import openpyxl  # noqa: E402
import pypdf  # noqa: E402

src = os.path.join(root, "Mail-Data")
out = os.path.join(root, "data", "hr-master", "work")
os.makedirs(out, exist_ok=True)

wb = openpyxl.load_workbook(os.path.join(src, "HR_List_2026.xlsx"), data_only=True, read_only=True)
sheets = {ws.title: [["" if c is None else str(c) for c in row] for row in ws.iter_rows(values_only=True)] for ws in wb.worksheets}
with open(os.path.join(out, "xlsx-rows.json"), "w", encoding="utf8") as f:
    json.dump(sheets, f, ensure_ascii=False)

reader = pypdf.PdfReader(os.path.join(src, "famous_it_companies_hr_e-mail_id-part-1.pdf"))
pages = [p.extract_text() or "" for p in reader.pages]
with open(os.path.join(out, "pdf-pages.json"), "w", encoding="utf8") as f:
    json.dump(pages, f, ensure_ascii=False)

print("sheets:", {k: len(v) for k, v in sheets.items()}, "pdf pages:", len(pages))
