// Uploads the dataset (9 documents + 43 PO files) and lets the event-driven
// pipeline process them: insert documents row -> DB trigger -> ingest function.
//   npx tsx scripts/bulk-ingest.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { adminClient, readCsv, sha256, sleep } from "./lib.ts";

const db = adminClient();
const KIND: Record<string, string> = { policies: "policy", sops: "sop", contracts: "contract", vendor_correspondence: "correspondence" };

async function main() {
  const { data: adminUser } = await db.from("profiles").select("id").eq("role", "admin").limit(1).single();
  if (!adminUser) throw new Error("Run scripts/seed.ts first (no admin user found)");

  const access = readCsv<{ file: string; title: string; departments: string }>("data/seed/document_access.csv");
  const items = access.map((a) => ({
    path: join("data", a.file), title: a.title, kind: KIND[a.file.split("/")[1]], departments: a.departments.split("|"),
  }));
  for (const month of readdirSync("data/purchase_orders")) {
    for (const f of readdirSync(join("data/purchase_orders", month))) {
      items.push({ path: join("data/purchase_orders", month, f), title: `PO ${f.replace(/\.[^.]+$/, "")}`, kind: "po", departments: ["procurement", "finance"] });
    }
  }

  let queued = 0;
  for (const it of items) {
    const buf = readFileSync(it.path);
    const checksum = sha256(buf);
    const { data: dup } = await db.from("documents").select("id").eq("checksum", checksum).limit(1);
    if (dup?.length) { console.log(`· skip (already uploaded) ${it.path}`); continue; }
    const storagePath = `seed/${it.path.replace(/^data\//, "")}`;
    const { error: upErr } = await db.storage.from("docs").upload(storagePath, buf, { upsert: true });
    if (upErr) throw new Error(`${it.path}: ${upErr.message}`);
    const { error } = await db.from("documents").insert({
      title: it.title, source_file: it.path.split("/").pop(), kind: it.kind, departments: it.departments,
      storage_path: storagePath, checksum, created_by: adminUser.id,
    });
    if (error) throw new Error(`${it.path}: ${error.message}`);
    queued++;
    console.log(`↑ queued ${it.path}`);
    await sleep(it.kind === "po" ? 150 : 1500); // pace embedding calls for the Gemini free tier
  }
  console.log(`\n${queued} files queued. Waiting for ingestion…`);

  for (let i = 0; i < 60; i++) {
    const { data } = await db.from("documents").select("status");
    const counts = (data ?? []).reduce<Record<string, number>>((a, d) => ((a[d.status] = (a[d.status] ?? 0) + 1), a), {});
    process.stdout.write(`\r${JSON.stringify(counts)}      `);
    if (!counts.queued && !counts.parsing && !counts.embedding) break;
    await sleep(5000);
  }
  const { data: failed } = await db.from("documents").select("source_file, error").eq("status", "failed");
  const { data: exc } = await db.from("ingestion_exceptions").select("source_file, code, detail");
  const { count: pos } = await db.from("purchase_orders").select("*", { count: "exact", head: true });
  const { count: chunks } = await db.from("chunks").select("*", { count: "exact", head: true });
  console.log(`\n\n✓ ${chunks} chunks, ${pos} PO rows`);
  console.log("Exceptions:", exc?.map((e) => `${e.source_file}: ${e.code}`) ?? []);
  if (failed?.length) {
    console.log("Failed:", failed);
    console.log("Fix the cause, then run: npx tsx scripts/reingest.ts");
  }
  const { data: queuedLeft } = await db.from("documents").select("id").eq("status", "queued");
  if (queuedLeft?.length) console.log(`${queuedLeft.length} still queued: is the trigger configured? Run: npx tsx scripts/reingest.ts`);
}

main().catch((e) => { console.error("Bulk ingest failed:", e.message ?? e); process.exit(1); });
