// File parsing for the ingest function (Deno). Turns bytes into either
// document sections (PDF/DOCX) or spreadsheet rows (XLS/XLSX).
import { extractText, getDocumentProxy, strFromU8, unzipSync, XLSX } from "./deps.ts";
import { docxXmlToSections, type Section, textToSections } from "./chunker.ts";
import type { Sheets } from "./po-extract.ts";

export async function parseDocument(bytes: Uint8Array, fileName: string): Promise<Section[]> {
  const ext = fileName.toLowerCase().split(".").pop();
  if (ext === "pdf") {
    const pdf = await getDocumentProxy(bytes);
    const { text } = await extractText(pdf, { mergePages: true });
    return textToSections(Array.isArray(text) ? text.join("\n") : text);
  }
  if (ext === "docx") {
    const files = unzipSync(bytes, { filter: (f) => f.name === "word/document.xml" });
    const xml = files["word/document.xml"];
    if (!xml) throw new Error("Not a valid .docx (word/document.xml missing)");
    return docxXmlToSections(strFromU8(xml));
  }
  if (ext === "txt" || ext === "md") {
    return textToSections(new TextDecoder().decode(bytes));
  }
  throw new Error(`Unsupported document type: .${ext}`);
}

export function parseWorkbook(bytes: Uint8Array): Sheets {
  // No cellDates: dates stay as Excel serial numbers and are converted in UTC,
  // which avoids an off-by-one-day bug from local-time Date objects.
  const wb = XLSX.read(bytes, { type: "array" });
  return Object.fromEntries(
    wb.SheetNames.map((n: string) => [n, XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null })]),
  ) as Sheets;
}
