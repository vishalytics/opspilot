// Purchase-order extractor for three inconsistent Excel templates.
//
// Pure TypeScript with no imports: the caller parses the workbook (SheetJS in the
// Edge Function, the npm package in tests) and passes each sheet as rows of cells.
// The template is detected from header labels, never from the file name, because
// file names are typed by people and drift.

export type Cell = string | number | boolean | Date | null | undefined;
export type Sheets = Record<string, Cell[][]>;

export interface PoLine {
  line_no: number;
  item_code: string | null;
  description: string;
  hsn: string | null;
  qty: number;
  uom: string | null;
  rate: number;
  gst_pct: number | null;
  line_value: number; // qty x rate, excluding GST
}

export interface ExtractedPo {
  po_number: string;
  revision: string; // '' or 'R1', 'R2'...
  po_date: string | null; // ISO yyyy-mm-dd
  vendor_name: string | null;
  vendor_gstin: string | null;
  warehouse: "MNS" | "BWD" | null;
  status: "Open" | "Cancelled";
  subtotal: number;
  tax: number;
  total: number; // computed: subtotal + tax
  header_total: number | null; // as typed in the file
  approval_text: string | null;
  approval_level: "L1" | "L2" | "L3" | null;
  template: "A" | "B" | "C";
  lines: PoLine[];
}

export interface PoIssue {
  code: "ITEM_TABLE_NOT_FOUND" | "TOTAL_MISMATCH" | "SUPERSEDED_REVISION" | "UNKNOWN_TEMPLATE";
  detail: string;
}

export interface ExtractResult {
  po: ExtractedPo | null;
  issues: PoIssue[];
}

const str = (c: Cell): string => (c === null || c === undefined ? "" : String(c).trim());
const num = (c: Cell): number | null => {
  if (typeof c === "number") return c;
  const s = str(c).replace(/[₹,\s]/g, "").replace(/%$/, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Find the first cell whose trimmed text matches; returns [row, col]. */
function findCell(rows: Cell[][], test: (s: string) => boolean): [number, number] | null {
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] ?? [];
    for (let c = 0; c < row.length; c++) if (test(str(row[c]))) return [r, c];
  }
  return null;
}

/** Value in the cell to the right of a label (skipping empty cells). */
function valueRightOf(rows: Cell[][], label: string | RegExp): Cell {
  const test = typeof label === "string" ? (s: string) => s === label : (s: string) => label.test(s);
  const pos = findCell(rows, test);
  if (!pos) return null;
  const row = rows[pos[0]];
  for (let c = pos[1] + 1; c < row.length; c++) if (str(row[c]) !== "") return row[c];
  return null;
}

/** Parse dates in the formats the templates use. */
export function toIsoDate(c: Cell): string | null {
  if (c instanceof Date) return c.toISOString().slice(0, 10);
  // Prefer reading workbooks WITHOUT cellDates: Date objects are built in the
  // runtime's local time zone and shift by a day outside UTC (caught by the
  // ground-truth test). Excel serial numbers below are converted in pure UTC.
  if (typeof c === "number" && c > 20000 && c < 80000) {
    // Excel serial date (days since 1899-12-30)
    const ms = Math.round((c - 25569) * 86400 * 1000);
    return new Date(ms).toISOString().slice(0, 10);
  }
  const s = str(c);
  let m = s.match(/^(\d{1,2})[-./](\d{1,2})[-./](\d{2,4})$/); // dd-mm-yyyy, dd.mm.yy
  if (m) {
    const yy = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return `${yy}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

/** Map the approval text to the policy's approval band. */
export function approvalLevel(text: string | null): "L1" | "L2" | "L3" | null {
  if (!text) return null;
  if (/\bCEO\b/i.test(text) && /\bCFO\b/i.test(text)) return "L3";
  if (/Head\s*[–-]\s*Procurement/i.test(text) && /Finance Controller/i.test(text)) return "L2";
  if (/Dept Head|Department Head/i.test(text)) return "L1";
  return null;
}

function warehouseFrom(text: string): "MNS" | "BWD" | null {
  if (/manesar/i.test(text)) return "MNS";
  if (/bhiwandi/i.test(text)) return "BWD";
  return null;
}

/** "Whey Protein Concentrate 80% [RM-WPC80]" or "(RM-WPC80)" -> code + description */
function splitCode(text: string): { code: string | null; desc: string } {
  const m = text.match(/^(.*?)\s*[[(]([A-Z]{2}-[A-Z0-9]+)[\])]\s*$/);
  return m ? { code: m[2], desc: m[1].trim() } : { code: null, desc: text };
}

export function detectTemplate(sheets: Sheets): "A" | "B" | "C" | null {
  const first = Object.values(sheets)[0] ?? [];
  if (findCell(first, (s) => s === "PO No.:")) return "A";
  if (findCell(first, (s) => s === "Order Number")) return "B";
  if (findCell(first, (s) => s === "Ref:")) return "C";
  return null;
}

/** Revision suffix from the file name, e.g. "0036 Orbit Labels 02Sep25 R1.xlsx" -> "R1". */
export function revisionFromFileName(fileName: string): string {
  const m = fileName.replace(/\.[^.]+$/, "").match(/\s(R\d+)$/i);
  return m ? m[1].toUpperCase() : "";
}

function readTable(
  rows: Cell[][],
  headerRow: number,
  cols: Record<string, number>,
  stop: (row: Cell[]) => boolean,
): Cell[][] {
  const out: Cell[][] = [];
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    if (stop(row)) break;
    out.push(Object.values(cols).map((c) => row[c]));
  }
  return out;
}

function headerIndex(rows: Cell[][], must: string[]): { row: number; cols: Map<string, number> } | null {
  for (let r = 0; r < rows.length; r++) {
    const labels = (rows[r] ?? []).map(str);
    if (must.every((m) => labels.includes(m))) {
      const cols = new Map<string, number>();
      labels.forEach((l, i) => l && cols.set(l, i));
      return { row: r, cols };
    }
  }
  return null;
}

function extractA(sheets: Sheets, issues: PoIssue[]): ExtractedPo {
  const rows = Object.values(sheets)[0];
  const statusText = str(valueRightOf(rows, "Status:"));
  const ap = findCell(rows, (s) => s.startsWith("Approved by:"));
  const approval = ap ? str(rows[ap[0]][ap[1]]).replace(/^Approved by:\s*/, "") : "";
  const po: ExtractedPo = {
    po_number: str(valueRightOf(rows, "PO No.:")),
    revision: "",
    po_date: toIsoDate(valueRightOf(rows, "PO Date:")),
    vendor_name: str(valueRightOf(rows, "Vendor:")) || null,
    vendor_gstin: str(valueRightOf(rows, "Vendor GSTIN:")) || null,
    warehouse: warehouseFrom(str(valueRightOf(rows, "Ship To:"))),
    status: /^cancel/i.test(statusText) ? "Cancelled" : "Open",
    subtotal: 0, tax: 0, total: 0, header_total: null,
    approval_text: approval || null,
    approval_level: approvalLevel(approval),
    template: "A",
    lines: [],
  };
  const h = headerIndex(rows, ["S.No", "Item Code", "Description", "Qty", "Rate"]);
  if (!h) {
    issues.push({ code: "ITEM_TABLE_NOT_FOUND", detail: "Template A header row (S.No, Item Code, Rate) not found" });
  } else {
    const c = (k: string) => h.cols.get(k)!;
    for (let r = h.row + 1; r < rows.length; r++) {
      const row = rows[r] ?? [];
      if (num(row[c("S.No")]) === null) break;
      const qty = num(row[c("Qty")]) ?? 0, rate = num(row[c("Rate")]) ?? 0;
      po.lines.push({
        line_no: num(row[c("S.No")])!, item_code: str(row[c("Item Code")]) || null,
        description: str(row[c("Description")]), hsn: str(row[c("HSN")]) || null,
        qty, uom: str(row[c("UOM")]) || null, rate, gst_pct: null, line_value: round2(qty * rate),
      });
    }
  }
  const taxRows = ["CGST", "SGST", "IGST"].map((k) => num(valueRightOf(rows, k)) ?? 0);
  po.tax = round2(taxRows.reduce((a, b) => a + b, 0));
  po.header_total = num(valueRightOf(rows, "Grand Total"));
  po.subtotal = round2(po.lines.reduce((a, l) => a + l.line_value, 0));
  // Template A has no per-line GST; derive the rate from the tax block (all lines share it in practice).
  const pct = po.subtotal ? Math.round((po.tax / po.subtotal) * 10000) / 100 : null;
  po.lines.forEach((l) => (l.gst_pct = pct));
  return po;
}

function extractB(sheets: Sheets, issues: PoIssue[]): ExtractedPo {
  const rows = Object.values(sheets)[0];
  const approval = str(valueRightOf(rows, "Approval"));
  const po: ExtractedPo = {
    po_number: str(valueRightOf(rows, "Order Number")),
    revision: "",
    po_date: toIsoDate(valueRightOf(rows, "Order Date")),
    vendor_name: str(valueRightOf(rows, "Supplier")) || null,
    vendor_gstin: str(valueRightOf(rows, "Supplier GSTIN")) || null,
    warehouse: warehouseFrom(str(valueRightOf(rows, "Delivery Location"))),
    status: /^cancel/i.test(str(valueRightOf(rows, "Order Status"))) ? "Cancelled" : "Open",
    subtotal: 0, tax: 0, total: 0, header_total: null,
    approval_text: approval || null,
    approval_level: approvalLevel(approval),
    template: "B",
    lines: [],
  };
  const h = headerIndex(rows, ["Sr", "Material", "Quantity", "Unit Price (₹)", "GST %"]);
  if (!h) {
    issues.push({ code: "ITEM_TABLE_NOT_FOUND", detail: "Template B header row (Sr, Material, Unit Price) not found" });
  } else {
    const c = (k: string) => h.cols.get(k)!;
    for (let r = h.row + 1; r < rows.length; r++) {
      const row = rows[r] ?? [];
      if (num(row[c("Sr")]) === null) break;
      const { code, desc } = splitCode(str(row[c("Material")]));
      const qty = num(row[c("Quantity")]) ?? 0, rate = num(row[c("Unit Price (₹)")]) ?? 0;
      po.lines.push({
        line_no: num(row[c("Sr")])!, item_code: code, description: desc,
        hsn: str(row[c("HSN/SAC")]) || null, qty, uom: str(row[c("Unit")]) || null, rate,
        gst_pct: num(row[c("GST %")]), line_value: round2(qty * rate),
      });
    }
  }
  po.subtotal = round2(po.lines.reduce((a, l) => a + l.line_value, 0));
  po.tax = num(valueRightOf(rows, "Total GST")) ??
    round2(po.lines.reduce((a, l) => a + l.line_value * (l.gst_pct ?? 0) / 100, 0));
  po.header_total = num(valueRightOf(rows, "Order Value (incl. GST)"));
  return po;
}

function extractC(sheets: Sheets, issues: PoIssue[]): ExtractedPo {
  const names = Object.keys(sheets);
  const rows = sheets[names[0]];
  const taxSheet = sheets["Tax"] ?? [];
  const approvedRow = findCell(rows, (s) => s.startsWith("Approved:"));
  const approval = approvedRow ? str(rows[approvedRow[0]][approvedRow[1]]).replace(/^Approved:\s*/, "") : "";
  const po: ExtractedPo = {
    po_number: str(valueRightOf(rows, "Ref:")),
    revision: "",
    po_date: toIsoDate(valueRightOf(rows, "Dt:")),
    vendor_name: str(valueRightOf(rows, "M/s")) || null,
    vendor_gstin: str(valueRightOf(rows, "GST No")) || null,
    warehouse: "BWD", // Template C is only used by the Bhiwandi branch
    status: "Open",
    subtotal: 0, tax: 0, total: 0, header_total: null,
    approval_text: approval || null,
    approval_level: approvalLevel(approval),
    template: "C",
    lines: [],
  };
  const h = headerIndex(rows, ["Particulars", "Rate", "Value"]);
  if (!h) {
    const note = findCell(rows, (s) => /scanned copy|refer pdf/i.test(s));
    issues.push({
      code: "ITEM_TABLE_NOT_FOUND",
      detail: note ? `No item table; file says: "${str(rows[note[0]][note[1]]).slice(0, 120)}"` : "Template C 'Particulars' table not found",
    });
    po.header_total = num(valueRightOf(rows, /^Total Value/));
  } else {
    const qtyCol = [...h.cols.keys()].find((k) => k.startsWith("Qty"))!;
    const c = (k: string) => h.cols.get(k)!;
    let n = 0;
    for (let r = h.row + 1; r < rows.length; r++) {
      const row = rows[r] ?? [];
      const particulars = str(row[c("Particulars")]);
      if (!particulars) break;
      const qm = str(row[c(qtyCol)]).match(/^([\d.,]+)\s*([A-Za-z]+)?$/);
      const qty = qm ? Number(qm[1].replace(/,/g, "")) : 0;
      const rate = num(row[c("Rate")]) ?? 0;
      const { code, desc } = splitCode(particulars);
      po.lines.push({
        line_no: ++n, item_code: code, description: desc, hsn: null, qty,
        uom: qm?.[2]?.toUpperCase() ?? null, rate, gst_pct: null, line_value: round2(qty * rate),
      });
    }
    po.header_total = num(valueRightOf(rows, /^Total \(see Tax sheet\)/));
  }
  // Tax sheet: rows of [Tax Head, Rate, Amount]
  let tax = 0;
  const rates: number[] = [];
  for (const row of taxSheet.slice(1)) {
    const amt = num(row[2]);
    if (amt !== null) { tax += amt; const r = num(row[1]); if (r !== null) rates.push(r); }
  }
  po.tax = round2(tax);
  po.subtotal = round2(po.lines.reduce((a, l) => a + l.line_value, 0));
  if (rates.length === 1) po.lines.forEach((l) => (l.gst_pct = rates[0]));
  return po;
}

export function extractPo(sheets: Sheets, fileName: string): ExtractResult {
  const issues: PoIssue[] = [];
  const template = detectTemplate(sheets);
  if (!template) {
    return { po: null, issues: [{ code: "UNKNOWN_TEMPLATE", detail: "No known PO header labels (PO No.:, Order Number, Ref:)" }] };
  }
  const po = template === "A" ? extractA(sheets, issues) : template === "B" ? extractB(sheets, issues) : extractC(sheets, issues);
  po.revision = revisionFromFileName(fileName);
  po.total = round2(po.subtotal + po.tax);
  if (po.lines.length === 0 && po.header_total !== null) {
    // Without lines we can only trust the typed total.
    po.total = po.header_total;
  } else if (po.header_total !== null && Math.abs(po.header_total - po.total) > 1) {
    issues.push({
      code: "TOTAL_MISMATCH",
      detail: `Header total ₹${po.header_total.toLocaleString("en-IN")} differs from lines + tax ₹${po.total.toLocaleString("en-IN")} by ₹${Math.abs(po.header_total - po.total).toLocaleString("en-IN")}`,
    });
  }
  if (po.revision) {
    issues.push({ code: "SUPERSEDED_REVISION", detail: `Revision ${po.revision} of ${po.po_number} supersedes the earlier version` });
  }
  return { po, issues };
}
