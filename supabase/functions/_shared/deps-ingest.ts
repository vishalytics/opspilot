// Parsing libraries, imported only by the ingest function so ask/slack stay small.
//
// SheetJS: Supabase's bundler only accepts npm:/jsr:/known hosts, so the patched
// build on cdn.sheetjs.com can't be imported. npm's xlsx 0.18.5 has known issues
// with crafted files (prototype pollution, ReDoS). Mitigations here: only admins and
// procurement users can upload, files are parsed in an isolated function, and
// sheets are read with raw values only. See docs/decisions.md (#21).
export * as XLSX from "npm:xlsx@0.18.5";
export { extractText, getDocumentProxy } from "npm:unpdf@1";
export { strFromU8, unzipSync } from "npm:fflate@0.8";
