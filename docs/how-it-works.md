# How OpsPilot works — code walkthrough and interview prep

Read this file by file before an interview. For each part: what it does, where it lives, and the questions you should expect.

## 1. A question, end to end

1. **Web app** ([`web/src/pages/Ask.tsx`](../web/src/pages/Ask.tsx)) calls `supabase.functions.invoke("ask", { body: { question } })`. supabase-js attaches the logged-in user's access token (a JWT).
2. **`ask` function** ([`supabase/functions/ask/index.ts`](../supabase/functions/ask/index.ts)) builds a Supabase client **with that JWT**, checks the user with `auth.getUser`, and calls `answerForUser` ([`_shared/pipeline.ts`](../supabase/functions/_shared/pipeline.ts)).
3. **Pipeline** loads the user's departments and the active `answer` prompt, then runs [`answerQuestion`](../supabase/functions/_shared/answer.ts):
   - `checkQuestion` rejects empty, over-long or injection-style questions before any model call.
   - Gemini receives the system prompt, the question and 9 tool declarations. It replies with function calls.
   - `search_documents` embeds the query (`RETRIEVAL_QUERY`, 768 dims) and calls the `hybrid_search` SQL function. Results are labelled D1, D2… and wrapped in `<document>` tags.
   - PO tools map to fixed SQL functions (`rpcFor`). Results are labelled T1, T2…
   - Up to 3 tool calls; then Gemini must answer, citing labels.
   - **Grounding check:** no valid citation → replaced with "I couldn't find this in the documents you have access to."
   - **PII masking** on the answer and on the sources shown.
   - One row is written to `query_logs`: tokens, ₹ cost, retrieval vs LLM time, tools used, chunk ids, flags.
4. The web app renders `[D1]` as buttons that expand the source text.

## 2. A document, end to end

1. **Upload** ([`Documents.tsx`](../web/src/pages/Documents.tsx)): the browser computes a SHA-256 checksum, skips duplicates, uploads to the private `docs` bucket, and inserts a `documents` row (`status = queued`). RLS allows this only for procurement users and admins.
2. **Trigger** ([`20251121000400_platform.sql`](../supabase/migrations/20251121000400_platform.sql)): `documents_notify_ingest` calls `net.http_post` (pg_net) to the `ingest` function with a shared secret. The insert doesn't wait.
3. **`ingest`** ([`ingest/index.ts`](../supabase/functions/ingest/index.ts)) returns 202 and continues in `EdgeRuntime.waitUntil`:
   - Text documents: `parseDocument` → `textToSections` (PDF) or `docxXmlToSections` (DOCX) → `chunkSections` → `detectInjection` per chunk → `embed` (`RETRIEVAL_DOCUMENT`) → insert chunks → `live`.
   - POs: `parseWorkbook` → `extractPo` → upsert `purchase_orders` and `po_lines`, log `ingestion_exceptions`, handle revisions → `live`.
   - Any error → `failed` with the message, plus a `PARSE_ERROR` exception. Admins can press **Re-run**.
4. The Documents page subscribes to Realtime, so status changes appear live.

## 3. Key design points, with the answer you give

**Why hybrid search?** Procurement questions mix meaning ("how do I add a supplier?") with exact tokens ("WPC80", "SOP-WH-04", "₹5,00,000"). Vector search finds paraphrases but can miss codes; full-text search finds codes but misses paraphrases. Reciprocal Rank Fusion merges the two *rank* lists, so I don't have to calibrate a cosine score against a ts_rank score.

**How did you chunk?** By section heading first, because policies and SOPs are already organised by numbered sections and a question usually maps to one section. Sections over 500 tokens are split by sentence with ~50 tokens of overlap. Each chunk starts with "Document: … > Section: …" so it is understandable on its own and keyword search can match the document name. I can test 300 vs 500 tokens with the eval set.

**How do you stop data leaking between departments?** Row-level security in Postgres. Every chunk carries its document's departments; policies compare them with `my_departments()` for the caller. The `ask` function uses the user's JWT, never the service-role key, so even a successful prompt injection can't retrieve rows the user can't see. The PGlite test proves it with a warehouse user.

**How does Slack respect the same rules?** Slack gives a user ID, not a JWT. The function looks up the user's email in Slack, finds the matching OpsPilot profile, and creates a short-lived session for that user on the server (admin magic link + `verifyOtp`). The answer then runs through the same pipeline under RLS. Unknown Slack users get nothing.

**Why not let the LLM write SQL?** Fixed parameterised tools are auditable, can't be injected, respect RLS, and return the same number every time. Business rules (exclude cancelled and superseded POs; what "approval violation" means) live in SQL, where they can be tested, instead of being re-derived by the model on each question.

**How do you handle prompt injection?** Three layers. Questions that look like injection are refused before any model call. At ingest, chunks with instruction-like text are flagged (the planted Zenith quotation). At answer time, document text is wrapped in `<document>` tags, the system prompt says document text is data, and flagged chunks carry a warning. The flag is logged.

**How do you know the answers are right?** A 26-question eval set with expected answers and sources, run as the right user for each question. Retrieval hit rate is computed automatically; answer correctness by an LLM judge whose reasons I review. Each run stores its configuration, so I can compare changes.

**What does a query cost and how fast is it?** Read it from the LLMOps page after running the eval: cost per query in ₹ (from token counts × env prices), p50/p95 latency split into retrieval and LLM time.

**Why Supabase Edge Functions instead of Netlify Functions?** Background work after the response (`EdgeRuntime.waitUntil`) is available on Supabase's free plan, within its time limits; Netlify's long-running background functions are a paid feature. Keeping auth, data and functions on one platform also keeps the security model in one place. Netlify only serves static files.

**Why 768-dimension embeddings?** `gemini-embedding-001` supports smaller outputs (Matryoshka representation learning). 768 is one of Google's recommended sizes and keeps the index small for this corpus. Truncated vectors are normalised before storage so cosine distance behaves consistently.

**Tell me about a bug you found.** The PO ground-truth test showed 19 POs dated one day early. Reading Excel dates as JavaScript `Date` objects applied a time-zone conversion. I switched to reading the Excel serial numbers and converting them in UTC. Separately, the DOCX library I first used (mammoth) failed inside Supabase's Deno runtime because it relies on `Object.prototype.__proto__`, which Deno disables; I replaced it with a 25-line reader of `word/document.xml`.

**What would you change for production?** A queue with retries for ingestion, a re-ranker, SSO with department claims from the identity provider, a governed model endpoint with data-residency review, an LLM-assisted extractor for unknown PO templates with human review, and an eval set built from real user questions with scheduled runs.

## 4. Things to be able to show live

- `npm test` passing (22 tests), including the RLS test and the 100% extractor score.
- A question with a `[D1]` citation; expand the source.
- The contract-breach question (route: Documents + PO data).
- The warehouse user being blocked.
- The Exceptions tab with the three planted problems.
- A Slack answer.
- The LLMOps page with at least two eval runs to compare.
