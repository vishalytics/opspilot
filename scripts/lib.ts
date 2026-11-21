// Shared helpers for the Node scripts (run with: npx tsx scripts/<name>.ts).
import "dotenv/config";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { createClient } from "@supabase/supabase-js";

export function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return v;
}

export const SUPABASE_URL = () => need("SUPABASE_URL").replace(/\/$/, "");

/** Service-role client: bypasses RLS. Only for setup scripts, never in the browser. */
export const adminClient = () =>
  createClient(SUPABASE_URL(), need("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

export const anonClient = () =>
  createClient(SUPABASE_URL(), need("SUPABASE_ANON_KEY"), { auth: { persistSession: false } });

export const readCsv = <T = Record<string, string>>(path: string): T[] => parse(readFileSync(path), { columns: true });

export const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
