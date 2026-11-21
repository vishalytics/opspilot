# OpsPilot — notes for Claude Code

Procurement RAG copilot. Stack: Supabase (Postgres + pgvector, Auth, Storage, Edge Functions in Deno/TypeScript), React + Vite + TypeScript on Netlify, Gemini API. Synthetic data in `data/`.

Rules:
- Never use the service-role key in code that answers user questions. Only `ingest`, `scripts/`, and the `slack` function (solely to map a Slack user to their account and mint that user's session) use it.
- No secrets in the repo. Everything comes from `.env` / function secrets.
- Model names and prices come from env vars. Never hard-code them.
- Every database change is a new migration in `supabase/migrations/`. Add a test to `test/sql.test.ts` for any new RLS policy or SQL tool.
- `supabase/functions/_shared/{po-extract,chunker,guardrails,cost,answer,gemini}.ts` must stay free of Deno-only imports so Node tests can run them. Put Deno imports in `deps.ts` (answer path) / `deps-ingest.ts` + `parse.ts` (ingest). Supabase only bundles npm:/jsr: imports, not arbitrary URLs.
- Run `npm test` before committing; run `deno check supabase/functions/*/index.ts` after changing functions.
- Explain design changes in `docs/decisions.md`.
