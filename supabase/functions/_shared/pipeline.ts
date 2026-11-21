// Wires the pure answer pipeline to Supabase and Gemini for a given user client.
import type { SupabaseClient } from "./deps.ts";
import { answerQuestion, type AnswerResult } from "./answer.ts";
import { configFromEnv, embed, generate } from "./gemini.ts";
import { pricesFromEnv } from "./cost.ts";
import { env } from "./http.ts";

/** userClient MUST carry the user's JWT so row-level security applies. */
export async function answerForUser(
  userClient: SupabaseClient,
  userId: string,
  question: unknown,
  channel: "web" | "slack" | "eval",
): Promise<AnswerResult> {
  const [{ data: profile }, { data: prompt }] = await Promise.all([
    userClient.from("profiles").select("role, departments").eq("id", userId).single(),
    userClient.from("prompts").select("template, version").eq("name", "answer").eq("is_active", true).single(),
  ]);
  if (!prompt) throw new Error("No active 'answer' prompt found");
  const departments = profile?.role === "admin" ? ["procurement", "finance", "warehouse"] : (profile?.departments ?? []);
  return answerQuestion(
    {
      db: userClient,
      llm: { generate, embed },
      cfg: configFromEnv(env),
      prices: pricesFromEnv(env),
      matchCount: Number(env("MATCH_COUNT") || 8),
      semanticWeight: Number(env("SEMANTIC_WEIGHT") || 1),
      fullTextWeight: Number(env("FULL_TEXT_WEIGHT") || 1),
      budgetMs: Number(env("ANSWER_BUDGET_MS") || 60000),
    },
    { question, userId, channel, departments, promptTemplate: prompt.template, promptVersion: prompt.version },
  );
}
