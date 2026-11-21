// Runs the 26-question eval set against the deployed system, as the right user
// for each question, and stores the scores in eval_runs / eval_results.
//
//   npx tsx scripts/run-eval.ts --label "hybrid, 500-token chunks"
//
// Two scores:
//  - retrieval hit: did the answer draw on the expected source? (automatic)
//  - answer accuracy: an LLM judge compares the answer with the expected answer.
//    Review the judge's reasons once by hand; judges make mistakes too.
import { mkdirSync, writeFileSync } from "node:fs";
import { adminClient, anonClient, need, readCsv, sleep, SUPABASE_URL } from "./lib.ts";
import { configFromEnv, generate } from "../supabase/functions/_shared/gemini.ts";

interface Q { id: string; category: string; ask_as: string; question: string; expected_answer: string; expected_source: string }
interface Source { label: string; type: string; title: string; source_file?: string }
interface Ask { answer: string; sources: Source[]; route: string; latency_ms: number; cost_inr: number; tool_calls: { name: string }[] }

const label = process.argv.includes("--label") ? process.argv[process.argv.indexOf("--label") + 1] : `run ${new Date().toISOString().slice(0, 16)}`;
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1].split(",") : null;
const delay = Number(process.env.EVAL_DELAY_MS ?? 4000); // free-tier friendly
const EMAIL: Record<string, string> = {
  procurement: "buyer@prakriti.demo", finance: "finance@prakriti.demo", warehouse: "warehouse@prakriti.demo", admin: "admin@prakriti.demo",
};

const tokens = new Map<string, string>();
async function tokenFor(who: string): Promise<string> {
  if (!tokens.has(who)) {
    const { data, error } = await anonClient().auth.signInWithPassword({ email: EMAIL[who], password: need("DEMO_PASSWORD") });
    if (error || !data.session) throw new Error(`Login failed for ${EMAIL[who]}: ${error?.message}`);
    tokens.set(who, data.session.access_token);
  }
  return tokens.get(who)!;
}

async function ask(q: Q): Promise<Ask> {
  const res = await fetch(`${SUPABASE_URL()}/functions/v1/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await tokenFor(q.ask_as)}`, apikey: need("SUPABASE_ANON_KEY") },
    body: JSON.stringify({ question: q.question, channel: "eval" }),
  });
  if (!res.ok) throw new Error(`ask ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Did the answer use the source the question needs? null = not applicable (refusal / access tests). */
function retrievalHit(q: Q, r: Ask): boolean | null {
  const files = r.sources.filter((s) => s.type === "document").map((s) => (s.source_file ?? "").toLowerCase());
  const tools = r.tool_calls.map((t) => t.name);
  const usesTool = tools.some((t) => t !== "search_documents");
  const docKey = q.expected_source.split(/[ ;§]/)[0].toLowerCase();
  switch (q.category) {
    case "po_data": return usesTool;
    case "cross": return usesTool && files.length > 0;
    case "ingestion": return tools.includes("list_ingestion_exceptions");
    case "guardrail_no_answer":
    case "rbac": return null;
    case "guardrail_injection": return files.some((f) => f.startsWith("rate_contract_aarav"));
    default: return files.some((f) => f.startsWith(docKey));
  }
}

async function judge(judgePrompt: string, q: Q, answer: string): Promise<{ passed: boolean; reason: string }> {
  const cfg = configFromEnv((k) => process.env[k]);
  const prompt = judgePrompt.replace("{{question}}", q.question).replace("{{expected}}", q.expected_answer).replace("{{answer}}", answer);
  const r = await generate(cfg, { system: "You are a strict, fair grader. Reply with JSON only.", contents: [{ role: "user", parts: [{ text: prompt }] }], json: true });
  try {
    const parsed = JSON.parse(r.text.replace(/^```json|```$/g, ""));
    return { passed: Boolean(parsed.passed), reason: String(parsed.reason ?? "") };
  } catch {
    return { passed: false, reason: `Judge returned unparseable output: ${r.text.slice(0, 120)}` };
  }
}

const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(0.95 * xs.length))] ?? 0;

async function main() {
  const db = adminClient();
  const { data: jp } = await db.from("prompts").select("template, version").eq("name", "judge").eq("is_active", true).single();
  const { data: ap } = await db.from("prompts").select("version").eq("name", "answer").eq("is_active", true).single();
  if (!jp) throw new Error("No active judge prompt");
  const questions = readCsv<Q>("data/eval/eval_set.csv").filter((q) => !only || only.includes(q.id));

  const rows = [];
  for (const q of questions) {
    process.stdout.write(`${q.id} ${q.question.slice(0, 60).padEnd(60)} `);
    let r: Ask;
    try { r = await ask(q); } catch (e) {
      console.log("ERROR", (e as Error).message);
      rows.push({ q, answer: `ERROR: ${(e as Error).message}`, hit: false, passed: false, reason: "request failed", latency: 0, cost: 0, cited: [] as string[] });
      continue;
    }
    await sleep(delay / 2);
    const j = await judge(jp.template, q, r.answer);
    const hit = retrievalHit(q, r);
    console.log(`${j.passed ? "PASS" : "FAIL"}  hit=${hit ?? "n/a"}  ${(r.latency_ms / 1000).toFixed(1)}s`);
    rows.push({ q, answer: r.answer, hit, passed: j.passed, reason: j.reason, latency: r.latency_ms, cost: Number(r.cost_inr), cited: r.sources.map((s) => `${s.label}:${s.source_file ?? s.title}`) });
    await sleep(delay / 2);
  }

  const applicable = rows.filter((r) => r.hit !== null);
  const summary = {
    label,
    config: {
      model: process.env.GEMINI_CHAT_MODEL ?? "gemini-flash-lite-latest",
      prompt_version: ap?.version ?? null,
      match_count: process.env.MATCH_COUNT ?? "8",
      weights: `${process.env.FULL_TEXT_WEIGHT ?? 1}/${process.env.SEMANTIC_WEIGHT ?? 1}`,
      chunk_max_tokens: process.env.CHUNK_MAX_TOKENS ?? "500",
    },
    questions: rows.length,
    retrieval_hit_rate: Math.round((1000 * applicable.filter((r) => r.hit).length) / Math.max(1, applicable.length)) / 10,
    answer_accuracy: Math.round((1000 * rows.filter((r) => r.passed).length) / Math.max(1, rows.length)) / 10,
    avg_latency_ms: Math.round(rows.reduce((a, r) => a + r.latency, 0) / Math.max(1, rows.length)),
    p95_latency_ms: p95(rows.map((r) => r.latency)),
    total_cost_inr: Math.round(rows.reduce((a, r) => a + r.cost, 0) * 10000) / 10000,
  };
  const { data: run, error } = await db.from("eval_runs").insert(summary).select("id").single();
  if (error) throw error;
  await db.from("eval_results").insert(rows.map((r) => ({
    run_id: run.id, question_id: r.q.id, category: r.q.category, ask_as: r.q.ask_as, question: r.q.question,
    expected_answer: r.q.expected_answer, answer: r.answer, cited_sources: r.cited, retrieval_hit: r.hit,
    passed: r.passed, judge_reason: r.reason, latency_ms: r.latency, cost_inr: r.cost,
  })));

  mkdirSync("eval-results", { recursive: true });
  const csv = ["id,category,passed,retrieval_hit,latency_ms,cost_inr,answer,judge_reason",
    ...rows.map((r) => [r.q.id, r.q.category, r.passed, r.hit ?? "", r.latency, r.cost, JSON.stringify(r.answer), JSON.stringify(r.reason)].join(","))].join("\n");
  writeFileSync(`eval-results/run-${run.id}.csv`, csv);

  console.log(`\nRun #${run.id} "${label}"`);
  console.log(`  answer accuracy  ${summary.answer_accuracy}%  (${rows.filter((r) => r.passed).length}/${rows.length})`);
  console.log(`  retrieval hit    ${summary.retrieval_hit_rate}%  (of ${applicable.length} applicable)`);
  console.log(`  latency          avg ${(summary.avg_latency_ms / 1000).toFixed(1)} s, p95 ${(summary.p95_latency_ms / 1000).toFixed(1)} s`);
  console.log(`  cost             ₹${summary.total_cost_inr} total`);
  console.log(`  details          eval-results/run-${run.id}.csv and the LLMOps page`);
  const fails = rows.filter((r) => !r.passed);
  if (fails.length) console.log("\nFailed:\n" + fails.map((r) => `  ${r.q.id}: ${r.reason}`).join("\n"));
}

main().catch((e) => { console.error("Eval failed:", e.message ?? e); process.exit(1); });
