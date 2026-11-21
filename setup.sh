#!/usr/bin/env bash
# One-time setup of the Supabase side of OpsPilot.
# Prerequisites: Node 20+, a Supabase project, a Gemini API key, a filled-in .env,
# and `npx supabase@2 login` done once (opens a browser). No terminal? Use the
# "Deploy to Supabase" GitHub Action instead (see README).
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then echo "Create .env first: cp .env.example .env  (then fill it in)"; exit 1; fi
set -a; source .env; set +a

for v in SUPABASE_PROJECT_REF SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY SUPABASE_DB_PASSWORD GEMINI_API_KEY WEBHOOK_SECRET DEMO_PASSWORD; do
  if [ -z "${!v:-}" ]; then echo "Missing $v in .env"; exit 1; fi
done

# Pinned to Supabase CLI v2: in v3, `db push` targets a local stack unless told otherwise.
SB="npx --yes supabase@2"
export SUPABASE_YES=1

echo "→ Installing script dependencies"
npm install --silent

echo "→ Linking project $SUPABASE_PROJECT_REF"
$SB link --project-ref "$SUPABASE_PROJECT_REF" --password "$SUPABASE_DB_PASSWORD"

echo "→ Applying database migrations (tables, RLS, search, tools, prompts, storage, trigger)"
$SB db push --password "$SUPABASE_DB_PASSWORD" --include-all

echo "→ Setting function secrets"
SECRETS=$(mktemp)
for v in GEMINI_API_KEY GEMINI_CHAT_MODEL GEMINI_EMBED_MODEL PRICE_IN_PER_M PRICE_OUT_PER_M PRICE_EMBED_PER_M USD_INR \
         MATCH_COUNT FULL_TEXT_WEIGHT SEMANTIC_WEIGHT CHUNK_MAX_TOKENS CHUNK_OVERLAP_TOKENS WEBHOOK_SECRET \
         SLACK_SIGNING_SECRET SLACK_BOT_TOKEN; do
  if [ -n "${!v:-}" ]; then echo "$v=${!v}" >> "$SECRETS"; fi
done
$SB secrets set --env-file "$SECRETS" --project-ref "$SUPABASE_PROJECT_REF"
rm -f "$SECRETS"

echo "→ Deploying Edge Functions (no Docker needed)"
$SB functions deploy ask ingest slack --project-ref "$SUPABASE_PROJECT_REF" --use-api --no-verify-jwt

echo "→ Seeding config, demo users and rate contracts"
npx tsx scripts/seed.ts

echo "→ Uploading and ingesting the dataset (takes a few minutes)"
npx tsx scripts/bulk-ingest.ts

echo
echo "✓ Supabase side is ready."
echo "  Next: deploy web/ on Netlify (see README), or run it locally:"
echo "    cd web && cp .env.example .env.local  # fill in URL + anon key"
echo "    npm install && npm run dev"
echo "  Then run the evaluation: npx tsx scripts/run-eval.ts --label baseline"
