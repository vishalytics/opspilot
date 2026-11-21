// The answer pipeline shared by the web (ask) and Slack (slack) functions.
//
//   question -> input guardrails -> model picks tools (search_documents and/or PO tools)
//            -> tools run AS THE USER (RLS applies) -> model answers with [D1]/[T1] citations
//            -> grounding check -> PII masking -> log tokens, cost, latency, flags
//
// Dependencies are passed in, so tests can run it with a fake model and fake database.

import { checkQuestion, citedLabels, isNoAnswer, maskPii, NO_ANSWER, wrapDocument } from "./guardrails.ts";
import { costInr, type Prices } from "./cost.ts";
import type { Content, FunctionDeclaration, GeminiConfig, GenerateResult } from "./gemini.ts";
import { estimateTokens } from "./chunker.ts";

// The subset of the supabase-js client this module uses.
export interface Db {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: any; error: { message: string } | null }>;
  from(table: string): any;
}

export interface Llm {
  generate(cfg: GeminiConfig, opts: { system: string; contents: Content[]; tools?: FunctionDeclaration[]; allowTools?: boolean }): Promise<GenerateResult>;
  embed(cfg: GeminiConfig, texts: string[], taskType: "RETRIEVAL_QUERY"): Promise<number[][]>;
}

export interface AnswerDeps {
  db: Db; // client authenticated AS THE USER (never the service role)
  llm: Llm;
  cfg: GeminiConfig;
  prices: Prices;
  matchCount?: number;
  semanticWeight?: number;
  fullTextWeight?: number;
  maxToolCalls?: number;
  today?: string;
  /** Stop calling tools after this many ms and force a final answer (Edge Functions have a hard wall clock). */
  budgetMs?: number;
}

export interface Source {
  label: string; // D1, T1...
  type: "document" | "tool";
  title: string;
  heading?: string | null;
  source_file?: string;
  chunk_id?: number;
  content: string;
  flagged?: boolean;
}

export interface AnswerResult {
  answer: string;
  sources: Source[]; // only the cited ones
  route: "docs" | "po_tool" | "both" | "refused" | "error";
  flags: string[];
  log_id: number | null;
  latency_ms: number;
  cost_inr: number;
  tool_calls: { name: string; args: Record<string, unknown> }[];
}

export const TOOLS: FunctionDeclaration[] = [
  {
    name: "search_documents",
    description: "Search procurement policies, SOPs, contracts and vendor correspondence. Use for any question about rules, procedures, approvals, contract terms, penalties, payment terms or vendors' offers.",
    parameters: { type: "object", properties: { query: { type: "string", description: "A focused search query, e.g. 'approval matrix PO value' or 'Kaveri late delivery penalty'." } }, required: ["query"] },
  },
  {
    name: "last_purchase_rate",
    description: "Most recent prices paid for an item on open purchase orders.",
    parameters: { type: "object", properties: { item: { type: "string", description: "Item code (e.g. WPC80, JAR2K) or part of the description (e.g. 'creatine')." } }, required: ["item"] },
  },
  {
    name: "vendor_spend",
    description: "Total PO value with a vendor between two dates (cancelled and superseded POs excluded).",
    parameters: { type: "object", properties: { vendor: { type: "string", description: "Part of the vendor name, e.g. 'Kaveri'." }, from_date: { type: "string", description: "YYYY-MM-DD" }, to_date: { type: "string", description: "YYYY-MM-DD" } }, required: ["vendor"] },
  },
  {
    name: "po_count",
    description: "Number of purchase orders raised between two dates.",
    parameters: { type: "object", properties: { from_date: { type: "string", description: "YYYY-MM-DD" }, to_date: { type: "string", description: "YYYY-MM-DD" } }, required: ["from_date", "to_date"] },
  },
  {
    name: "largest_pos",
    description: "Largest open purchase orders by total value including GST.",
    parameters: { type: "object", properties: { limit: { type: "integer", description: "How many, default 5." } } },
  },
  {
    name: "average_rate",
    description: "Quantity-weighted average rate paid for an item between two dates.",
    parameters: { type: "object", properties: { item: { type: "string" }, from_date: { type: "string", description: "YYYY-MM-DD" }, to_date: { type: "string", description: "YYYY-MM-DD" } }, required: ["item", "from_date", "to_date"] },
  },
  {
    name: "contract_rate_breaches",
    description: "PO lines priced above a valid rate contract for the same vendor and item.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "approval_violations",
    description: "Open POs whose recorded approval level is below what the Procurement Policy approval matrix requires for their value.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "list_ingestion_exceptions",
    description: "PO files that could not be extracted cleanly (missing item table, total mismatch, superseded revision).",
    parameters: { type: "object", properties: {} },
  },
];

const str = (v: unknown, d = "") => (typeof v === "string" && v.trim() ? v.trim() : d);

/** Map a model tool call to a database RPC call. The model never writes SQL. */
function rpcFor(name: string, a: Record<string, unknown>): [string, Record<string, unknown>] | null {
  switch (name) {
    case "last_purchase_rate": return ["last_purchase_rate", { p_item: str(a.item), p_limit: 3 }];
    case "vendor_spend": return ["vendor_spend", { p_vendor: str(a.vendor), p_from: str(a.from_date, "2000-01-01"), p_to: str(a.to_date, "2100-01-01") }];
    case "po_count": return ["po_count", { p_from: str(a.from_date, "2000-01-01"), p_to: str(a.to_date, "2100-01-01") }];
    case "largest_pos": return ["largest_pos", { p_limit: Number(a.limit) || 5 }];
    case "average_rate": return ["average_rate", { p_item: str(a.item), p_from: str(a.from_date, "2000-01-01"), p_to: str(a.to_date, "2100-01-01") }];
    case "contract_rate_breaches": return ["contract_rate_breaches", {}];
    case "approval_violations": return ["approval_violations", {}];
    case "list_ingestion_exceptions": return ["list_ingestion_exceptions", {}];
    default: return null;
  }
}

export async function answerQuestion(
  deps: AnswerDeps,
  input: { question: unknown; userId: string; channel: "web" | "slack" | "eval"; departments: string[]; promptTemplate: string; promptVersion: number },
): Promise<AnswerResult> {
  const started = Date.now();
  const flags: string[] = [];
  const toolCalls: { name: string; args: Record<string, unknown> }[] = [];
  const sources: Source[] = [];
  const chunkLabels = new Map<number, string>();
  const retrievedIds: number[] = [];
  let inputTokens = 0, outputTokens = 0, embedTokens = 0, retrievalMs = 0, llmMs = 0;
  let answer = "", route: AnswerResult["route"] = "refused", error: string | null = null;

  const check = checkQuestion(input.question);
  flags.push(...check.flags);

  if (check.ok) {
    try {
      const system = input.promptTemplate
        .replace("{{today}}", deps.today ?? new Date().toISOString().slice(0, 10))
        .replace("{{departments}}", input.departments.join(", ") || "none");
      const contents: Content[] = [{ role: "user", parts: [{ text: check.question }] }];
      const maxCalls = deps.maxToolCalls ?? 3;

      for (let round = 0; round <= maxCalls; round++) {
        const overBudget = Date.now() - started > (deps.budgetMs ?? 60000);
        if (overBudget) flags.push("time_budget_reached");
        const allowTools = toolCalls.length < maxCalls && !overBudget;
        const t = Date.now();
        const res = await deps.llm.generate(deps.cfg, { system, contents, tools: TOOLS, allowTools });
        llmMs += Date.now() - t;
        inputTokens += res.inputTokens;
        outputTokens += res.outputTokens;
        if (!res.functionCalls.length || !allowTools) { answer = res.text; break; }

        contents.push(res.content);
        const responses = [];
        for (const call of res.functionCalls.slice(0, maxCalls - toolCalls.length)) {
          toolCalls.push(call);
          const t2 = Date.now();
          const result = await runTool(call.name, call.args);
          retrievalMs += Date.now() - t2;
          responses.push({ functionResponse: { name: call.name, response: { result } } });
        }
        contents.push({ role: "user", parts: responses });
      }

      // Grounding: a factual answer must cite at least one source it was given.
      const cited = citedLabels(answer);
      if (!answer || isNoAnswer(answer)) {
        answer = NO_ANSWER;
        flags.push("no_answer");
      } else if (!toolCalls.length || !cited.some((l) => sources.some((s) => s.label === l))) {
        answer = NO_ANSWER;
        flags.push("ungrounded_answer_blocked");
      }
      const used = new Set(toolCalls.map((c) => (c.name === "search_documents" ? "docs" : "po_tool")));
      route = isNoAnswer(answer) ? "refused" : used.size === 2 ? "both" : used.has("docs") ? "docs" : "po_tool";
      if (sources.some((s) => s.flagged)) flags.push("injection_in_context");
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      answer = "Something went wrong while answering. Please try again.";
      route = "error";
      flags.push("error");
    }
  } else {
    answer = check.reason ?? NO_ANSWER;
  }

  // PII masking on the answer and on every source shown to the user.
  const maskedAnswer = maskPii(answer);
  answer = maskedAnswer.text;
  const citedSet = new Set(citedLabels(answer));
  const shown = sources.filter((s) => citedSet.has(s.label)).map((s) => {
    const m = maskPii(s.content);
    m.masked.forEach((x) => maskedAnswer.masked.includes(x) || maskedAnswer.masked.push(x));
    return { ...s, content: m.text };
  });
  if (maskedAnswer.masked.length) flags.push(...maskedAnswer.masked.map((m) => `pii_masked:${m}`));

  const latency = Date.now() - started;
  const cost = costInr(deps.prices, inputTokens, outputTokens, embedTokens);
  const { data: logRow } = await deps.db.from("query_logs").insert({
    user_id: input.userId,
    channel: input.channel,
    question_redacted: maskPii(check.question).text,
    answer_redacted: answer,
    route,
    tool_calls: toolCalls,
    retrieved_chunk_ids: retrievedIds,
    cited_labels: [...citedSet],
    model: deps.cfg.chatModel,
    prompt_version: input.promptVersion,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    embed_tokens: embedTokens,
    cost_inr: cost,
    retrieval_ms: retrievalMs,
    llm_ms: llmMs,
    latency_ms: latency,
    guardrail_flags: [...new Set(flags)],
    error,
  }).select("id").single();

  return { answer, sources: shown, route, flags: [...new Set(flags)], log_id: logRow?.id ?? null, latency_ms: latency, cost_inr: cost, tool_calls: toolCalls };

  // ---- tool execution (closure over the request state above) ----
  async function runTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name === "search_documents") {
      const query = str(args.query, String(input.question));
      embedTokens += estimateTokens(query);
      const [vec] = await deps.llm.embed(deps.cfg, [query], "RETRIEVAL_QUERY");
      const { data, error } = await deps.db.rpc("hybrid_search", {
        query_text: query,
        query_embedding: vec,
        match_count: deps.matchCount ?? 8,
        full_text_weight: deps.fullTextWeight ?? 1,
        semantic_weight: deps.semanticWeight ?? 1,
      });
      if (error) return { error: error.message };
      if (!data?.length) return { documents: "No documents found that this user can access." };
      const docs = (data as any[]).map((row) => {
        let label = chunkLabels.get(row.id);
        if (!label) {
          label = `D${chunkLabels.size + 1}`;
          chunkLabels.set(row.id, label);
          retrievedIds.push(row.id);
          sources.push({ label, type: "document", title: row.title, heading: row.heading, source_file: row.source_file, chunk_id: row.id, content: row.content, flagged: row.flagged_injection });
        }
        return wrapDocument(label, row.title, row.heading, row.content, row.flagged_injection);
      });
      return { documents: docs.join("\n\n") };
    }
    const mapped = rpcFor(name, args);
    if (!mapped) return { error: `Unknown tool ${name}` };
    const { data, error } = await deps.db.rpc(mapped[0], mapped[1]);
    if (error) return { error: error.message };
    const label = `T${sources.filter((s) => s.type === "tool").length + 1}`;
    const rows = (data ?? []) as unknown[];
    sources.push({ label, type: "tool", title: `PO data: ${name}`, heading: JSON.stringify(mapped[1]), content: JSON.stringify(rows, null, 1).slice(0, 4000) });
    return { label, rows, note: rows.length ? undefined : "No rows. Either nothing matches or this user cannot see PO data." };
  }
}
