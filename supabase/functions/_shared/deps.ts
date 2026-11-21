// Third-party imports for the Edge Functions (Deno), pinned in one place.
export { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
// SheetJS 0.20.3 from the vendor CDN: the npm "xlsx" package (0.18.5) has known
// vulnerabilities and is no longer updated there. See https://docs.sheetjs.com
export * as XLSX from "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs";
export { extractText, getDocumentProxy } from "npm:unpdf@1";
export { unzipSync, strFromU8 } from "npm:fflate@0.8";
