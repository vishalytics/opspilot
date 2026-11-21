// Slack slash command: /opspilot <question>
//
// Slack needs an acknowledgement within 3 seconds, so we reply "Looking that up…"
// immediately and post the real answer to response_url from a background task.
//
// Access control: the Slack user's email is looked up and mapped to an OpsPilot
// account. We then obtain a short-lived session FOR THAT USER (admin magic-link +
// verifyOtp, done server-side), so the same row-level security applies in Slack as
// in the web app. Unknown Slack users get no access.
import { createClient, type SupabaseClient } from "../_shared/deps.ts";
import { requireEnv, runInBackground } from "../_shared/http.ts";
import { answerForUser } from "../_shared/pipeline.ts";
import type { Source } from "../_shared/answer.ts";

const SUPABASE_URL = requireEnv("SUPABASE_URL");
const admin = createClient(SUPABASE_URL, requireEnv("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

async function verifySlackSignature(req: Request, rawBody: string): Promise<boolean> {
  const ts = req.headers.get("x-slack-request-timestamp") ?? "";
  const sig = req.headers.get("x-slack-signature") ?? "";
  if (!ts || !sig || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // replay protection
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(requireEnv("SLACK_SIGNING_SECRET")),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${ts}:${rawBody}`));
  const expected = "v0=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  // constant-time comparison
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

async function slackEmail(slackUserId: string): Promise<string | null> {
  const res = await fetch(`https://slack.com/api/users.info?user=${encodeURIComponent(slackUserId)}`, {
    headers: { Authorization: `Bearer ${requireEnv("SLACK_BOT_TOKEN")}` },
  });
  const data = await res.json();
  return data.ok ? data.user?.profile?.email ?? null : null;
}

/** A Supabase client acting as the OpsPilot user with this email, or null. */
async function clientForEmail(email: string): Promise<{ client: SupabaseClient; userId: string } | null> {
  const { data: profile } = await admin.from("profiles").select("id").ilike("email", email).maybeSingle();
  if (!profile) return null;
  const { data: link, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error || !link?.properties?.hashed_token) return null;
  const anon = createClient(SUPABASE_URL, requireEnv("SUPABASE_ANON_KEY"), { auth: { persistSession: false } });
  const { data: session } = await anon.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: "magiclink" });
  if (!session?.session) return null;
  const client = createClient(SUPABASE_URL, requireEnv("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: `Bearer ${session.session.access_token}` } },
    auth: { persistSession: false },
  });
  return { client, userId: profile.id };
}

function formatSources(sources: Source[]): string {
  if (!sources.length) return "";
  return "\n\n*Sources*\n" + sources
    .map((s) => `• [${s.label}] ${s.title}${s.heading && s.type === "document" ? ` — ${s.heading}` : ""}`)
    .join("\n");
}

async function respond(responseUrl: string, text: string) {
  await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response_type: "ephemeral", text }),
  });
}

async function handle(userId: string, question: string, responseUrl: string) {
  try {
    const email = await slackEmail(userId);
    const acting = email ? await clientForEmail(email) : null;
    if (!acting) {
      await respond(responseUrl, "Your Slack email isn't linked to an OpsPilot account, so I can't look anything up for you. Ask an admin to add you.");
      return;
    }
    const r = await answerForUser(acting.client, acting.userId, question, "slack");
    await respond(responseUrl, `*Q:* ${question}\n${r.answer}${formatSources(r.sources)}\n_${(r.latency_ms / 1000).toFixed(1)} s · route: ${r.route}_`);
  } catch (e) {
    console.error(e);
    await respond(responseUrl, "Sorry, something went wrong while answering.");
  }
}

Deno.serve(async (req) => {
  const raw = await req.text();
  if (!(await verifySlackSignature(req, raw))) return new Response("Invalid signature", { status: 401 });
  const form = new URLSearchParams(raw);
  const question = (form.get("text") ?? "").trim();
  if (!question) {
    return Response.json({ response_type: "ephemeral", text: "Usage: `/opspilot What approvals do I need for a ₹3.5 lakh PO?`" });
  }
  runInBackground(handle(form.get("user_id") ?? "", question, form.get("response_url") ?? ""));
  return Response.json({ response_type: "ephemeral", text: `Looking that up… _${question}_` });
});
