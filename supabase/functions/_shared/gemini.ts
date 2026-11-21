// Minimal Gemini REST client (works in Deno and Node 18+; uses fetch only).
// Docs: https://ai.google.dev/api/generate-content and https://ai.google.dev/api/embeddings

const BASE = "https://generativelanguage.googleapis.com/v1beta";

export interface GeminiConfig {
  apiKey: string;
  chatModel: string; // e.g. gemini-flash-latest
  embedModel: string; // gemini-embedding-001
  embedDims: number; // 768
  temperature?: number;
  thinkingLevel?: string; // Gemini 3+: "minimal" | "low" | "medium" | "high" (GEMINI_THINKING_LEVEL)
  thinkingBudget?: number; // Gemini 2.5: tokens, 0 = off (GEMINI_THINKING_BUDGET)
  timeoutMs?: number; // per request (GEMINI_TIMEOUT_MS), default 30000
}

export type Part =
  | { text: string }
  | { functionCall: { name: string; args?: Record<string, unknown> }; thoughtSignature?: string }
  | { functionResponse: { name: string; response: Record<string, unknown> } }
  | Record<string, unknown>;

export interface Content {
  role: "user" | "model";
  parts: Part[];
}

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

export interface GenerateResult {
  content: Content; // the model's turn, as returned (keep it intact for multi-turn tool use)
  text: string;
  functionCalls: { name: string; args: Record<string, unknown> }[];
  inputTokens: number;
  outputTokens: number;
}

async function post(url: string, apiKey: string, body: unknown, attempt = 0, timeoutMs = 30000): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const name = (e as Error).name;
    throw new Error(name === "TimeoutError" || name === "AbortError" ? `Gemini did not answer within ${timeoutMs} ms` : `Gemini request failed: ${(e as Error).message}`);
  }
  if (res.ok) return res.json();
  const detail = await res.text();
  // Retry rate limits and transient server errors with backoff (free tier hits 429 easily).
  if ((res.status === 429 || res.status >= 500) && attempt < 3) {
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt + Math.random() * 300));
    return post(url, apiKey, body, attempt + 1, timeoutMs);
  }
  throw new Error(`Gemini ${res.status}: ${detail.slice(0, 400)}`);
}

export async function generate(
  cfg: GeminiConfig,
  opts: { system: string; contents: Content[]; tools?: FunctionDeclaration[]; allowTools?: boolean; json?: boolean },
): Promise<GenerateResult> {
  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: opts.system }] },
    contents: opts.contents,
    generationConfig: {
      ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
      ...(opts.json ? { responseMimeType: "application/json" } : {}),
      ...(cfg.thinkingLevel ? { thinkingConfig: { thinkingLevel: cfg.thinkingLevel } } : {}),
      ...(cfg.thinkingBudget !== undefined ? { thinkingConfig: { thinkingBudget: cfg.thinkingBudget } } : {}),
    },
  };
  if (opts.tools?.length) {
    body.tools = [{ functionDeclarations: opts.tools }];
    body.toolConfig = { functionCallingConfig: { mode: opts.allowTools === false ? "NONE" : "AUTO" } };
  }
  const data = await post(`${BASE}/models/${cfg.chatModel}:generateContent`, cfg.apiKey, body, 0, cfg.timeoutMs ?? 30000);
  if (!data.candidates?.length) {
    throw new Error(`Gemini returned no answer${data.promptFeedback?.blockReason ? ` (blocked: ${data.promptFeedback.blockReason})` : ""}`);
  }
  const content: Content = data.candidates?.[0]?.content ?? { role: "model", parts: [] };
  if (!content.role) content.role = "model";
  const parts = (content.parts ?? []) as Part[];
  return {
    content,
    text: parts.map((p) => ("text" in p && typeof p.text === "string" && !(p as any).thought ? p.text : "")).join("").trim(),
    functionCalls: parts.flatMap((p) =>
      "functionCall" in p && p.functionCall ? [{ name: (p.functionCall as any).name, args: (p.functionCall as any).args ?? {} }] : []
    ),
    inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: (data.usageMetadata?.candidatesTokenCount ?? 0) + (data.usageMetadata?.thoughtsTokenCount ?? 0),
  };
}

/** Embed texts in batches of 100. taskType: RETRIEVAL_DOCUMENT for chunks, RETRIEVAL_QUERY for questions. */
export async function embed(
  cfg: GeminiConfig,
  texts: string[],
  taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY",
): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 100) {
    const batch = texts.slice(i, i + 100);
    const data = await post(`${BASE}/models/${cfg.embedModel}:batchEmbedContents`, cfg.apiKey, {
      requests: batch.map((text) => ({
        model: `models/${cfg.embedModel}`,
        content: { parts: [{ text }] },
        taskType,
        outputDimensionality: cfg.embedDims,
      })),
    });
    for (const e of data.embeddings ?? []) out.push(normalize(e.values));
  }
  if (out.length !== texts.length) throw new Error(`Expected ${texts.length} embeddings, got ${out.length}`);
  return out;
}

// Embeddings truncated below 3072 dimensions are not unit-length; normalise so
// cosine distance behaves consistently.
function normalize(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

export function configFromEnv(get: (k: string) => string | undefined): GeminiConfig {
  const apiKey = get("GEMINI_API_KEY");
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  const t = get("GEMINI_TEMPERATURE");
  return {
    apiKey,
    chatModel: get("GEMINI_CHAT_MODEL") || "gemini-flash-lite-latest",
    embedModel: get("GEMINI_EMBED_MODEL") || "gemini-embedding-001",
    embedDims: Number(get("EMBED_DIMS") || 768),
    temperature: t ? Number(t) : undefined,
    thinkingLevel: get("GEMINI_THINKING_LEVEL") || undefined,
    thinkingBudget: get("GEMINI_THINKING_BUDGET") ? Number(get("GEMINI_THINKING_BUDGET")) : undefined,
    timeoutMs: Number(get("GEMINI_TIMEOUT_MS") || 30000),
  };
}
