// Scores the PO extractor against data/eval/po_ground_truth.csv, field by field.
// Ground truth describes what is really in each PO; the extractor can only see
// what the file contains, so the scanned PO (no item table) is expected to miss lines.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "csv-parse/sync";
import * as XLSX from "xlsx";
import { extractPo, type ExtractedPo, type PoIssue, type Sheets } from "../supabase/functions/_shared/po-extract.ts";

const ROOT = "data/purchase_orders";
const files = readdirSync(ROOT).flatMap((m) => readdirSync(join(ROOT, m)).map((f) => join(ROOT, m, f)));

function sheetsOf(path: string): Sheets {
  const wb = XLSX.read(readFileSync(path), { type: "buffer" });
  return Object.fromEntries(
    wb.SheetNames.map((n) => [n, XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null })]),
  ) as Sheets;
}

type Truth = Record<string, string>;
const truth: Truth[] = parse(readFileSync("data/eval/po_ground_truth.csv"), { columns: true });
const key = (po: string, rev: string, code: string) => `${po}|${rev}|${code}`;
const truthLines = new Map(truth.map((t) => {
  const [po, rev = ""] = t.po_number.split(" ");
  return [key(po, rev, t.item_code), t];
}));

const results: { file: string; po: ExtractedPo | null; issues: PoIssue[] }[] = files.map((f) => {
  const { po, issues } = extractPo(sheetsOf(f), f.split("/").pop()!);
  return { file: f, po, issues };
});

test("every file is recognised as one of the three templates", () => {
  assert.equal(results.length, 43);
  for (const r of results) assert.ok(r.po, `${r.file} not recognised`);
  const counts = results.reduce<Record<string, number>>((a, r) => ((a[r.po!.template] = (a[r.po!.template] ?? 0) + 1), a), {});
  console.log("  templates:", counts);
});

test("line-level fields match ground truth", () => {
  const fields = ["qty", "rate", "uom", "gst_pct", "line_value_ex_gst"] as const;
  let checked = 0, correct = 0, linesFound = 0;
  const misses: string[] = [];
  for (const r of results) {
    for (const l of r.po!.lines) {
      const t = truthLines.get(key(r.po!.po_number, r.po!.revision, l.item_code ?? ""));
      if (!t) { misses.push(`${r.file}: unexpected line ${l.item_code}`); continue; }
      linesFound++;
      const got: Record<string, unknown> = { qty: l.qty, rate: l.rate, uom: l.uom, gst_pct: l.gst_pct, line_value_ex_gst: l.line_value };
      for (const f of fields) {
        checked++;
        const ok = typeof got[f] === "number" ? Math.abs((got[f] as number) - Number(t[f])) < 0.01 : got[f] === t[f];
        if (ok) correct++; else misses.push(`${r.po!.po_number} ${l.item_code} ${f}: got ${got[f]} want ${t[f]}`);
      }
    }
  }
  const accuracy = (100 * correct) / checked;
  console.log(`  lines extracted: ${linesFound}/${truth.length} | field accuracy: ${accuracy.toFixed(1)}% (${correct}/${checked})`);
  if (misses.length) console.log("  misses:\n   " + misses.slice(0, 10).join("\n   "));
  assert.equal(accuracy, 100);
  // Only the scanned PO's lines should be missing.
  const scanned = truth.filter((t) => t.po_number === "PNPL/PO/25-26/0015").length;
  assert.equal(linesFound, truth.length - scanned);
});

test("header fields match ground truth", () => {
  let bad = 0;
  for (const r of results) {
    const po = r.po!;
    const t = truth.find((x) => x.po_number === (po.revision ? `${po.po_number} ${po.revision}` : po.po_number))!;
    const checks: [string, unknown, unknown][] = [
      ["date", po.po_date, t.po_date],
      ["vendor", po.vendor_name, t.vendor],
      ["warehouse", po.warehouse, t.warehouse],
      ["template", po.template, t.template],
      ["approval", po.approval_level, t.approval_level],
      ["total", Math.round(po.total), Math.round(Number(t.po_total_incl_gst))],
    ];
    const wantStatus = t.status === "Superseded" ? "Open" : t.status; // superseding happens at load time
    checks.push(["status", po.status, wantStatus]);
    // The scanned PO file carries no approval line, so that field cannot be extracted.
    if (po.po_number.endsWith("/0015")) checks.splice(checks.findIndex((c) => c[0] === "approval"), 1);
    for (const [name, got, want] of checks) {
      if (got !== want) { bad++; console.log(`  ${po.po_number}${po.revision} ${name}: got ${got} want ${want}`); }
    }
  }
  assert.equal(bad, 0);
});

test("the planted problems are reported as exceptions", () => {
  const issues = results.flatMap((r) => r.issues.map((i) => `${r.po!.po_number}${r.po!.revision ? " " + r.po!.revision : ""}:${i.code}`));
  console.log("  exceptions:", issues);
  assert.deepEqual(issues.sort(), [
    "PNPL/PO/25-26/0006:TOTAL_MISMATCH",
    "PNPL/PO/25-26/0015:ITEM_TABLE_NOT_FOUND",
    "PNPL/PO/25-26/0036 R1:SUPERSEDED_REVISION",
  ]);
});
