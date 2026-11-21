import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
export const configured = Boolean(url && key);
export const supabase = createClient(url || "http://localhost", key || "missing");

export interface Profile {
  id: string;
  email: string;
  role: "admin" | "member";
  departments: string[];
}

export interface Source {
  label: string;
  type: "document" | "tool";
  title: string;
  heading?: string | null;
  source_file?: string;
  content: string;
  flagged?: boolean;
}

export interface AskResult {
  answer: string;
  sources: Source[];
  route: string;
  flags: string[];
  log_id: number | null;
  latency_ms: number;
  cost_inr: number;
}

export const inr = (n: number, digits = 2) =>
  "₹" + Number(n).toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
