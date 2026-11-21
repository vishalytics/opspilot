// Small HTTP helpers shared by the Edge Functions.
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

export const env = (k: string) => Deno.env.get(k);

export function requireEnv(k: string): string {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`${k} is not set`);
  return v;
}

// Supabase Edge Runtime keeps the worker alive until these promises settle.
declare global {
  // deno-lint-ignore no-var
  var EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;
}
export function runInBackground(p: Promise<unknown>) {
  if (globalThis.EdgeRuntime) globalThis.EdgeRuntime.waitUntil(p);
  else p.catch((e) => console.error(e)); // local dev fallback
}
