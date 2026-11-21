# Design decisions

| # | Decision | Alternatives considered | Why |
| --- | --- | --- | --- |
| 1 | Supabase for DB, auth, storage and server functions | Separate vector DB (Pinecone), Netlify Functions, a Node server | One platform keeps the security model (RLS) in one place; vectors sit next to relational PO data; background tasks work on the free plan |
| 2 | Netlify hosts only the static React app | Server-side rendering, Netlify Functions | Nothing secret runs in the browser; simplest possible hosting |
| 3 | Hybrid search with Reciprocal Rank Fusion | Vector only; keyword only; weighted score sum | Exact codes + paraphrases; RRF combines ranks without score calibration |
| 4 | Chunk by heading, ≤500 tokens, 50 overlap, with a "Document > Section" prefix | Fixed-size windows | Questions map to sections; prefixes make chunks self-explanatory and keyword-matchable |
| 5 | `gemini-embedding-001` at 768 dimensions, normalised | 3072 dimensions; another provider | Recommended size, small index, free tier for development |
| 6 | Chat model set by env var (`gemini-flash-latest` default) | Hard-coded model name | Model names change; swap without code changes; compare in evals |
| 7 | Model calls fixed SQL tools, never writes SQL | Text-to-SQL | Safety, auditability, RLS, deterministic numbers |
| 8 | Business rules (live POs, approval bands) in SQL | In the prompt | Testable, consistent, independent of the model |
| 9 | RLS by department arrays + `my_departments()` | Filtering in application code | The database enforces access even if the app or prompt is wrong |
| 10 | Answer path uses the user's JWT; service role only in ingest | Service role everywhere with manual filters | One mistake would expose everything |
| 11 | Slack users get a server-side session for their matching account | Service-role queries for Slack | Same RLS in every channel |
| 12 | Database trigger + pg_net to start ingestion | Client calls the function; cron polling | Event-driven, no client secrets, nothing to poll |
| 13 | Grounding check replaces uncited answers | Trust the prompt | Cheap, deterministic protection against hallucination |
| 14 | Versioned prompts in a table, version logged per query | Prompts in code | Change prompts without deploys; compare versions in evals |
| 15 | Own DOCX reader (word/document.xml) instead of mammoth | mammoth | mammoth fails in Supabase's Deno runtime (`__proto__` disabled) |
| 16 | Excel dates read as serial numbers, converted in UTC | `cellDates: true` | Date objects shifted 19 POs by a day (caught by the ground-truth test) |
| 17 | SheetJS from npm (`xlsx` 0.18.5) in the ingest function only | SheetJS 0.20.3 from cdn.sheetjs.com | Supabase's bundler refuses imports from that host. The npm build has known issues with crafted files, so only admins/procurement can upload and parsing is isolated in `ingest`; revisit when Supabase allows the host or a patched build reaches npm |
| 18 | Eval runs as the right user per question, LLM judge + retrieval hit | Manual spot checks | Repeatable, comparable across configurations |
| 19 | Explicit API grants in a migration (`000500_api_grants.sql`) | Rely on the project setting "Grant API access to new tables automatically" | New projects can be created with that setting off, which makes every query fail with "permission denied". Explicit grants work either way; RLS still filters rows. app_config is revoked from API roles |
| 20 | Deploy from GitHub Actions (`deploy.yml`), CLI pinned to v2 | Local terminal only; latest CLI | No local setup needed; secrets live in GitHub. CLI v3 changed `db push` to target the local stack by default, so v2 is pinned |
| 21 | Deploy workflow also runs on every push to main touching the backend | Manual runs only | Continuous deployment; bulk ingest is idempotent (checksum skip), so repeats are cheap |
| 22 | Deploy workflow commits `web/.env.production` (URL + anon key) and disables public sign-ups | Manual Netlify environment variables | The anon key is public by design (it ships in the JS bundle; RLS protects data). Disabling sign-ups stops strangers creating accounts that could spend the Gemini quota |
