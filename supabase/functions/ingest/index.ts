// POST /functions/v1/ingest  { document_id }
//
// Called by a database trigger (pg_net) when a documents row is inserted, with the
// shared secret in x-webhook-secret. An admin can also call it with their JWT to
// retry a failed document. It answers 202 at once and does the work in the
// background, updating documents.status: queued -> parsing -> embedding -> live | failed.
//
// This is the only function that uses the service-role key: it writes chunks and
// PO rows that normal users can only read.
import { createClient, type SupabaseClient } from "../_shared/deps.ts";
import { corsHeaders, env, json, requireEnv, runInBackground } from "../_shared/http.ts";
import { parseDocument, parseWorkbook } from "../_shared/parse.ts";
import { chunkSections } from "../_shared/chunker.ts";
import { detectInjection } from "../_shared/guardrails.ts";
import { configFromEnv, embed } from "../_shared/gemini.ts";
import { extractPo } from "../_shared/po-extract.ts";

const admin = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});

async function authorised(req: Request): Promise<boolean> {
  const secret = env("WEBHOOK_SECRET");
  if (secret && req.headers.get("x-webhook-secret") === secret) return true;
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user) return false;
  const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).single();
  return profile?.role === "admin";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!(await authorised(req))) return json({ error: "Unauthorised" }, 401);
  const { document_id } = await req.json().catch(() => ({}));
  if (!document_id) return json({ error: "document_id is required" }, 400);

  const { data: doc } = await admin.from("documents").select("*").eq("id", document_id).single();
  if (!doc) return json({ error: "Document not found" }, 404);

  runInBackground(processDocument(admin, doc));
  return json({ accepted: true, document_id }, 202);
});

async function setStatus(db: SupabaseClient, id: string, status: string, extra: Record<string, unknown> = {}) {
  await db.from("documents").update({ status, updated_at: new Date().toISOString(), ...extra }).eq("id", id);
}

async function processDocument(db: SupabaseClient, doc: any) {
  const started = Date.now();
  try {
    await setStatus(db, doc.id, "parsing", { error: null });

    // Skip exact duplicates of a document that is already live.
    if (doc.checksum) {
      const { data: dup } = await db.from("documents").select("id, title").eq("checksum", doc.checksum)
        .eq("status", "live").neq("id", doc.id).limit(1);
      if (dup?.length) {
        await db.from("ingestion_exceptions").insert({ document_id: doc.id, source_file: doc.source_file, code: "DUPLICATE", detail: `Same file as "${dup[0].title}"` });
        await setStatus(db, doc.id, "failed", { error: `Duplicate of ${dup[0].title}` });
        return;
      }
    }

    const { data: blob, error: dlErr } = await db.storage.from("docs").download(doc.storage_path);
    if (dlErr || !blob) throw new Error(`Download failed: ${dlErr?.message}`);
    const bytes = new Uint8Array(await blob.arrayBuffer());

    if (doc.kind === "po") await ingestPo(db, doc, bytes);
    else await ingestText(db, doc, bytes);
    console.log(JSON.stringify({ event: "ingested", document: doc.source_file, ms: Date.now() - started }));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(JSON.stringify({ event: "ingest_failed", document: doc.source_file, error: message }));
    await db.from("ingestion_exceptions").insert({ document_id: doc.id, source_file: doc.source_file, code: "PARSE_ERROR", detail: message.slice(0, 500) });
    await setStatus(db, doc.id, "failed", { error: message.slice(0, 500) });
  }
}

async function ingestText(db: SupabaseClient, doc: any, bytes: Uint8Array) {
  const sections = await parseDocument(bytes, doc.source_file);
  const chunks = chunkSections(doc.title, sections, {
    maxTokens: Number(env("CHUNK_MAX_TOKENS") || 500),
    overlapTokens: Number(env("CHUNK_OVERLAP_TOKENS") || 50),
  });
  if (!chunks.length) throw new Error("No text found in document");

  await setStatus(db, doc.id, "embedding");
  const vectors = await embed(configFromEnv(env), chunks.map((c) => c.content), "RETRIEVAL_DOCUMENT");

  await db.from("chunks").delete().eq("document_id", doc.id); // re-ingest replaces old chunks
  const rows = chunks.map((c, i) => ({
    document_id: doc.id,
    departments: doc.departments,
    chunk_index: c.chunk_index,
    heading: c.heading,
    content: c.content,
    token_count: c.token_count,
    embedding: vectors[i],
    flagged_injection: detectInjection(c.content) !== null,
  }));
  const { error } = await db.from("chunks").insert(rows);
  if (error) throw new Error(`Insert chunks failed: ${error.message}`);
  await setStatus(db, doc.id, "live", { chunk_count: rows.length });
}

async function ingestPo(db: SupabaseClient, doc: any, bytes: Uint8Array) {
  const { po, issues } = extractPo(parseWorkbook(bytes), doc.source_file);
  await db.from("ingestion_exceptions").delete().eq("document_id", doc.id);
  if (issues.length) {
    await db.from("ingestion_exceptions").insert(
      issues.map((i) => ({ document_id: doc.id, source_file: doc.source_file, code: i.code, detail: i.detail })),
    );
  }
  if (!po) throw new Error(issues[0]?.detail ?? "Could not read PO");

  // A revision supersedes earlier versions; an original that arrives after its revision is superseded at once.
  let status: string = po.status;
  if (po.revision) {
    await db.from("purchase_orders").update({ status: "Superseded" })
      .eq("po_number", po.po_number).lt("revision", po.revision).eq("status", "Open");
  } else {
    const { data: later } = await db.from("purchase_orders").select("revision").eq("po_number", po.po_number).neq("revision", "");
    if (later?.length && status === "Open") status = "Superseded";
  }

  const { lines, ...header } = po;
  const { error: poErr } = await db.from("purchase_orders").upsert({ ...header, status, document_id: doc.id }, { onConflict: "po_number,revision" });
  if (poErr) throw new Error(`Upsert PO failed: ${poErr.message}`);
  await db.from("po_lines").delete().eq("po_number", po.po_number).eq("revision", po.revision);
  if (lines.length) {
    const { error } = await db.from("po_lines").insert(lines.map((l) => ({ ...l, po_number: po.po_number, revision: po.revision })));
    if (error) throw new Error(`Insert PO lines failed: ${error.message}`);
  }
  await setStatus(db, doc.id, "live", { chunk_count: 0 });
}
