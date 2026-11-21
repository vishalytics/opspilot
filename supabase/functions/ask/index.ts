// POST /functions/v1/ask  { question }  with the user's Authorization header.
// Answers run with a Supabase client built from the caller's JWT, so row-level
// security decides what can be retrieved. The service-role key is never used here.
import { createClient } from "../_shared/deps.ts";
import { corsHeaders, json, requireEnv } from "../_shared/http.ts";
import { answerForUser } from "../_shared/pipeline.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const { data: { user } } = await userClient.auth.getUser(token);
  if (!user) return json({ error: "Not signed in" }, 401);

  try {
    const { question, channel } = await req.json();
    const result = await answerForUser(userClient, user.id, question, channel === "eval" ? "eval" : "web");
    return json(result);
  } catch (e) {
    console.error(e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
