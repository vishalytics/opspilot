// Calls the ingest function directly for documents that are queued or failed
// (e.g. if the database trigger was not configured yet). Add --all to redo everything.
//   npx tsx scripts/reingest.ts [--all]
import { adminClient, need, sleep, SUPABASE_URL } from "./lib.ts";

const db = adminClient();
const all = process.argv.includes("--all");

const q = db.from("documents").select("id, source_file, kind, status");
const { data: docs, error } = all ? await q : await q.in("status", ["queued", "failed"]);
if (error) throw error;
console.log(`${docs?.length ?? 0} documents to (re)ingest`);
for (const d of docs ?? []) {
  const res = await fetch(`${SUPABASE_URL()}/functions/v1/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-webhook-secret": need("WEBHOOK_SECRET") },
    body: JSON.stringify({ document_id: d.id }),
  });
  console.log(`${res.status} ${d.source_file}`);
  await sleep(d.kind === "po" ? 150 : 1500);
}
