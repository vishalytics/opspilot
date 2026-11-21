# Solution design — OpsPilot procurement copilot

**Client (fictional):** Prakriti Nutrition Pvt. Ltd., a sports-nutrition manufacturer with warehouses in Manesar and Bhiwandi.

## 1. Problem

Procurement knowledge lives in two places that don't talk to each other:

- **Documents**: procurement policy, invoice and payment policy, SOPs (vendor onboarding, goods receipt, slot booking), rate contracts and supply agreements.
- **Purchase orders**: Excel files in three inconsistent templates (an old one, a new one, and a legacy .xls used by one branch), saved in monthly folders.

Buyers, finance and warehouse staff ask the same questions repeatedly ("who approves this?", "what did we last pay?", "is this within contract?"). Answering means opening several files and spreadsheets. Compliance checks (contract rate breaches, approval-matrix breaches) are done by hand, if at all.

## 2. Users and access

| User | Needs | May see |
| --- | --- | --- |
| Buyer (procurement) | Policy answers, last prices, contract terms, compliance checks, upload new files | Policies, SOPs, contracts, vendor correspondence, PO data |
| Finance | Payment terms, approval checks, spend | Policies, contracts, PO data |
| Warehouse | Receiving and slot-booking procedures | Warehouse SOPs only; **no prices** |
| Admin | Everything, plus monitoring and evaluation | All |

## 3. Scope

**In:** question answering over documents and PO data with citations; upload and automatic ingestion; PO extraction with exception logging; department-level access control; web app; Slack slash command; guardrails; monitoring, cost tracking and evaluation.

**Out (for this phase):** creating or approving POs; ERP integration; SSO; multi-language; OCR of scanned PDFs.

## 4. Architecture

See the diagram in the [README](../README.md#architecture).

| Layer | Component |
| --- | --- |
| Channels | React web app (Netlify), Slack `/opspilot` |
| Orchestration | `ask` Edge Function: guardrails, Gemini function calling, tool execution, grounding check, logging |
| Retrieval | `hybrid_search` (Postgres full-text + pgvector, RRF) |
| Structured data tools | SQL functions over `purchase_orders`, `po_lines`, `rate_contracts` |
| Ingestion | Storage → `documents` row → trigger (pg_net) → `ingest` Edge Function (background) |
| Models | Gemini chat (function calling), `gemini-embedding-001` (768 dims) |
| Security | Supabase Auth, Postgres RLS by department, user-scoped DB clients, secrets in function env |
| Observability | `query_logs`, `eval_runs`, `eval_results`, LLMOps page |

## 5. Data flow

1. **Ingest:** upload → checksum de-duplication → status `queued` → trigger → parse → chunk / extract → embed → `live` (or `failed` + exception).
2. **Answer:** question → input guardrails → model selects tools → tools run as the user → model answers with citations → grounding check → PII masking → log.

## 6. Security model

- **Least privilege:** the browser holds only the public key and the user's session. The service-role key exists only in the `ingest` function, the setup scripts, and the `slack` function, where it is used solely to find the Slack user's account and create a session for them; the answer itself runs as that user.
- **Authorisation in the database:** RLS on every table; the answer path uses the caller's JWT, so retrieval is filtered before the model sees anything.
- **Untrusted content:** document text is treated as data (tagged, flagged at ingest, warned in context). User questions that try to override instructions are refused.
- **Sensitive data:** bank account numbers, IFSC, PAN and phone numbers are masked in answers, sources and logs. GSTINs (public business identifiers) are kept.
- **Audit:** every query is logged with user, channel, tools used, chunk ids, model, prompt version and flags. Users can read only their own logs; admins read all.

## 7. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Hallucinated answers | Tool-only answers, mandatory citations, grounding check, eval set |
| Cross-department leakage | RLS + user-scoped clients; tested with PGlite |
| Prompt injection via documents | Flag at ingest, isolate as data, warning in context, eval question Q25 |
| Wrong numbers | Numbers come from SQL tools, not from text generation |
| New PO template | Logged as `UNKNOWN_TEMPLATE`; extractor tested against ground truth |
| Cost growth | Per-query cost logged; tool-call cap; model and prices configurable |
| Free-tier rate limits | Retries with backoff; paced bulk ingest and eval |

## 8. Success measures

- Answer accuracy on the eval set (target ≥ 85%), retrieval hit rate (target ≥ 90%).
- p95 latency under 10 s.
- Cost per query visible and stable.
- Zero RLS test failures; all planted PO problems detected.
