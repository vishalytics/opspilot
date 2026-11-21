// Post-deploy check: counts what was ingested and asks three real questions
// as different users. Prints GitHub annotations (::notice / ::error) so results
// are visible in the Actions UI and API without opening the logs.
//   npx tsx scripts/smoke.ts
import { adminClient, anonClient, need, SUPABASE_URL } from "./lib.ts";

const gh = (level: "notice" | "error" | "warning", title: string, msg: string) =>
  console.log(`::${level} title=${title}::${msg.replace(/\r?\n/g, " ").slice(0, 900)}`);

async function counts() {
  const db = adminClient();
  const c = async (t: string, f?: (q: any) => any) => {
    let q = db.from(t).select("*", { count: "exact", head: true });
    if (f) q = f(q);
    return (await q).count ?? 0;
  };
  const docs = await c("documents"), live = await c("documents", (q) => q.eq("status", "live"));
  const failed = await c("documents", (q) => q.eq("status", "failed"));
  const pending = await c("documents", (q) => q.in("status", ["queued", "parsing", "embedding"]));
  const chunks = await c("chunks"), pos = await c("purchase_orders"), lines = await c("po_lines");
  const flagged = await c("chunks", (q) => q.eq("flagged_injection", true));
  const { data: exc } = await db.from("ingestion_exceptions").select("source_file, code");
  const { data: failedDocs } = await db.from("documents").select("source_file, error").eq("status", "failed");
  const summary = `documents=${docs} live=${live} failed=${failed} pending=${pending} chunks=${chunks} flagged_chunks=${flagged} purchase_orders=${pos} po_lines=${lines} exceptions=${(exc ?? []).map((e) => e.code).join(",")}`;
  gh(failed || pending ? "error" : "notice", "Ingestion", summary);
  for (const d of failedDocs ?? []) gh("error", "Failed document", `${d.source_file}: ${d.error}`);
  return failed === 0 && pending === 0 && chunks > 0 && pos > 0;
}

async function ask(email: string, question: string) {
  const { data, error } = await anonClient().auth.signInWithPassword({ email, password: need("DEMO_PASSWORD") });
  if (error || !data.session) { gh("error", "Login", `${email}: ${error?.message}`); return false; }
  const t = Date.now();
  const res = await fetch(`${SUPABASE_URL()}/functions/v1/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session.access_token}`, apikey: need("SUPABASE_ANON_KEY") },
    body: JSON.stringify({ question, channel: "eval" }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { gh("error", `Ask failed (${email})`, `HTTP ${res.status}: ${JSON.stringify(body)}`); return false; }
  gh("notice", `Ask as ${email.split("@")[0]}`,
    `Q: ${question} | route=${body.route} | ${Date.now() - t} ms | cost=₹${body.cost_inr} | flags=${(body.flags ?? []).join(",")} | sources=${(body.sources ?? []).map((s: any) => s.label + ":" + (s.source_file ?? s.title)).join("; ")} | A: ${body.answer}`);
  return body.route !== "error";
}

const ok = [
  await counts(),
  await ask("buyer@prakriti.demo", "What approvals are needed to release a PO worth ₹3.5 lakh including GST?"),
  await ask("buyer@prakriti.demo", "What was the last rate we paid for WPC80?"),
  await ask("warehouse@prakriti.demo", "What is the contracted WPC80 rate with Aarav?"),
].every(Boolean);
process.exit(ok ? 0 : 1);
